const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    'select * from public.quick_replies where client_id = $1 order by created_at desc',
    [clientId]
  );
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { clientId } = req.user;
  const { title, content } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'Título e conteúdo são obrigatórios' });
  const { rows } = await pool.query(
    'insert into public.quick_replies (client_id, title, content) values ($1, $2, $3) returning *',
    [clientId, title, content]
  );
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { clientId } = req.user;
  await pool.query('delete from public.quick_replies where id = $1 and client_id = $2', [req.params.id, clientId]);
  res.json({ ok: true });
});

module.exports = router;
