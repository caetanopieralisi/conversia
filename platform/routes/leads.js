const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Lista de leads, com filtro opcional de status e busca por nome/telefone
router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { status, q } = req.query;

  const conditions = ['client_id = $1'];
  const params = [clientId];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ilike $${params.length} or phone ilike $${params.length})`);
  }

  const { rows } = await pool.query(
    `select * from public.leads where ${conditions.join(' and ')} order by last_inbound_at desc nulls last`,
    params
  );
  res.json(rows);
});

// Atualizar status de um lead
router.patch('/:phone/status', async (req, res) => {
  const { clientId } = req.user;
  const { phone } = req.params;
  const { status } = req.body || {};
  const allowed = ['ativo', 'aguardando_humano', 'fechado'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido' });

  await pool.query(
    'update public.leads set status = $1 where client_id = $2 and phone = $3',
    [status, clientId, phone]
  );
  res.json({ ok: true });
});

// Exporta leads em CSV
router.get('/export.csv', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query('select * from public.leads where client_id = $1 order by last_inbound_at desc nulls last', [clientId]);
  const cols = ['name', 'phone', 'email', 'status', 'urgent', 'last_inbound_at'];
  const csv = [cols.join(',')]
    .concat(rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(csv);
});

module.exports = router;
