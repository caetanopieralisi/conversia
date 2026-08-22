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

// Lista todos os clientes (empresas) da plataforma
router.get('/clients', async (req, res) => {
  const { rows } = await pool.query(
    `select client_id, nome_empresa, nicho, active, plan, evolution_instance,
            (select count(*)::int from public.leads l where l.client_id = c.client_id) as total_leads,
            (select count(*)::int from public.messages m where m.client_id = c.client_id) as total_mensagens,
            (select count(*)::int from public.agent_alerts a where a.client_id = c.client_id and a.resolved = false) as alertas_abertos
     from public.clients c
     order by nome_empresa asc nulls last`
  );
  res.json(rows);
});

// Cria um novo cliente + primeiro usuário (dono) dele
router.post('/clients', async (req, res) => {
  const { client_id, nome_empresa, nicho, evolution_instance, plan, owner_email } = req.body || {};
  if (!client_id || !nome_empresa || !owner_email) {
    return res.status(400).json({ error: 'client_id, nome_empresa e owner_email são obrigatórios' });
  }
  const defaultPromptRes = await pool.query(`select value from public.platform_settings where key = 'default_prompt'`);
  const defaultPrompt = defaultPromptRes.rows[0]?.value || 'Você é um agente de atendimento simpático e objetivo.';

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into public.clients (client_id, nome_empresa, nicho, evolution_instance, system_prompt, active, plan)
       values ($1, $2, $3, $4, $5, true, $6)`,
      [client_id, nome_empresa, nicho || null, evolution_instance || null, defaultPrompt, plan || 'trial']
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

// Detalhe de um cliente específico
router.get('/clients/:clientId', async (req, res) => {
  const { rows } = await pool.query(
    `select client_id, nome_empresa, nicho, system_prompt, active, plan, evolution_instance
     from public.clients where client_id = $1`,
    [req.params.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(rows[0]);
});

// Atualiza qualquer cliente
router.put('/clients/:clientId', async (req, res) => {
  const { nome_empresa, nicho, system_prompt, active, evolution_instance, plan } = req.body || {};
  await pool.query(
    `update public.clients set
       nome_empresa = coalesce($1, nome_empresa),
       nicho = coalesce($2, nicho),
       system_prompt = coalesce($3, system_prompt),
       active = coalesce($4, active),
       evolution_instance = coalesce($5, evolution_instance),
       plan = coalesce($6, plan)
     where client_id = $7`,
    [nome_empresa ?? null, nicho ?? null, system_prompt ?? null, active ?? null, evolution_instance ?? null, plan ?? null, req.params.clientId]
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
  res.json({
    clientes_total: clientes.rows[0].total,
    clientes_ativos: clientes.rows[0].ativos,
    leads_30_dias: leads.rows[0].total,
    mensagens_30_dias: mensagens.rows[0].total
  });
});

module.exports = router;
