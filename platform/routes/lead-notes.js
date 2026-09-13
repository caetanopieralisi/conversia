const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/:phone', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    'select * from public.lead_notes where client_id = $1 and phone = $2 order by created_at desc',
    [clientId, req.params.phone]
  );
  res.json(rows);
});

router.post('/:phone', async (req, res) => {
  const { clientId, email } = req.user;
  const { note } = req.body || {};
  if (!note) return res.status(400).json({ error: 'Nota vazia' });
  const { rows } = await pool.query(
    'insert into public.lead_notes (client_id, phone, author, note) values ($1, $2, $3, $4) returning *',
    [clientId, req.params.phone, email || null, note]
  );
  res.json(rows[0]);
});

router.delete('/:id', async (req, res) => {
  const { clientId } = req.user;
  await pool.query('delete from public.lead_notes where id = $1 and client_id = $2', [req.params.id, clientId]);
  res.json({ ok: true });
});

module.exports = router;
