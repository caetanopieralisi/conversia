const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    'select * from public.follow_up_rules where client_id = $1 order by wait_hours asc',
    [clientId]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { clientId } = req.user;
  const { name, wait_hours, message, media_url } = req.body || {};
  if (!name || !wait_hours || !message) {
    return res.status(400).json({ error: 'Nome, tempo de espera (horas) e mensagem são obrigatórios' });
  }
  const { rows } = await pool.query(
    `insert into public.follow_up_rules (client_id, name, wait_hours, message, media_url, active)
     values ($1, $2, $3, $4, $5, true) returning *`,
    [clientId, name, wait_hours, message, media_url || null]
  );
  res.json(rows[0]);
});

router.put('/:id', async (req, res) => {
  const { clientId } = req.user;
  const { name, wait_hours, message, media_url, active } = req.body || {};
  await pool.query(
    `update public.follow_up_rules set
       name = coalesce($1, name),
       wait_hours = coalesce($2, wait_hours),
       message = coalesce($3, message),
       media_url = $4,
       active = coalesce($5, active)
     where id = $6 and client_id = $7`,
    [name ?? null, wait_hours ?? null, message ?? null, media_url ?? null, active ?? null, req.params.id, clientId]
  );
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const { clientId } = req.user;
  await pool.query('delete from public.follow_up_rules where id = $1 and client_id = $2', [req.params.id, clientId]);
  res.json({ ok: true });
});

module.exports = router;
