const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { requireAdmin } = require('../auth');

const router = express.Router();

// Credenciais do admin da plataforma (dono da ConversIA). Pode ser sobrescrito via .env.
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
// Hash de "caenina1322" — gerado com bcrypt, salt 10.
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH ||
  '$2a$10$1U7AGqI49zcLzcqoxbRzyOn/5a/XMhhU/1eZ9tjdUOiiUMxFh0TFC';

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });
  if (username !== ADMIN_USER) return res.status(401).json({ error: 'Credenciais inválidas' });

  const ok = await bcrypt.compare(password, ADMIN_PASS_HASH);
  if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

  const token = jwt.sign({ role: 'admin', username }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

router.use(requireAdmin);

// Templates de prompt prontos por nicho (agiliza o onboarding de cliente novo)
const PROMPT_TEMPLATES = [
  { nicho: 'Restaurante / Delivery', nome: 'Restaurante', prompt: 'Você é o atendente virtual de um restaurante. Seja simpático e ágil. Ajude o cliente a ver o cardápio, tirar dúvidas sobre pratos, horário de funcionamento e fechar o pedido. Sempre confirme endereço de entrega e forma de pagamento antes de finalizar.' },
  { nicho: 'Clínica / Consultório', nome: 'Clínica', prompt: 'Você é o atendente virtual de uma clínica. Seja acolhedor e profissional. Ajude a agendar consultas, tirar dúvidas sobre especialidades e convênios. Nunca dê diagnósticos ou conselhos médicos — direcione questões clínicas para um profissional.' },
  { nicho: 'Loja / E-commerce', nome: 'Loja', prompt: 'Você é o atendente virtual de uma loja. Ajude o cliente a encontrar produtos, tirar dúvidas sobre tamanhos, preços, frete e prazos. Seja persuasivo mas nunca invente informação sobre estoque ou preço — se não souber, diga que vai confirmar.' },
  { nicho: 'Imobiliária', nome: 'Imobiliária', prompt: 'Você é o atendente virtual de uma imobiliária. Ajude o cliente a entender os imóveis disponíveis, agende visitas e capture o perfil de interesse (bairro, valor, tipo de imóvel). Seja consultivo, não apenas informativo.' },
  { nicho: 'Serviços gerais', nome: 'Serviços', prompt: 'Você é o atendente virtual de uma prestadora de serviços. Entenda a necessidade do cliente, explique como funciona o serviço, prazos e valores, e direcione para o fechamento ou agendamento.' }
];

router.get('/prompt-templates', (req, res) => res.json(PROMPT_TEMPLATES));

// Lista todos os clientes (empresas) da plataforma, com dados de cobrança e risco
router.get('/clients', async (req, res) => {
  const { rows } = await pool.query(
    `select c.client_id, c.nome_empresa, c.nicho, c.active, c.plan, c.evolution_instance,
            c.monthly_fee, c.payment_status, c.next_due_date, c.owner_phone,
            (select count(*)::int from public.leads l where l.client_id = c.client_id) as total_leads,
            (select count(*)::int from public.messages m where m.client_id = c.client_id) as total_mensagens,
            (select count(*)::int from public.agent_alerts a where a.client_id = c.client_id and a.resolved = false) as alertas_abertos,
            (select max(u.last_login) from public.users u where u.client_id = c.client_id) as ultimo_login
     from public.clients c
     order by c.nome_empresa asc nulls last`
  );
  res.json(rows);
});

// Cria um novo cliente + primeiro usuário (dono) dele
router.post('/clients', async (req, res) => {
  const { client_id, nome_empresa, nicho, evolution_instance, plan, owner_email, owner_phone, monthly_fee, billing_day, system_prompt } = req.body || {};
  if (!client_id || !nome_empresa || !owner_email) {
    return res.status(400).json({ error: 'client_id, nome_empresa e owner_email são obrigatórios' });
  }
  let prompt = system_prompt;
  if (!prompt) {
    const defaultPromptRes = await pool.query(`select value from public.platform_settings where key = 'default_prompt'`);
    prompt = defaultPromptRes.rows[0]?.value || 'Você é um agente de atendimento simpático e objetivo.';
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into public.clients (client_id, nome_empresa, nicho, evolution_instance, system_prompt, active, plan, owner_phone, monthly_fee, billing_day, next_due_date)
       values ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, (current_date + interval '30 days')::date)`,
      [client_id, nome_empresa, nicho || null, evolution_instance || null, prompt, plan || 'trial', owner_phone || null, monthly_fee || 0, billing_day || 5]
    );
    const tempPassword = crypto.randomBytes(4).toString('hex');
    const hash = await bcrypt.hash(tempPassword, 10);
    await client.query(
      `insert into public.users (client_id, email, password_hash, name, role) values ($1, $2, $3, $4, 'owner')`,
      [client_id, owner_email, hash, nome_empresa]
    );
    await client.query('commit');
    res.json({ ok: true, owner_email, temp_password: tempPassword });
  } catch (e) {
    await client.query('rollback');
    res.status(500).json({ error: 'Erro ao criar cliente', detail: String(e) });
  } finally {
    client.release();
  }
});

// Checklist de onboarding de um cliente (pra ver rápido o que falta configurar)
router.get('/clients/:clientId/checklist', async (req, res) => {
  const { clientId } = req.params;
  const c = await pool.query('select * from public.clients where client_id = $1', [clientId]);
  const client = c.rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  const leads = await pool.query('select count(*)::int as total from public.leads where client_id = $1', [clientId]);
  const mensagens = await pool.query('select count(*)::int as total from public.messages where client_id = $1 and direction = \'outbound\'', [clientId]);
  const kb = await pool.query(`select count(*)::int as total from public.knowledge_sources where client_id = $1 and status = 'pronto'`, [clientId]).catch(() => ({ rows: [{ total: 0 }] }));

  res.json({
    instancia_configurada: !!client.evolution_instance,
    prompt_personalizado: !!client.system_prompt && client.system_prompt.length > 50,
    telefone_dono_cadastrado: !!client.owner_phone,
    cobranca_configurada: Number(client.monthly_fee) > 0,
    primeiro_lead_capturado: leads.rows[0].total > 0,
    primeira_mensagem_enviada: mensagens.rows[0].total > 0,
    base_conhecimento: kb.rows[0].total > 0
  });
});

// Detalhe de um cliente específico
router.get('/clients/:clientId', async (req, res) => {
  const { rows } = await pool.query(
    `select * from public.clients where client_id = $1`,
    [req.params.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(rows[0]);
});

// Atualiza qualquer cliente
router.put('/clients/:clientId', async (req, res) => {
  const { nome_empresa, nicho, system_prompt, active, evolution_instance, plan, owner_phone, monthly_fee, billing_day } = req.body || {};
  await pool.query(
    `update public.clients set
       nome_empresa = coalesce($1, nome_empresa),
       nicho = coalesce($2, nicho),
       system_prompt = coalesce($3, system_prompt),
       active = coalesce($4, active),
       evolution_instance = coalesce($5, evolution_instance),
       plan = coalesce($6, plan),
       owner_phone = coalesce($7, owner_phone),
       monthly_fee = coalesce($8, monthly_fee),
       billing_day = coalesce($9, billing_day)
     where client_id = $10`,
    [nome_empresa ?? null, nicho ?? null, system_prompt ?? null, active ?? null, evolution_instance ?? null,
     plan ?? null, owner_phone ?? null, monthly_fee ?? null, billing_day ?? null, req.params.clientId]
  );
  res.json({ ok: true });
});

// Marca a mensalidade do cliente como paga (registra no histórico e agenda o próximo vencimento)
router.post('/clients/:clientId/mark-paid', async (req, res) => {
  const { clientId } = req.params;
  const c = await pool.query('select monthly_fee, billing_day from public.clients where client_id = $1', [clientId]);
  const client = c.rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  await pool.query(
    'insert into public.payments_log (client_id, amount) values ($1, $2)',
    [clientId, client.monthly_fee || 0]
  );
  await pool.query(
    `update public.clients set payment_status = 'em_dia',
       next_due_date = (date_trunc('month', current_date) + interval '1 month' + ($1 || ' days')::interval - interval '1 day')::date
     where client_id = $2`,
    [client.billing_day || 5, clientId]
  );
  res.json({ ok: true });
});

// Alertas de um cliente
router.get('/clients/:clientId/alerts', async (req, res) => {
  const { rows } = await pool.query(
    'select * from public.agent_alerts where client_id = $1 order by created_at desc limit 50',
    [req.params.clientId]
  );
  res.json(rows);
});

// Métricas semanais (últimas 8 semanas) de um cliente
router.get('/clients/:clientId/weekly', async (req, res) => {
  const { clientId } = req.params;
  const { rows } = await pool.query(
    `select date_trunc('week', created_at) as semana, count(*)::int as total
     from public.messages
     where client_id = $1 and created_at > now() - interval '8 weeks'
     group by 1 order by 1 asc`,
    [clientId]
  );
  res.json(rows);
});

// Gera um acesso temporário para o admin entrar como se fosse o cliente (suporte)
router.post('/clients/:clientId/impersonate', async (req, res) => {
  const { clientId } = req.params;
  const userRes = await pool.query(
    `select * from public.users where client_id = $1 and role = 'owner' order by created_at asc limit 1`,
    [clientId]
  );
  const user = userRes.rows[0];
  if (!user) return res.status(404).json({ error: 'Nenhum usuário dono encontrado para esse cliente' });

  const clientRes = await pool.query('select * from public.clients where client_id = $1', [clientId]);
  const clientRow = clientRes.rows[0];

  const token = jwt.sign(
    { userId: user.id, clientId: user.client_id, email: user.email, role: user.role, impersonatedByAdmin: true },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );
  res.json({
    token,
    user: { email: user.email, name: user.name, role: user.role },
    client: clientRow ? { client_id: clientRow.client_id, nome_empresa: clientRow.nome_empresa, nicho: clientRow.nicho } : null
  });
});

// Configurações globais da plataforma (ex: prompt padrão pra novos clientes)
router.get('/settings', async (req, res) => {
  const { rows } = await pool.query('select key, value from public.platform_settings');
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

router.put('/settings', async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    await pool.query(
      `insert into public.platform_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = $2`,
      [key, value]
    );
  }
  res.json({ ok: true });
});

// Métricas gerais da plataforma (todos os clientes)
router.get('/overview', async (req, res) => {
  const clientes = await pool.query(`select count(*)::int as total, count(*) filter (where active)::int as ativos from public.clients`);
  const leads = await pool.query(`select count(*)::int as total from public.leads where created_at > now() - interval '30 days'`).catch(() => ({ rows: [{ total: null }] }));
  const mensagens = await pool.query(`select count(*)::int as total from public.messages where created_at > now() - interval '30 days'`);
  const mrr = await pool.query(`select coalesce(sum(monthly_fee), 0)::float as total from public.clients where active = true`);
  res.json({
    clientes_total: clientes.rows[0].total,
    clientes_ativos: clientes.rows[0].ativos,
    leads_30_dias: leads.rows[0].total,
    mensagens_30_dias: mensagens.rows[0].total,
    mrr: mrr.rows[0].total
  });
});

// Dashboard financeiro: MRR atual, evolução mensal (receita coletada) e crescimento de clientes
router.get('/finance', async (req, res) => {
  const mrrAtual = await pool.query(`select coalesce(sum(monthly_fee), 0)::float as total from public.clients where active = true`);
  const pagantes = await pool.query(`select count(*)::int as total from public.clients where active = true and monthly_fee > 0`);
  const atrasados = await pool.query(`select count(*)::int as total from public.clients where payment_status = 'atrasado'`);

  const receitaMensal = await pool.query(
    `select to_char(date_trunc('month', paid_at), 'YYYY-MM') as mes, sum(amount)::float as total
     from public.payments_log
     where paid_at > now() - interval '12 months'
     group by 1 order by 1`
  );
  const clientesPorMes = await pool.query(
    `select to_char(date_trunc('month', created_at), 'YYYY-MM') as mes, count(*)::int as total
     from public.clients
     where created_at > now() - interval '12 months'
     group by 1 order by 1`
  );

  res.json({
    mrr_atual: mrrAtual.rows[0].total,
    clientes_pagantes: pagantes.rows[0].total,
    clientes_atrasados: atrasados.rows[0].total,
    receita_coletada_por_mes: receitaMensal.rows,
    novos_clientes_por_mes: clientesPorMes.rows
  });
});

// Radar de risco de cancelamento: cliente sumido, pagamento atrasado ou queda de uso
router.get('/risk', async (req, res) => {
  const { rows } = await pool.query(
    `select c.client_id, c.nome_empresa, c.payment_status, c.next_due_date,
            (select max(u.last_login) from public.users u where u.client_id = c.client_id) as ultimo_login,
            (select count(*)::int from public.messages m where m.client_id = c.client_id and m.created_at > now() - interval '7 days') as msgs_semana_atual,
            (select count(*)::int from public.messages m where m.client_id = c.client_id and m.created_at > now() - interval '14 days' and m.created_at <= now() - interval '7 days') as msgs_semana_anterior
     from public.clients c
     where c.active = true`
  );

  const avaliados = rows.map(c => {
    let pontos = 0;
    const motivos = [];

    const diasSemLogin = c.ultimo_login ? Math.floor((Date.now() - new Date(c.ultimo_login).getTime()) / 86400000) : null;
    if (diasSemLogin === null || diasSemLogin > 14) { pontos += 2; motivos.push(diasSemLogin === null ? 'Nunca fez login' : `${diasSemLogin} dias sem logar`); }
    else if (diasSemLogin > 7) { pontos += 1; motivos.push(`${diasSemLogin} dias sem logar`); }

    if (c.payment_status === 'atrasado') { pontos += 2; motivos.push('Pagamento atrasado'); }

    const queda = c.msgs_semana_anterior > 0 ? (c.msgs_semana_atual - c.msgs_semana_anterior) / c.msgs_semana_anterior : 0;
    if (c.msgs_semana_anterior >= 5 && queda <= -0.5) { pontos += 2; motivos.push(`Queda de ${Math.round(Math.abs(queda) * 100)}% nas mensagens`); }

    const risco = pontos >= 3 ? 'alto' : pontos >= 1 ? 'medio' : 'baixo';
    return { ...c, dias_sem_login: diasSemLogin, risco, motivos };
  });

  avaliados.sort((a, b) => ({ alto: 0, medio: 1, baixo: 2 }[a.risco] - { alto: 0, medio: 1, baixo: 2 }[b.risco]));
  res.json(avaliados);
});

module.exports = router;
