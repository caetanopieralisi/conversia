// Playbook de vendas — a tela onde o cliente configura o vendedor sem escrever
// prompt. Também expõe uma prévia do prompt gerado, para não virar caixa-preta.

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const salesPrompt = require('../lib/agent/salesPrompt');

const router = express.Router();
router.use(requireAuth);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncH(async (req, res) => {
  const { rows } = await pool.query(
    `select client_id, nome_empresa, nicho, playbook, system_prompt, llm_provider, llm_model,
            llm_temperature, business_hours, max_agent_turns, agent_enabled,
            audio_enabled, vision_enabled, debounce_segundos, numero_responsavel
       from public.clients where client_id = $1`,
    [req.user.clientId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Cliente não encontrado' });

  const templates = await pool.query('select slug, nome, nicho, playbook from public.playbook_templates order by nome');
  res.json({ ...rows[0], templates: templates.rows });
}));

router.put('/', asyncH(async (req, res) => {
  const {
    playbook, system_prompt, llm_provider, llm_model, llm_temperature,
    business_hours, max_agent_turns, agent_enabled, audio_enabled, vision_enabled,
    debounce_segundos, numero_responsavel
  } = req.body || {};

  if (playbook !== undefined && (typeof playbook !== 'object' || Array.isArray(playbook))) {
    return res.status(400).json({ error: 'playbook deve ser um objeto' });
  }
  if (llm_provider && !['openai', 'anthropic', 'compatible'].includes(llm_provider)) {
    return res.status(400).json({ error: 'llm_provider inválido' });
  }
  if (llm_temperature != null && (llm_temperature < 0 || llm_temperature > 1.5)) {
    return res.status(400).json({ error: 'A temperatura deve ficar entre 0 e 1.5' });
  }

  await pool.query(
    `update public.clients set
       playbook = coalesce($1::jsonb, playbook),
       system_prompt = coalesce($2, system_prompt),
       llm_provider = coalesce($3, llm_provider),
       llm_model = coalesce($4, llm_model),
       llm_temperature = coalesce($5, llm_temperature),
       business_hours = coalesce($6::jsonb, business_hours),
       max_agent_turns = coalesce($7, max_agent_turns),
       agent_enabled = coalesce($8, agent_enabled),
       audio_enabled = coalesce($9, audio_enabled),
       vision_enabled = coalesce($10, vision_enabled),
       debounce_segundos = coalesce($11, debounce_segundos),
       numero_responsavel = coalesce($12, numero_responsavel)
     where client_id = $13`,
    [playbook ? JSON.stringify(playbook) : null, system_prompt ?? null,
     llm_provider ?? null, llm_model ?? null, llm_temperature ?? null,
     business_hours ? JSON.stringify(business_hours) : null,
     max_agent_turns ?? null, agent_enabled ?? null, audio_enabled ?? null,
     vision_enabled ?? null, debounce_segundos ?? null,
     numero_responsavel ? normalizeJid(numero_responsavel) : null,
     req.user.clientId]
  );
  res.json({ ok: true });
}));

/** Aplica um template de nicho por cima do playbook atual. */
router.post('/apply-template/:slug', asyncH(async (req, res) => {
  const t = await pool.query('select playbook from public.playbook_templates where slug = $1', [req.params.slug]);
  if (!t.rows[0]) return res.status(404).json({ error: 'Template não encontrado' });

  const atual = await pool.query('select playbook from public.clients where client_id = $1', [req.user.clientId]);
  // Preserva o que o cliente já customizou — o template só preenche buracos.
  const merged = { ...t.rows[0].playbook, ...(atual.rows[0]?.playbook || {}) };

  await pool.query('update public.clients set playbook = $1 where client_id = $2',
    [JSON.stringify(merged), req.user.clientId]);
  res.json({ ok: true, playbook: merged });
}));

/** Prévia do prompt gerado — transparência sobre o que o agente realmente recebe. */
router.post('/preview', asyncH(async (req, res) => {
  const { rows } = await pool.query('select * from public.clients where client_id = $1', [req.user.clientId]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  if (req.body?.playbook) client.playbook = req.body.playbook;

  const assets = await pool.query(
    'select id, name, description from public.assets where client_id = $1 and active limit 20',
    [req.user.clientId]
  );

  const prompt = salesPrompt.build({
    client,
    state: { stage: req.body?.estagio || 'descoberta', collected: req.body?.coletado || {} },
    assets: assets.rows,
    knowledge: req.body?.knowledge || '',
    lead: {}
  });

  res.json({ prompt, caracteres: prompt.length, tokens_estimados: Math.round(prompt.length / 3.6) });
}));

function normalizeJid(phone) {
  if (String(phone).includes('@')) return phone;
  const d = String(phone).replace(/\D/g, '');
  return d ? `${d}@s.whatsapp.net` : null;
}

module.exports = router;
