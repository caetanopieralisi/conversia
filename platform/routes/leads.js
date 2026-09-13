const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Heurística simples de score: urgente ou respondeu há pouco = quente
const SCORE_SQL = `
  case
    when l.urgent then 'quente'
    when l.last_inbound_at > now() - interval '2 hours' then 'quente'
    when l.last_inbound_at > now() - interval '24 hours' then 'morno'
    else 'frio'
  end`;

// Lista de leads, com filtro opcional de status e busca por nome/telefone
router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { status, q } = req.query;

  const conditions = ['l.client_id = $1'];
  const params = [clientId];

  if (status) {
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(l.name ilike $${params.length} or l.phone ilike $${params.length})`);
  }

  const { rows } = await pool.query(
    `select l.*, ${SCORE_SQL} as score
     from public.leads l
     where ${conditions.join(' and ')}
     order by l.last_inbound_at desc nulls last`,
    params
  );
  res.json(rows);
});

// Radar: leads "ativos" que a gente mandou mensagem e o cliente não respondeu (esfriando)
router.get('/radar', async (req, res) => {
  const { clientId } = req.user;
  const clientRes = await pool.query('select radar_hours from public.clients where client_id = $1', [clientId]);
  const radarHours = clientRes.rows[0]?.radar_hours || 24;

  const { rows } = await pool.query(
    `select l.*, ${SCORE_SQL} as score,
            m.created_at as last_message_at,
            extract(epoch from (now() - m.created_at)) / 3600 as hours_silent
     from public.leads l
     join lateral (
       select direction, created_at from public.messages msg
       where msg.client_id = l.client_id and msg.phone = l.phone
       order by created_at desc limit 1
     ) m on true
     where l.client_id = $1
       and l.status = 'ativo'
       and m.direction = 'outbound'
       and m.created_at < now() - ($2 || ' hours')::interval
     order by m.created_at asc`,
    [clientId, radarHours]
  );
  res.json({ radar_hours: radarHours, leads: rows });
});

// Atualizar status de um lead (inclui "vendido", com valor da venda)
router.patch('/:phone/status', async (req, res) => {
  const { clientId } = req.user;
  const { phone } = req.params;
  const { status, sale_value } = req.body || {};
  const allowed = ['ativo', 'aguardando_humano', 'fechado', 'vendido'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Status inválido' });

  if (status === 'vendido') {
    await pool.query(
      'update public.leads set status = $1, sale_value = $2, sold_at = now() where client_id = $3 and phone = $4',
      [status, sale_value || null, clientId, phone]
    );
  } else {
    await pool.query(
      'update public.leads set status = $1 where client_id = $2 and phone = $3',
      [status, clientId, phone]
    );
  }
  res.json({ ok: true });
});

// Exporta leads em CSV
router.get('/export.csv', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    `select l.*, ${SCORE_SQL} as score from public.leads l where l.client_id = $1 order by l.last_inbound_at desc nulls last`,
    [clientId]
  );
  const cols = ['name', 'phone', 'email', 'status', 'score', 'urgent', 'sale_value', 'sold_at', 'last_inbound_at'];
  const csv = [cols.join(',')]
    .concat(rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(csv);
});

module.exports = router;
