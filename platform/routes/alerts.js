const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    'select * from public.agent_alerts where client_id = $1 order by created_at desc limit 50',
    [clientId]
  );
  res.json(rows);
});

router.patch('/:id/resolve', async (req, res) => {
  const { clientId } = req.user;
  await pool.query(
    'update public.agent_alerts set resolved = true where id = $1 and client_id = $2',
    [req.params.id, clientId]
  );
  res.json({ ok: true });
});

module.exports = router;
