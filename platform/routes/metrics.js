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

// Série diária (últimos N dias) de receita e novos leads — pros gráficos de linha
router.get('/timeseries', async (req, res) => {
  const { clientId } = req.user;
  const days = Math.min(180, Math.max(7, parseInt(req.query.days) || 30));

  const [revRows, leadRows] = await Promise.all([
    pool.query(
      `select sold_at::date as dia, sum(sale_value)::float as receita
       from public.leads
       where client_id = $1 and status = 'vendido' and sold_at >= current_date - $2::int
       group by 1`,
      [clientId, days]
    ),
    pool.query(
      `select created_at::date as dia, count(*)::int as total
       from public.leads
       where client_id = $1 and created_at >= current_date - $2::int
       group by 1`,
      [clientId, days]
    )
  ]);
  const revMap = Object.fromEntries(revRows.rows.map(r => [r.dia.toISOString().slice(0, 10), r.receita]));
  const leadMap = Object.fromEntries(leadRows.rows.map(r => [r.dia.toISOString().slice(0, 10), r.total]));

  const labels = [];
  const receita = [];
  const leads = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(key.slice(5));
    receita.push(revMap[key] || 0);
    leads.push(leadMap[key] || 0);
  }
  res.json({ labels, receita, leads });
});

// Comparativo lado a lado: semana atual x semana passada, mês atual x mês passado
router.get('/compare', async (req, res) => {
  const { clientId } = req.user;

  async function porDia(campo, dataInicioA, dataFimA, dataInicioB, dataFimB, extractExpr) {
    const [a, b] = await Promise.all([
      pool.query(
        `select ${extractExpr} as idx, count(*)::int as leads, coalesce(sum(sale_value) filter (where status = 'vendido'), 0)::float as receita
         from public.leads where client_id = $1 and created_at >= $2 and created_at < $3 group by 1`,
        [clientId, dataInicioA, dataFimA]
      ),
      pool.query(
        `select ${extractExpr} as idx, count(*)::int as leads, coalesce(sum(sale_value) filter (where status = 'vendido'), 0)::float as receita
         from public.leads where client_id = $1 and created_at >= $2 and created_at < $3 group by 1`,
        [clientId, dataInicioB, dataFimB]
      )
    ]);
    return { atual: a.rows, anterior: b.rows };
  }

  const now = new Date();
  const dow = now.getDay(); // 0=domingo
  const startThisWeek = new Date(now); startThisWeek.setDate(now.getDate() - dow); startThisWeek.setHours(0, 0, 0, 0);
  const startLastWeek = new Date(startThisWeek); startLastWeek.setDate(startThisWeek.getDate() - 7);

  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const semana = await porDia(null, startThisWeek, new Date(startThisWeek.getTime() + 7 * 86400000), startLastWeek, startThisWeek, `extract(dow from created_at)::int`);
  const mes = await porDia(null, startThisMonth, new Date(now.getFullYear(), now.getMonth() + 1, 1), startLastMonth, startThisMonth, `extract(day from created_at)::int`);

  function toArray(rows, size) {
    const arr = new Array(size).fill(0);
    rows.forEach(r => { if (r.idx >= 0 && r.idx < size) arr[r.idx] = r.leads; });
    return arr;
  }
  function toArrayReceita(rows, size) {
    const arr = new Array(size).fill(0);
    rows.forEach(r => { if (r.idx >= 0 && r.idx < size) arr[r.idx] = r.receita; });
    return arr;
  }

  res.json({
    semana: {
      labels: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
      leads_atual: toArray(semana.atual, 7),
      leads_anterior: toArray(semana.anterior, 7),
      receita_atual: toArrayReceita(semana.atual, 7),
      receita_anterior: toArrayReceita(semana.anterior, 7)
    },
    mes: {
      labels: Array.from({ length: 31 }, (_, i) => String(i + 1)),
      leads_atual: toArray(mes.atual, 31),
      leads_anterior: toArray(mes.anterior, 31),
      receita_atual: toArrayReceita(mes.atual, 31),
      receita_anterior: toArrayReceita(mes.anterior, 31)
    }
  });
});

// Heatmap: em que dia da semana / hora mais chegam leads e mais se vende
router.get('/heatmap', async (req, res) => {
  const { clientId } = req.user;
  const [leadsHeat, vendasHeat] = await Promise.all([
    pool.query(
      `select extract(dow from created_at)::int as dow, extract(hour from created_at)::int as hora, count(*)::int as total
       from public.messages where client_id = $1 and direction = 'inbound' and created_at >= now() - interval '90 days'
       group by 1, 2`,
      [clientId]
    ),
    pool.query(
      `select extract(dow from sold_at)::int as dow, extract(hour from sold_at)::int as hora, count(*)::int as total
       from public.leads where client_id = $1 and status = 'vendido' and sold_at is not null
       group by 1, 2`,
      [clientId]
    )
  ]);
  res.json({ leads: leadsHeat.rows, vendas: vendasHeat.rows });
});

module.exports = router;
