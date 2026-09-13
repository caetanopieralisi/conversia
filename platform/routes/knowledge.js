// =============================================================================
// Base de conhecimento — ingestão de documentos.
//
// É a peça que decide se o agente responde com fato ou inventa. Duas melhorias
// sobre a versão anterior:
//
// 1. CHUNKING QUE RESPEITA A ESTRUTURA. Antes, o texto era achatado com
//    replace(/\s+/g,' ') e fatiado a cada 700 caracteres. Isso corta no meio de
//    uma frase e mistura o fim de uma seção com o começo de outra — e o trecho
//    recuperado chega ao modelo pela metade. Agora a quebra é por parágrafo,
//    com o título da seção preservado em cada pedaço.
//
// 2. GRAVA TAMBÉM NA COLUNA VETORIAL quando pgvector está disponível. Sem isso,
//    a busca rápida não encontrava nada dos documentos novos.
// =============================================================================

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const llm = require('../lib/llm');
const rag = require('../lib/agent/rag');

const router = express.Router();
router.use(requireAuth);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_CHARS = 900;

// Mínimo baixo de propósito. Com um corte em 40 caracteres, uma linha como
// "O plano Essencial custa R$ 497 por mês." (39) é descartada — justamente o
// fato mais caro de se perder. O que precisa ser filtrado aqui é ruído de
// rodapé ("Página 3 de 10"), não conteúdo curto.
const MIN_CHARS = 20;
const MIN_CHARS_COM_TITULO = 10;   // sob uma seção, até um valor solto tem sentido

function aproveitavel(texto, titulo) {
  const t = texto.trim();
  if (t.length < (titulo ? MIN_CHARS_COM_TITULO : MIN_CHARS)) return false;
  if (/^p[áa]gina\s+\d+(\s+de\s+\d+)?$/i.test(t)) return false;  // rodapé de PDF
  if (/^\d+$/.test(t)) return false;                              // número de página
  return true;
}

/**
 * Quebra o texto preservando parágrafos e títulos.
 * Cada pedaço leva o título da seção a que pertence — assim "custa R$ 497"
 * continua sabendo que estava sob "Planos e preços".
 */
function chunkText(texto) {
  const linhas = String(texto).replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let tituloAtual = null;
  let buffer = '';

  const ehTitulo = l => {
    const t = l.trim();
    if (!t || t.length > 90) return false;
    return /^#{1,6}\s/.test(t) ||                       // markdown
           /^\d+(\.\d+)*[.)]\s+\S/.test(t) ||           // "1.2. Seção"
           (t === t.toUpperCase() && /[A-ZÀ-Ú]/.test(t) && t.length > 3 && !t.endsWith('.')) ||
           /^[-=–—]{3,}$/.test(t) === false && /:$/.test(t) && t.split(' ').length <= 8;
  };

  const flush = () => {
    const t = buffer.trim();
    if (aproveitavel(t, tituloAtual)) chunks.push({ content: t, title: tituloAtual });
    buffer = '';
  };

  for (const linha of linhas) {
    if (ehTitulo(linha)) {
      flush();
      tituloAtual = linha.replace(/^#{1,6}\s*/, '').trim();
      continue;
    }
    if (!linha.trim()) {           // parágrafo terminou
      if (buffer.length >= MAX_CHARS * 0.6) flush();
      else buffer += '\n';
      continue;
    }
    if ((buffer + linha).length > MAX_CHARS) {
      flush();
      // sobreposição: leva a última frase para o pedaço seguinte, para não
      // perder o contexto exatamente na fronteira
      const anterior = chunks[chunks.length - 1]?.content || '';
      const ultimaFrase = (anterior.match(/[^.!?]+[.!?]\s*$/) || [''])[0].trim();
      buffer = ultimaFrase && ultimaFrase.length < 200 ? ultimaFrase + ' ' : '';
    }
    buffer += linha.trim() + ' ';
  }
  flush();

  // Um documento sem nenhuma quebra (PDF exportado como parede de texto):
  // cai no fatiamento simples, senão viraria um chunk gigante.
  if (chunks.length <= 1 && texto.length > MAX_CHARS * 1.5) {
    const limpo = texto.replace(/\s+/g, ' ').trim();
    chunks.length = 0;
    for (let i = 0; i < limpo.length; i += MAX_CHARS - 150) {
      const pedaco = limpo.slice(i, i + MAX_CHARS).trim();
      if (aproveitavel(pedaco, null)) chunks.push({ content: pedaco, title: null });
    }
  }

  return chunks;
}

async function extrairTexto({ buffer, contentType, filename }) {
  const nome = String(filename || '').toLowerCase();

  if (contentType === 'application/pdf' || nome.endsWith('.pdf')) {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }
  if (nome.endsWith('.docx')) {
    // .docx é um zip com XML dentro; extrai o texto sem dependência extra
    try {
      const { execFileSync } = require('child_process');
      const os = require('os'), fs = require('fs'), path = require('path');
      const tmp = path.join(os.tmpdir(), `kb-${Date.now()}.docx`);
      fs.writeFileSync(tmp, buffer);
      const xml = execFileSync('unzip', ['-p', tmp, 'word/document.xml'], { maxBuffer: 50e6 }).toString();
      fs.unlinkSync(tmp);
      return xml
        .replace(/<w:p[ >]/g, '\n<w:p ')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    } catch {
      throw new Error('Não consegui ler este .docx. Salve como PDF ou TXT e envie de novo.');
    }
  }
  return buffer.toString('utf-8');
}

// -----------------------------------------------------------------------------

router.get('/', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `select s.*, (select count(*)::int from public.knowledge_chunks c where c.source_id = s.id) as total_chunks
       from public.knowledge_sources s where s.client_id = $1 order by s.created_at desc`,
    [req.user.clientId]
  );
  res.json(rows);
}));

/** Recebe arquivo (base64), URL ou texto colado. */
router.post('/', asyncH(async (req, res) => {
  const { clientId } = req.user;
  const { filename, dataBase64, contentType, url, texto, titulo } = req.body || {};

  if (!dataBase64 && !url && !texto) {
    return res.status(400).json({ error: 'Envie um arquivo, uma URL ou cole o texto' });
  }

  const nome = filename || titulo || url || 'texto colado';
  const tipo = dataBase64 ? 'file' : url ? 'url' : 'text';

  const sourceRes = await pool.query(
    `insert into public.knowledge_sources (client_id, filename, status, source_type, source_url)
     values ($1,$2,'processando',$3,$4) returning id`,
    [clientId, nome, tipo, url || null]
  );
  const sourceId = sourceRes.rows[0].id;

  try {
    let conteudo;

    if (dataBase64) {
      conteudo = await extrairTexto({
        buffer: Buffer.from(dataBase64, 'base64'), contentType, filename
      });
    } else if (url) {
      if (!/^https?:\/\//.test(url)) throw new Error('URL inválida');
      const resp = await fetch(url, { headers: { 'User-Agent': 'ConversIA/6.0' }, signal: AbortSignal.timeout(20000) });
      if (!resp.ok) throw new Error(`Não consegui acessar a URL (HTTP ${resp.status})`);
      const html = await resp.text();
      conteudo = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ');
    } else {
      conteudo = texto;
    }

    if (!conteudo || conteudo.trim().length < MIN_CHARS) {
      throw new Error('Não consegui extrair texto. Se o PDF for digitalizado (imagem), passe por OCR antes.');
    }

    const chunks = chunkText(conteudo);
    if (!chunks.length) throw new Error('Arquivo sem conteúdo aproveitável');

    const temVetor = await rag.hasPgvector();
    const LOTE = 50;
    let usoTotal = 0;

    for (let i = 0; i < chunks.length; i += LOTE) {
      const lote = chunks.slice(i, i + LOTE);
      const { embeddings, usage } = await llm.embed(lote.map(c => c.content));
      usoTotal += usage.tokensIn || 0;

      const valores = [];
      const params = [];
      lote.forEach((c, idx) => {
        const b = params.length;
        params.push(clientId, sourceId, c.content, c.title, i + idx, JSON.stringify(embeddings[idx]));
        valores.push(
          temVetor
            ? `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb,$${b + 6}::vector)`
            : `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6}::jsonb)`
        );
      });

      await pool.query(
        `insert into public.knowledge_chunks
           (client_id, source_id, content, title, position, embedding${temVetor ? ', embedding_vec' : ''})
         values ${valores.join(',')}`,
        params
      );
    }

    await pool.query(
      `update public.knowledge_sources set status='pronto', char_count=$2, updated_at=now() where id=$1`,
      [sourceId, conteudo.length]
    );
    await pool.query(
      `insert into public.usage_log (client_id, tokens_in, tokens_out, model, kind)
       values ($1,$2,0,'text-embedding-3-small','embedding')`,
      [clientId, usoTotal]
    ).catch(() => {});

    res.json({ ok: true, source_id: sourceId, chunks: chunks.length, caracteres: conteudo.length });
  } catch (e) {
    await pool.query(
      `update public.knowledge_sources set status='erro', error_message=$2, updated_at=now() where id=$1`,
      [sourceId, String(e.message || e).slice(0, 500)]
    );
    res.status(500).json({ error: 'Falha ao processar', detail: String(e.message || e) });
  }
}));

/** Reprocessa uma fonte (ex: depois de ativar pgvector, ou trocar de modelo). */
router.post('/:id/reprocess', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select content, title, position from public.knowledge_chunks where source_id = $1 and client_id = $2 order by position',
    [req.params.id, req.user.clientId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Nenhum trecho encontrado para reprocessar' });

  const temVetor = await rag.hasPgvector();
  if (!temVetor) return res.json({ ok: true, aviso: 'pgvector não está ativo — nada a reprocessar' });

  let atualizados = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const lote = rows.slice(i, i + 50);
    const { embeddings } = await llm.embed(lote.map(c => c.content));
    for (let j = 0; j < lote.length; j++) {
      await pool.query(
        `update public.knowledge_chunks set embedding = $3::jsonb, embedding_vec = $3::vector
          where source_id = $1 and position = $2`,
        [req.params.id, lote[j].position, JSON.stringify(embeddings[j])]
      );
      atualizados++;
    }
  }
  res.json({ ok: true, trechos_reprocessados: atualizados });
}));

router.delete('/:id', asyncH(async (req, res) => {
  await pool.query('delete from public.knowledge_sources where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  res.json({ ok: true });
}));

module.exports = router;
module.exports.chunkText = chunkText;
