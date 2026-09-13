// =============================================================================
// Eventos do lead — a espinha dorsal das integrações.
//
// Tudo que o agente faz vira um evento. Um evento alimenta, ao mesmo tempo:
//   • a timeline do lead no painel
//   • a sincronização com o CRM do cliente
//   • os webhooks de saída para o sistema dele
//
// Isso substitui a abordagem antiga (um node do Google Sheets pendurado no meio
// do fluxo). Adicionar um CRM novo passa a ser escrever um adaptador, não mexer
// no caminho da conversa.
// =============================================================================

const crypto = require('crypto');
const pool = require('../db');

const EVENTS = [
  'lead.created',
  'lead.qualified',
  'lead.won',
  'lead.lost',
  'stage.changed',
  'handoff.requested',
  'message.received',
  'message.sent',
  'asset.sent',
  'note.added'
];

/** Grava o evento na timeline e dispara integrações e webhooks (sem bloquear). */
async function record(clientId, phone, type, payload = {}, { actor = 'agent', sync = false } = {}) {
  try {
    await pool.query(
      'insert into public.lead_events (client_id, phone, type, payload, actor) values ($1,$2,$3,$4,$5)',
      [clientId, phone, type, JSON.stringify(payload), actor]
    );
  } catch (e) {
    console.error('[events] falha ao gravar', type, e.message);
  }

  const fanout = dispatch(clientId, phone, type, payload).catch(e =>
    console.error('[events] fanout falhou', type, e.message)
  );

  // Em ambiente serverless a função pode ser congelada assim que a resposta HTTP
  // sai — o await garante que o CRM foi chamado antes disso quando importa.
  if (sync) await fanout;
}

async function dispatch(clientId, phone, type, payload) {
  const [integrations, webhooks] = await Promise.all([
    pool.query(
      `select * from public.integrations
        where client_id = $1 and active = true and $2 = any(events)
          and direction in ('outbound','both')`,
      [clientId, type]
    ),
    pool.query(
      'select * from public.webhook_endpoints where client_id = $1 and active = true and $2 = any(events)',
      [clientId, type]
    )
  ]);

  const jobs = [];
  if (integrations.rows.length) {
    const crm = require('./crm');
    for (const integration of integrations.rows) {
      jobs.push(crm.push(integration, type, { clientId, phone, ...payload }));
    }
  }
  for (const endpoint of webhooks.rows) {
    jobs.push(deliverWebhook(endpoint, type, { client_id: clientId, phone, ...payload }));
  }
  await Promise.allSettled(jobs);
}

/**
 * Entrega um webhook assinado.
 * A assinatura é HMAC-SHA256 sobre `timestamp.body` — o timestamp no cálculo é o
 * que impede replay de uma requisição capturada.
 */
async function deliverWebhook(endpoint, event, data) {
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', endpoint.secret)
    .update(`${ts}.${body}`)
    .digest('hex');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ConversIA-Event': event,
        'X-ConversIA-Timestamp': String(ts),
        'X-ConversIA-Signature': `sha256=${signature}`
      },
      body,
      signal: controller.signal
    });

    if (res.ok) {
      if (endpoint.failure_count > 0) {
        await pool.query('update public.webhook_endpoints set failure_count = 0 where id = $1', [endpoint.id]);
      }
      return { ok: true };
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const fails = (endpoint.failure_count || 0) + 1;
    // Depois de 20 falhas seguidas o endpoint é desativado: continuar batendo num
    // servidor morto só gera fila e custo.
    await pool.query(
      'update public.webhook_endpoints set failure_count = $2, active = $3 where id = $1',
      [endpoint.id, fails, fails < 20]
    );
    await pool.query(
      `insert into public.integration_log (client_id, event, phone, status, response_body, attempts)
       values ($1,$2,$3,'error',$4,$5)`,
      [data.client_id, event, data.phone || null, JSON.stringify({ error: String(e.message) }), fails]
    ).catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { record, dispatch, deliverWebhook, EVENTS };
