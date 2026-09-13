// =============================================================================
// Recuperação de conhecimento — busca híbrida.
//
// O QUE MUDOU E POR QUÊ
// ---------------------
// Antes (node "Busca Trechos de Conhecimento" do n8n):
//     SELECT json_agg(content, embedding) FROM knowledge_chunks WHERE client_id = X
// Isso trazia TODOS os chunks do cliente — embedding incluso — para dentro do
// Node a cada mensagem recebida. Com 500 chunks são ~1500 floats × 500 = 3 MB de
// JSON por mensagem, e o cosseno rodava em JS em cima de tudo. Cresce linear com
// o tamanho da base: o cliente que mais documenta é o que fica mais lento.
//
// Agora, três caminhos, escolhidos automaticamente:
//   1. pgvector presente  -> KNN no banco (índice HNSW), O(log n)
//   2. sem pgvector       -> full-text do Postgres corta para ~40 candidatos,
//                            e o cosseno roda só neles
//   3. sem embedding      -> full-text puro (ainda funciona, só menos preciso)
//
// Os dois rankings (léxico e semântico) são fundidos com RRF — Reciprocal Rank
// Fusion. Ele resolve o caso em que a pergunta usa o termo exato do documento
// ("NR1", um SKU, um nome de plano): o embedding costuma diluir siglas, o
// full-text acerta em cheio. E vice-versa para perguntas em linguagem natural.
// =============================================================================

const pool = require('../../db');
const llm = require('../llm');

let pgvectorAvailable = null; // cache por processo

async function hasPgvector() {
  if (pgvectorAvailable !== null) return pgvectorAvailable;
  try {
    const { rows } = await pool.query(`
      select exists(select 1 from pg_extension where extname = 'vector')
         and exists(select 1 from information_schema.columns
                     where table_schema='public' and table_name='knowledge_chunks'
                       and column_name='embedding_vec') as ok`);
    pgvectorAvailable = !!rows[0]?.ok;
  } catch {
    pgvectorAvailable = false;
  }
  return pgvectorAvailable;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/** Reciprocal Rank Fusion: soma 1/(k+posição) de cada ranking. k=60 é o padrão da literatura. */
function rrf(rankings, k = 60) {
  const scores = new Map();
  const byId = new Map();
  for (const ranking of rankings) {
    ranking.forEach((item, idx) => {
      const prev = scores.get(item.id) || 0;
      scores.set(item.id, prev + 1 / (k + idx + 1));
      if (!byId.has(item.id)) byId.set(item.id, item);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id), score }));
}

/**
 * Busca os trechos mais relevantes da base de conhecimento do cliente.
 *
 * @param {string} clientId
 * @param {string} query      a pergunta do cliente (já concatenada do buffer)
 * @param {object} [opts]
 * @param {number} [opts.limit=6]        quantos trechos devolver
 * @param {number} [opts.candidates=40]  candidatos do estágio léxico
 * @param {number} [opts.minScore=0]     descarta trechos com similaridade abaixo disso
 * @returns {Promise<{chunks: Array<{id,content,title,score}>, usage: object|null, strategy: string}>}
 */
async function search(clientId, query, opts = {}) {
  const limit = opts.limit ?? 6;
  const candidates = opts.candidates ?? 40;
  const empty = { chunks: [], usage: null, strategy: 'none' };

  if (!query || !query.trim()) return empty;

  // A base tem algo?
  const { rows: cnt } = await pool.query(
    'select count(*)::int as total from public.knowledge_chunks where client_id = $1',
    [clientId]
  );
  if (!cnt[0].total) return empty;

  // --- Estágio 1: léxico (sempre roda — é barato e não depende de API externa)
  let lexical = [];
  try {
    const { rows } = await pool.query(
      'select * from public.search_knowledge_text($1, $2, $3)',
      [clientId, query, candidates]
    );
    lexical = rows.map(r => ({ id: Number(r.id), content: r.content, title: r.title, lexRank: r.rank }));
  } catch (e) {
    // Banco ainda sem a migração v6: segue só com o caminho semântico
    if (!/does not exist|não existe/i.test(String(e.message))) throw e;
  }

  // --- Estágio 2: semântico
  let queryEmbedding = null;
  let usage = null;
  try {
    const res = await llm.embed(query.slice(0, 6000));
    queryEmbedding = res.embeddings[0];
    usage = { ...res.usage, model: res.model, kind: 'embedding' };
  } catch (e) {
    // Sem OpenAI no ar o agente NÃO fica mudo: cai para o full-text.
    console.warn('[rag] embedding falhou, usando só full-text:', e.message);
    if (lexical.length) {
      return {
        chunks: lexical.slice(0, limit).map(c => ({ ...c, score: c.lexRank })),
        usage: null,
        strategy: 'lexical-only'
      };
    }
    return empty;
  }

  let semantic = [];
  let strategy;

  if (await hasPgvector()) {
    strategy = 'pgvector+lexical';
    const { rows } = await pool.query(
      `select id, content, title, 1 - (embedding_vec <=> $2::vector) as sim
         from public.knowledge_chunks
        where client_id = $1 and embedding_vec is not null
        order by embedding_vec <=> $2::vector
        limit $3`,
      [clientId, JSON.stringify(queryEmbedding), candidates]
    );
    semantic = rows.map(r => ({ id: Number(r.id), content: r.content, title: r.title, sim: Number(r.sim) }));
  } else {
    strategy = 'lexical-rerank';
    // Sem pgvector: reranqueia semanticamente os candidatos do full-text e
    // completa com outros trechos, para que uma pergunta que não casa nenhum
    // termo ainda tenha o que comparar. Os candidatos léxicos vêm primeiro.
    const ids = lexical.map(c => c.id);
    const { rows } = await pool.query(
      `select id, content, title, embedding
         from public.knowledge_chunks
        where client_id = $1
        order by (id = any($2::bigint[])) desc, id desc
        limit $3`,
      [clientId, ids, Math.max(candidates, ids.length)]
    );
    semantic = rows
      .map(r => {
        const emb = Array.isArray(r.embedding) ? r.embedding : null;
        if (!emb || emb.length === 0) return null;
        return { id: Number(r.id), content: r.content, title: r.title, sim: cosine(queryEmbedding, emb) };
      })
      .filter(Boolean)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, candidates);
  }

  // --- Fusão
  const fused = rrf([
    semantic.map(c => ({ id: c.id, content: c.content, title: c.title, sim: c.sim })),
    lexical.map(c => ({ id: c.id, content: c.content, title: c.title, lexRank: c.lexRank }))
  ].filter(r => r.length));

  // Corte por similaridade absoluta: melhor não trazer nada do que trazer lixo,
  // porque trecho irrelevante no prompt é a principal fonte de resposta inventada.
  const simById = new Map(semantic.map(c => [c.id, c.sim]));
  const minScore = opts.minScore ?? Number(process.env.RAG_MIN_SIMILARITY || 0.18);
  const filtered = fused.filter(c => {
    const sim = simById.get(c.id);
    return sim === undefined ? true : sim >= minScore;
  });

  return { chunks: filtered.slice(0, limit), usage, strategy };
}

/** Formata os trechos para entrar no prompt de sistema. */
function formatContext(chunks) {
  if (!chunks?.length) return '';
  return chunks
    .map((c, i) => `[${i + 1}]${c.title ? ` (${c.title})` : ''} ${c.content.trim()}`)
    .join('\n\n');
}

module.exports = { search, formatContext, cosine, rrf, hasPgvector };
