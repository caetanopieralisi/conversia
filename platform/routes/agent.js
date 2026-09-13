const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Dados do agente/empresa do cliente logado
router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    `select client_id, nome_empresa, nicho, system_prompt, active, evolution_instance,
            monthly_goal, radar_hours, report_email, report_enabled
     from public.clients where client_id = $1`,
    [clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(rows[0]);
});

// Atualiza configuração do agente (nome, nicho, prompt, ativo/inativo, metas e relatório)
router.put('/', async (req, res) => {
  const { clientId } = req.user;
  const { nome_empresa, nicho, system_prompt, active, monthly_goal, radar_hours, report_email, report_enabled } = req.body || {};

  await pool.query(
    `update public.clients set
       nome_empresa = coalesce($1, nome_empresa),
       nicho = coalesce($2, nicho),
       system_prompt = coalesce($3, system_prompt),
       active = coalesce($4, active),
       monthly_goal = coalesce($5, monthly_goal),
       radar_hours = coalesce($6, radar_hours),
       report_email = coalesce($7, report_email),
       report_enabled = coalesce($8, report_enabled)
     where client_id = $9`,
    [nome_empresa ?? null, nicho ?? null, system_prompt ?? null, active ?? null,
     monthly_goal ?? null, radar_hours ?? null, report_email ?? null, report_enabled ?? null, clientId]
  );
  res.json({ ok: true });
});

module.exports = router;
