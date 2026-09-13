// =============================================================================
// API pública v1 — /api/v1/*
//
// A integração precisa funcionar nos DOIS sentidos. Os adaptadores de CRM
// resolvem "a plataforma avisa o sistema do cliente". Esta rota resolve o
// contrário: o CRM (ou ERP, ou site) do cliente chama a plataforma.
//
// Casos que isso destrava:
//   • formulário do site cria o lead e o agente já inicia a conversa
//   • CRM dispara uma mensagem de WhatsApp a partir de uma automação de lá
//   • o ERP marca "venda fechada" e o agente para de fazer follow-up
//   • um BI puxa as métricas sem acesso ao banco
//
// Autenticação por header `X-API-Key`. A chave só existe em claro no momento em
// que é gerada — o banco guarda apenas o SHA-256.
// =============================================================================

const express = require('express');
const pool = require('../db');
const { hashApiKey } = require('../lib/crypto');
const evolution = require('../lib/evolution');
const events = require('../lib/events');

const router = express.Router();

// -----------------------------------------------------------------------------
// Autenticação
// -----------------------------------------------------------------------------

async function apiKeyAuth(req, res, next) {
  const key = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Envie sua chave no header X-API-Key. Gere uma em Configurações > API na plataforma.'
    });
  }

  const { rows } = await pool.query(
    `select k.*, c.nome_empresa, c.evolution_instance, c.active as client_active
       from public.api_keys k
       join public.clients c on c.client_id = k.client_id
      where k.key_hash = $1 and k.revoked = false`,
    [hashApiKey(key)]
  );
  const apiKey = rows[0];
  if (!apiKey) return res.status(401).json({ error: 'unauthorized', message: 'Chave inválida ou revogada' });
  if (!apiKey.client_active) return res.status(403).json({ error: 'client_inactive', message: 'Conta inativa' });

  req.apiKey = apiKey;
  req.clientId = apiKey.client_id;

  // Registro de uso (não bloqueia a resposta)
  pool.query('update public.api_keys set last_used_at = now() where id = $1', [apiKey.id]).catch(() => {});
  next();
}

function requireScope(scope) {
  return (req, res, next) => {
    if (!req.apiKey.scopes?.includes(scope)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `Esta chave não tem a permissão "${scope}". Permissões da chave: ${req.apiKey.scopes?.join(', ')}`
      });
    }
    next();
  };
}

// Rate limit em memória. Suficiente para uma instância; num cluster, troque por
// Redis. Deixado explícito de propósito para não dar falsa sensação de proteção.
const buckets = new Map();
function rateLimit({ perMinute = 120 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const janela = Math.floor(now / 60000);
    const chave = `${req.apiKey.id}:${janela}`;
    const atual = (buckets.get(chave) || 0) + 1;
    buckets.set(chave, atual);
    if (buckets.size > 5000) {
      for (const k of buckets.keys()) if (!k.endsWith(`:${janela}`)) buckets.delete(k);
    }
    res.setHeader('X-RateLimit-Limit', perMinute);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, perMinute - atual));
    if (atual > perMinute) {
      return res.status(429).json({ error: 'rate_limited', message: `Limite de ${perMinute} requisições por minuto` });
    }
    next();
  };
}

router.use(apiKeyAuth, rateLimit());

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// -----------------------------------------------------------------------------
// Meta
// -----------------------------------------------------------------------------

router.get('/me', (req, res) => {
  res.json({
    client_id: req.clientId,
    empresa: req.apiKey.nome_empresa,
    chave: req.apiKey.name,
    permissoes: req.apiKey.scopes
  });
});

// -----------------------------------------------------------------------------
// Leads
// -----------------------------------------------------------------------------

router.get('/leads', requireScope('leads:read'), asyncH(async (req, res) => {
  const { status, stage, since, q } = req.query;
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;

  const cond = ['client_id = $1'];
  const params = [req.clientId];
  // devolve o placeholder ($2, $3...) do valor recém-adicionado
  const bind = val => { params.push(val); return `$${params.length}`; };

  if (status) cond.push(`status = ${bind(status)}`);
  if (stage) cond.push(`stage = ${bind(stage)}`);
  if (since) cond.push(`last_inbound_at >= ${bind(since)}::timestamptz`);
  if (q) {
    const p = bind(`%${q}%`);           // um só placeholder, usado nas duas colunas
    cond.push(`(name ilike ${p} or phone ilike ${p})`);
  }

  const { rows } = await pool.query(
    `select phone, name, email, status, stage, score, urgent, qualification,
            sale_value, sold_at, summary, source, created_at, last_inbound_at
       from public.leads
      where ${cond.join(' and ')}
      order by last_inbound_at desc nulls last
      limit ${limit} offset ${offset}`,
    params
  );
  const total = await pool.query(`select count(*)::int as t from public.leads where ${cond.join(' and ')}`, params);

  res.json({ data: rows, total: total.rows[0].t, limit, offset });
}));

router.get('/leads/:phone', requireScope('leads:read'), asyncH(async (req, res) => {
  const { rows } = await pool.query(
    'select * from public.leads where client_id = $1 and phone like $2',
    [req.clientId, `${req.params.phone.replace(/\D/g, '')}%`]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found', message: 'Lead não encontrado' });

  const timeline = await pool.query(
    'select type, payload, actor, created_at from public.lead_events where client_id = $1 and phone = $2 order by created_at desc limit 100',
    [req.clientId, rows[0].phone]
  );
  res.json({ ...rows[0], timeline: timeline.rows });
}));

/** Cria ou atualiza um lead. É por aqui que o formulário do site entra. */
router.post('/leads', requireScope('leads:write'), asyncH(async (req, res) => {
  const { phone, name, email, qualification, status, stage, source, sale_value } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'invalid_request', message: 'O campo phone é obrigatório' });

  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) {
    return res.status(400).json({ error: 'invalid_request', message: 'Telefone inválido — envie com DDI e DDD (ex: 5511999999999)' });
  }
  const jid = `${digits}@s.whatsapp.net`;

  const { rows } = await pool.query(
    `insert into public.leads (client_id, phone, name, email, status, stage, source, qualification, sale_value, created_at, last_inbound_at)
     values ($1,$2,$3,$4, coalesce($5,'ativo'), coalesce($6,'novo'), coalesce($7,'api'), coalesce($8,'{}'::jsonb), $9, now(), now())
     on conflict (client_id, phone) do update
        set name = coalesce(excluded.name, public.leads.name),
            email = coalesce(excluded.email, public.leads.email),
            status = coalesce($5, public.leads.status),
            stage = coalesce($6, public.leads.stage),
            sale_value = coalesce($9, public.leads.sale_value),
            qualification = coalesce(public.leads.qualification,'{}'::jsonb) || coalesce($8,'{}'::jsonb)
     returning *, (xmax = 0) as created`,
    [req.clientId, jid, name || null, email || null, status || null, stage || null,
     source || null, qualification ? JSON.stringify(qualification) : null,
     sale_value != null ? Number(sale_value) : null]
  );

  const lead = rows[0];
  if (lead.created) {
    await events.record(req.clientId, jid, 'lead.created', { name, email, source: source || 'api' }, { actor: `api:${req.apiKey.key_prefix}` });
  }
  res.status(lead.created ? 201 : 200).json(lead);
}));

/** Marca venda ganha/perdida — o ERP chama isso e o follow-up para sozinho. */
router.post('/leads/:phone/status', requireScope('leads:write'), asyncH(async (req, res) => {
  const { status, sale_value, lost_reason } = req.body || {};
  const permitidos = ['ativo', 'aguardando_humano', 'fechado', 'vendido', 'perdido'];
  if (!permitidos.includes(status)) {
    return res.status(400).json({ error: 'invalid_request', message: `status deve ser um de: ${permitidos.join(', ')}` });
  }

  const jid = `${req.params.phone.replace(/\D/g, '')}@s.whatsapp.net`;
  const { rowCount } = await pool.query(
    `update public.leads
        set status = $3,
            sale_value = coalesce($4, sale_value),
            sold_at = case when $3 = 'vendido' then now() else sold_at end,
            lost_reason = coalesce($5, lost_reason)
      where client_id = $1 and phone = $2`,
    [req.clientId, jid, status, sale_value != null ? Number(sale_value) : null, lost_reason || null]
  );
  if (!rowCount) return res.status(404).json({ error: 'not_found', message: 'Lead não encontrado' });

  if (status === 'vendido') await events.record(req.clientId, jid, 'lead.won', { sale_value }, { actor: `api:${req.apiKey.key_prefix}`, sync: true });
  if (status === 'perdido') await events.record(req.clientId, jid, 'lead.lost', { lost_reason }, { actor: `api:${req.apiKey.key_prefix}`, sync: true });

  res.json({ ok: true, status });
}));

// -----------------------------------------------------------------------------
// Conversas e mensagens
// -----------------------------------------------------------------------------

router.get('/conversations/:phone/messages', requireScope('conversations:read'), asyncH(async (req, res) => {
  const jid = `${req.params.phone.replace(/\D/g, '')}@s.whatsapp.net`;
  const { rows } = await pool.query(
    `select direction, coalesce(transcript, content) as content, media_url, media_type, author, created_at
       from public.messages where client_id = $1 and phone = $2
       order by created_at asc limit $3`,
    [req.clientId, jid, Math.min(500, Number(req.query.limit) || 100)]
  );
  res.json({ phone: req.params.phone, messages: rows });
}));

/** Dispara uma mensagem de WhatsApp a partir do sistema do cliente. */
router.post('/messages', requireScope('messages:send'), asyncH(async (req, res) => {
  const { phone, text, media_url, media_type, file_name, caption, pause_agent } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'invalid_request', message: 'phone é obrigatório' });
  if (!text && !media_url) return res.status(400).json({ error: 'invalid_request', message: 'Informe text ou media_url' });

  const instance = req.apiKey.evolution_instance;
  if (!instance) return res.status(409).json({ error: 'not_configured', message: 'Esta conta não tem instância de WhatsApp configurada' });

  const jid = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;

  try {
    if (media_url) {
      await evolution.sendMedia(instance, jid, {
        mediatype: media_type || 'document',
        media: media_url,
        fileName: file_name,
        caption: caption || text || ''
      });
    } else {
      await evolution.sendText(instance, jid, text);
    }
  } catch (e) {
    return res.status(502).json({ error: 'send_failed', message: e.message });
  }

  await pool.query(
    `insert into public.messages (client_id, phone, direction, content, media_url, media_type, processed, author, created_at)
     values ($1,$2,'outbound',$3,$4,$5,true,$6, now())`,
    [req.clientId, jid, text || caption || `[${media_type || 'arquivo'}]`, media_url || null,
     media_url ? (media_type || 'document') : null, `api:${req.apiKey.key_prefix}`]
  );

  // Mensagem disparada por sistema externo normalmente significa que um humano
  // (ou outra automação) assumiu — pausar o agente evita as duas vozes na conversa.
  if (pause_agent !== false) {
    await pool.query(
      `insert into public.conversation_state (client_id, phone, paused, paused_by, paused_until, updated_at)
       values ($1,$2,true,$3, now() + interval '2 hours', now())
       on conflict (client_id, phone) do update
          set paused = true, paused_by = $3, paused_until = now() + interval '2 hours', updated_at = now()`,
      [req.clientId, jid, `api:${req.apiKey.key_prefix}`]
    );
  }

  res.json({ ok: true, phone: jid });
}));

/** Liga/desliga o agente numa conversa. */
router.post('/conversations/:phone/agent', requireScope('conversations:read'), asyncH(async (req, res) => {
  const { enabled } = req.body || {};
  const jid = `${req.params.phone.replace(/\D/g, '')}@s.whatsapp.net`;
  await pool.query(
    `insert into public.conversation_state (client_id, phone, paused, paused_by, paused_until, updated_at)
     values ($1,$2,$3,$4, case when $3 then now() + interval '24 hours' else null end, now())
     on conflict (client_id, phone) do update
        set paused = $3, paused_by = $4,
            paused_until = case when $3 then now() + interval '24 hours' else null end,
            updated_at = now()`,
    [req.clientId, jid, enabled === false, `api:${req.apiKey.key_prefix}`]
  );
  res.json({ ok: true, agent_enabled: enabled !== false });
}));

// -----------------------------------------------------------------------------
// Métricas
// -----------------------------------------------------------------------------

router.get('/metrics', requireScope('leads:read'), asyncH(async (req, res) => {
  const dias = Math.min(365, Number(req.query.days) || 30);
  const { rows } = await pool.query(
    `select
       count(*) filter (where created_at >= now() - ($2||' days')::interval)::int as leads,
       count(*) filter (where status = 'vendido' and sold_at >= now() - ($2||' days')::interval)::int as vendas,
       coalesce(sum(sale_value) filter (where status='vendido' and sold_at >= now() - ($2||' days')::interval),0)::float as receita,
       count(*) filter (where status = 'aguardando_humano')::int as aguardando_humano
     from public.leads where client_id = $1`,
    [req.clientId, dias]
  );
  const msgs = await pool.query(
    `select count(*) filter (where direction='inbound')::int as recebidas,
            count(*) filter (where direction='outbound')::int as enviadas
       from public.messages where client_id = $1 and created_at >= now() - ($2||' days')::interval`,
    [req.clientId, dias]
  );
  res.json({ periodo_dias: dias, ...rows[0], ...msgs.rows[0] });
}));

// -----------------------------------------------------------------------------

router.use((err, req, res, _next) => {
  console.error('[api v1]', err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno. Se persistir, avise o suporte.' });
});

module.exports = router;
