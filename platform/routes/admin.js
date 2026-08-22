const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
    `select client_id, nome_empresa, nicho, active, evolution_instance,
            (select count(*)::int from public.leads l where l.client_id = c.client_id) as total_leads,
            (select count(*)::int from public.messages m where m.client_id = c.client_id) as total_mensagens
     from public.clients c
     order by nome_empresa asc nulls last`
  );
  res.json(rows);
});

// Detalhe de um cliente específico
router.get('/clients/:clientId', async (req, res) => {
  const { rows } = await pool.query(
    `select client_id, nome_empresa, nicho, system_prompt, active, evolution_instance
     from public.clients where client_id = $1`,
    [req.params.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(rows[0]);
});

// Atualiza qualquer cliente
router.put('/clients/:clientId', async (req, res) => {
  const { nome_empresa, nicho, system_prompt, active, evolution_instance } = req.body || {};
  await pool.query(
    `update public.clients set
       nome_empresa = coalesce($1, nome_empresa),
       nicho = coalesce($2, nicho),
       system_prompt = coalesce($3, system_prompt),
       active = coalesce($4, active),
       evolution_instance = coalesce($5, evolution_instance)
     where client_id = $6`,
    [nome_empresa ?? null, nicho ?? null, system_prompt ?? null, active ?? null, evolution_instance ?? null, req.params.clientId]
  );
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
