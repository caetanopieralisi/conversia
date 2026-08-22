const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { clientId } = req.user;

  const totalLeads = await pool.query(
    `select count(*)::int as total from public.leads where client_id = $1 and created_at > now() - interval '30 days'`,
    [clientId]
  ).catch(() => ({ rows: [{ total: null }] })); // created_at pode não existir se a tabela leads não tiver a coluna

  const porStatus = await pool.query(
    `select status, count(*)::int as total from public.leads where client_id = $1 group by status`,
    [clientId]
  );

  const tempoMedioResposta = await pool.query(
    `with pares as (
       select m.phone, m.created_at as inbound_at,
         (select min(m2.created_at) from public.messages m2
          where m2.client_id = $1 and m2.phone = m.phone and m2.direction = 'outbound' and m2.created_at > m.created_at) as outbound_at
       from public.messages m
       where m.client_id = $1 and m.direction = 'inbound'
     )
     select avg(extract(epoch from (outbound_at - inbound_at)))::int as segundos
     from pares where outbound_at is not null`,
    [clientId]
  );

  res.json({
    leads_30_dias: totalLeads.rows[0].total,
    leads_por_status: porStatus.rows,
    tempo_medio_primeira_resposta_segundos: tempoMedioResposta.rows[0]?.segundos ?? null
  });
});

module.exports = router;
