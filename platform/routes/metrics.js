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

// Receita, meta e comparativo com o mês anterior
router.get('/revenue', async (req, res) => {
  const { clientId } = req.user;

  const clientRes = await pool.query('select monthly_goal from public.clients where client_id = $1', [clientId]);
  const meta = Number(clientRes.rows[0]?.monthly_goal || 0);

  const vendas = await pool.query(
    `select
       coalesce(sum(sale_value) filter (where sold_at >= date_trunc('month', now())), 0) as receita_mes,
       coalesce(sum(sale_value) filter (where sold_at >= date_trunc('month', now() - interval '1 month') and sold_at < date_trunc('month', now())), 0) as receita_mes_anterior,
       count(*) filter (where sold_at >= date_trunc('month', now())) as vendas_mes,
       count(*) filter (where sold_at >= date_trunc('month', now() - interval '1 month') and sold_at < date_trunc('month', now())) as vendas_mes_anterior
     from public.leads where client_id = $1 and status = 'vendido'`,
    [clientId]
  );
  const v = vendas.rows[0];
  const receitaMes = Number(v.receita_mes);
  const ticketMedio = v.vendas_mes > 0 ? receitaMes / v.vendas_mes : 0;

  const totalLeadsMes = await pool.query(
    `select count(*)::int as total from public.leads where client_id = $1 and created_at >= date_trunc('month', now())`,
    [clientId]
  ).catch(() => ({ rows: [{ total: null }] }));

  const taxaConversao = totalLeadsMes.rows[0].total
    ? Math.round((Number(v.vendas_mes) / totalLeadsMes.rows[0].total) * 100)
    : null;

  res.json({
    receita_mes: receitaMes,
    receita_mes_anterior: Number(v.receita_mes_anterior),
    vendas_mes: Number(v.vendas_mes),
    vendas_mes_anterior: Number(v.vendas_mes_anterior),
    ticket_medio: ticketMedio,
    meta_mensal: meta,
    progresso_meta_pct: meta > 0 ? Math.min(100, Math.round((receitaMes / meta) * 100)) : null,
    taxa_conversao_pct: taxaConversao
  });
});

module.exports = router;
