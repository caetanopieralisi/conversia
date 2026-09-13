// =============================================================================
// Camada de CRM.
//
// Cada CRM é um adaptador que implementa a mesma interface:
//
//   {
//     provider: 'hubspot',
//     label:    'HubSpot',
//     campos:   [...],                  // o que pedir no painel
//     async push(event, lead, config),  // manda o lead pra lá
//     async test(config)                // valida credencial no momento de salvar
//   }
//
// Adicionar um CRM novo = um arquivo em lib/crm/adapters/, sem tocar em mais
// nada. O evento que dispara a sincronização vem de lib/events.js, então o
// caminho da conversa não sabe (nem precisa saber) que existe CRM.
// =============================================================================

const pool = require('../../db');
const { decrypt } = require('../crypto');

const ADAPTERS = {
  hubspot:   require('./adapters/hubspot'),
  pipedrive: require('./adapters/pipedrive'),
  rdstation: require('./adapters/rdstation'),
  kommo:     require('./adapters/kommo'),
  webhook:   require('./adapters/generic-webhook')
};

function list() {
  return Object.values(ADAPTERS).map(a => ({
    provider: a.provider,
    label: a.label,
    descricao: a.descricao,
    campos: a.campos,
    eventos_suportados: a.eventos || ['lead.created', 'lead.qualified', 'lead.won', 'handoff.requested']
  }));
}

function get(provider) {
  return ADAPTERS[provider] || null;
}

/**
 * Monta o objeto de lead canônico que todo adaptador recebe.
 * Traduzir daqui para o formato do CRM é responsabilidade do adaptador —
 * assim o mapeamento de campos fica num lugar só, por CRM.
 */
async function buildLead(clientId, phone, extra = {}) {
  const { rows } = await pool.query(
    `select l.*, c.nome_empresa as tenant_nome
       from public.leads l
       join public.clients c on c.client_id = l.client_id
      where l.client_id = $1 and l.phone = $2`,
    [clientId, phone]
  );
  const lead = rows[0] || {};
  const q = { ...(lead.qualification || {}), ...(extra.qualification || {}) };

  // Últimas mensagens: dá contexto ao vendedor humano dentro do CRM
  const { rows: msgs } = await pool.query(
    `select direction, coalesce(transcript, content) as content, created_at
       from public.messages where client_id = $1 and phone = $2
       order by created_at desc limit 20`,
    [clientId, phone]
  );

  const digits = String(phone).split('@')[0].replace(/\D/g, '');

  return {
    client_id: clientId,
    phone: digits,
    phone_e164: digits ? `+${digits}` : null,
    whatsapp_jid: phone,
    nome: lead.name || q.nome || q.name || null,
    email: lead.email || q.email || null,
    empresa: q.empresa || q.company || null,
    cargo: q.cargo || null,
    necessidade: q.necessidade || q.interesse || q.produto || null,
    orcamento: q.orcamento || q.faixa_valor || null,
    prazo: q.prazo || q.urgencia || null,
    origem: lead.source || 'whatsapp',
    status: lead.status || 'ativo',
    estagio: lead.stage || null,
    urgente: !!lead.urgent,
    valor_venda: lead.sale_value != null ? Number(lead.sale_value) : null,
    resumo: lead.summary || null,
    qualificacao: q,
    criado_em: lead.created_at,
    ultima_interacao: lead.last_inbound_at,
    transcricao: msgs
      .reverse()
      .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Atendimento'}: ${m.content}`)
      .join('\n')
      .slice(0, 5000),
    ...extra
  };
}

/**
 * Envia o evento para um CRM. Registra tudo em integration_log — sem esse log,
 * "o lead não chegou no CRM" vira uma investigação às cegas.
 */
async function push(integration, event, payload) {
  const adapter = get(integration.provider);
  if (!adapter) {
    console.warn('[crm] provider desconhecido:', integration.provider);
    return { ok: false, error: 'provider desconhecido' };
  }

  const started = Date.now();
  let lead;
  try {
    lead = await buildLead(payload.clientId || payload.client_id, payload.phone, payload);
  } catch (e) {
    return { ok: false, error: `falha ao montar o lead: ${e.message}` };
  }

  // Mapeamento extra definido pelo cliente (campos customizados do CRM dele)
  if (integration.field_map && Object.keys(integration.field_map).length) {
    lead._custom = {};
    for (const [nosso, deles] of Object.entries(integration.field_map)) {
      if (lead[nosso] !== undefined && lead[nosso] !== null) lead._custom[deles] = lead[nosso];
    }
  }

  const credentials = decryptCredentials(integration.credentials);

  try {
    const result = await adapter.push(event, lead, { ...integration.config, ...credentials });

    await pool.query(
      `insert into public.integration_log
         (client_id, integration_id, event, phone, status, http_status, request_body, response_body, attempts)
       values ($1,$2,$3,$4,'ok',$5,$6,$7,1)`,
      [lead.client_id, integration.id, event, lead.phone, result.status || 200,
       JSON.stringify(result.request || {}), JSON.stringify(result.response || {})]
    ).catch(() => {});

    await pool.query(
      'update public.integrations set last_sync_at = now(), last_error = null where id = $1',
      [integration.id]
    );

    await pool.query(
      'insert into public.lead_events (client_id, phone, type, payload, actor) values ($1,$2,$3,$4,$5)',
      [lead.client_id, payload.phone, 'crm.synced',
       JSON.stringify({ provider: integration.provider, event, id_externo: result.externalId, ms: Date.now() - started }),
       'system']
    ).catch(() => {});

    return { ok: true, ...result };
  } catch (e) {
    console.error(`[crm] ${integration.provider} falhou:`, e.message);

    await pool.query(
      `insert into public.integration_log
         (client_id, integration_id, event, phone, status, http_status, response_body, attempts, next_retry_at)
       values ($1,$2,$3,$4,'retrying',$5,$6,1, now() + interval '5 minutes')`,
      [lead.client_id, integration.id, event, lead.phone, e.status || null,
       JSON.stringify({ error: String(e.message) })]
    ).catch(() => {});

    await pool.query(
      'update public.integrations set last_error = $2 where id = $1',
      [integration.id, String(e.message).slice(0, 500)]
    ).catch(() => {});

    return { ok: false, error: e.message };
  }
}

/** Reprocessa o que falhou. Chamado pelo cron. */
async function retryFailed(limit = 25) {
  const { rows } = await pool.query(
    `select l.*, i.* , l.id as log_id, i.id as integration_id
       from public.integration_log l
       join public.integrations i on i.id = l.integration_id
      where l.status = 'retrying' and l.next_retry_at <= now() and l.attempts < 5 and i.active = true
      order by l.next_retry_at asc limit $1`,
    [limit]
  );

  let ok = 0;
  for (const row of rows) {
    const integration = {
      id: row.integration_id, client_id: row.client_id, provider: row.provider,
      credentials: row.credentials, config: row.config, field_map: row.field_map
    };
    const result = await push(integration, row.event, { clientId: row.client_id, phone: row.phone });

    if (result.ok) {
      await pool.query(`update public.integration_log set status='ok' where id=$1`, [row.log_id]);
      ok++;
    } else {
      // backoff: 5min, 20min, 45min, 80min, 125min
      await pool.query(
        `update public.integration_log
            set attempts = attempts + 1,
                next_retry_at = now() + (power(attempts + 1, 2) * interval '5 minutes'),
                status = case when attempts + 1 >= 5 then 'error' else 'retrying' end
          where id = $1`,
        [row.log_id]
      );
    }
  }
  return { tentados: rows.length, sucesso: ok };
}

function decryptCredentials(credentials) {
  const out = {};
  for (const [k, v] of Object.entries(credentials || {})) {
    out[k] = typeof v === 'string' && v.startsWith('enc:') ? decrypt(v) : v;
  }
  return out;
}

async function test(provider, config) {
  const adapter = get(provider);
  if (!adapter) throw new Error('Integração desconhecida');
  if (!adapter.test) return { ok: true, aviso: 'Este conector não tem teste automático de credencial' };
  return adapter.test(config);
}

module.exports = { list, get, push, buildLead, retryFailed, test, ADAPTERS };
