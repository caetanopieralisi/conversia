const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function chunkText(text, size = 700, overlap = 100) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return chunks.filter(c => c.trim().length > 30);
}

async function embedBatch(texts) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada');
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || 'Erro ao gerar embeddings');
  return data.data.map(d => d.embedding);
}

router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    `select s.*, (select count(*)::int from public.knowledge_chunks c where c.source_id = s.id) as total_chunks
     from public.knowledge_sources s where s.client_id = $1 order by s.created_at desc`,
    [clientId]
  );
  res.json(rows);
});

// Recebe um arquivo (PDF ou texto) em base64, extrai texto, gera embeddings e salva
router.post('/', async (req, res) => {
  const { clientId } = req.user;
  const { filename, dataBase64, contentType } = req.body || {};
  if (!filename || !dataBase64) return res.status(400).json({ error: 'Arquivo é obrigatório' });

  const sourceRes = await pool.query(
    `insert into public.knowledge_sources (client_id, filename, status) values ($1, $2, 'processando') returning id`,
    [clientId, filename]
  );
  const sourceId = sourceRes.rows[0].id;

  try {
    const buffer = Buffer.from(dataBase64, 'base64');
    let text;
    if (contentType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf')) {
      const pdfParse = require('pdf-parse');
      const parsed = await pdfParse(buffer);
      text = parsed.text;
    } else {
      text = buffer.toString('utf-8');
    }
    if (!text || text.trim().length < 30) throw new Error('Não foi possível extrair texto do arquivo');

    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error('Arquivo sem conteúdo aproveitável');

    const BATCH = 50;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const embeddings = await embedBatch(batch);
      const values = [];
      const params = [];
      batch.forEach((content, idx) => {
        const base = params.length;
        params.push(clientId, sourceId, content, JSON.stringify(embeddings[idx]));
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb)`);
      });
      await pool.query(
        `insert into public.knowledge_chunks (client_id, source_id, content, embedding) values ${values.join(',')}`,
        params
      );
    }

    await pool.query(`update public.knowledge_sources set status = 'pronto' where id = $1`, [sourceId]);
    res.json({ ok: true, source_id: sourceId, chunks: chunks.length });
  } catch (e) {
    await pool.query(
      `update public.knowledge_sources set status = 'erro', error_message = $2 where id = $1`,
      [sourceId, String(e.message || e)]
    );
    res.status(500).json({ error: 'Falha ao processar arquivo', detail: String(e.message || e) });
  }
});

router.delete('/:id', async (req, res) => {
  const { clientId } = req.user;
  await pool.query('delete from public.knowledge_sources where id = $1 and client_id = $2', [req.params.id, clientId]);
  res.json({ ok: true });
});

module.exports = router;
