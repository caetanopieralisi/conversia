// Biblioteca de arquivos do agente.
//
// A `description` é o campo mais importante da tela: é literalmente o que o
// modelo lê para decidir quando mandar o arquivo. "Catálogo" não ajuda;
// "quando o cliente pedir para ver os produtos ou perguntar o que temos" ajuda.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const KINDS = ['document', 'image', 'video', 'audio'];

router.get('/', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select * from public.assets where client_id = $1 order by active desc, send_count desc, id',
    [req.user.clientId]
  );
  res.json(rows);
}));

router.post('/', asyncH(async (req, res) => {
  const { name, description, url, mime_type, kind, file_name, keywords } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'Nome e arquivo são obrigatórios' });
  if (!description || description.trim().length < 10) {
    return res.status(400).json({
      error: 'Descreva quando o agente deve enviar este arquivo (mínimo 10 caracteres). ' +
             'É por essa descrição que ele decide a hora certa — ex: "quando o cliente pedir para ver os produtos".'
    });
  }
  if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `Tipo deve ser um de: ${KINDS.join(', ')}` });

  const { rows } = await pool.query(
    `insert into public.assets (client_id, name, description, url, mime_type, kind, file_name, keywords)
     values ($1,$2,$3,$4,$5, coalesce($6,'document'),$7,$8) returning *`,
    [req.user.clientId, name.trim(), description.trim(), url, mime_type || null, kind || null,
     file_name || name, keywords || null]
  );
  res.json(rows[0]);
}));

router.put('/:id', asyncH(async (req, res) => {
  const { name, description, url, kind, file_name, keywords, active } = req.body || {};
  const { rows } = await pool.query(
    `update public.assets set
       name = coalesce($1, name), description = coalesce($2, description),
       url = coalesce($3, url), kind = coalesce($4, kind),
       file_name = coalesce($5, file_name), keywords = coalesce($6, keywords),
       active = coalesce($7, active)
     where id = $8 and client_id = $9 returning *`,
    [name ?? null, description ?? null, url ?? null, kind ?? null, file_name ?? null,
     keywords ?? null, active ?? null, req.params.id, req.user.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.json(rows[0]);
}));

router.delete('/:id', asyncH(async (req, res) => {
  await pool.query('delete from public.assets where id = $1 and client_id = $2',
    [req.params.id, req.user.clientId]);
  res.json({ ok: true });
}));

/** Envia o arquivo manualmente para um número (teste, ou uso do atendente). */
router.post('/:id/send', asyncH(async (req, res) => {
  const { phone, caption } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Informe o telefone de destino' });

  const [assetRes, clientRes] = await Promise.all([
    pool.query('select * from public.assets where id = $1 and client_id = $2', [req.params.id, req.user.clientId]),
    pool.query('select * from public.clients where client_id = $1', [req.user.clientId])
  ]);
  if (!assetRes.rows[0]) return res.status(404).json({ error: 'Arquivo não encontrado' });

  const orchestrator = require('../lib/agent/orchestrator');
  const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
  await orchestrator.sendAsset(clientRes.rows[0], jid, assetRes.rows[0], caption || '');
  res.json({ ok: true });
}));

module.exports = router;
