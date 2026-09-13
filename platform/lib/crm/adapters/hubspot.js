// HubSpot — Private App token (Settings > Integrations > Private Apps).
// Escopos necessários: crm.objects.contacts.read/write e crm.objects.deals.write.

const { request } = require('./_http');

const API = 'https://api.hubapi.com';

module.exports = {
  provider: 'hubspot',
  label: 'HubSpot',
  descricao: 'Cria/atualiza contato e abre negócio no pipeline quando o lead qualifica.',
  campos: [
    { nome: 'access_token', label: 'Token do Private App', tipo: 'password', obrigatorio: true,
      ajuda: 'HubSpot > Configurações > Integrações > Private Apps > criar app > copiar token' },
    { nome: 'pipeline_id', label: 'ID do pipeline', tipo: 'text', obrigatorio: false,
      ajuda: 'Deixe vazio para usar o pipeline padrão' },
    { nome: 'stage_id', label: 'ID do estágio inicial', tipo: 'text', obrigatorio: false },
    { nome: 'criar_negocio', label: 'Abrir negócio ao qualificar', tipo: 'boolean', padrao: true }
  ],

  async test({ access_token }) {
    const res = await request(`${API}/crm/v3/objects/contacts?limit=1`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    return { ok: true, detalhe: `Conectado (${res.body.total ?? 0} contatos visíveis)` };
  },

  async push(event, lead, config) {
    const headers = {
      Authorization: `Bearer ${config.access_token}`,
      'Content-Type': 'application/json'
    };

    const properties = {
      phone: lead.phone_e164 || lead.phone,
      ...(lead.email ? { email: lead.email } : {}),
      ...(lead.nome ? {
        firstname: lead.nome.split(' ')[0],
        lastname: lead.nome.split(' ').slice(1).join(' ') || undefined
      } : {}),
      ...(lead.empresa ? { company: lead.empresa } : {}),
      ...(lead.cargo ? { jobtitle: lead.cargo } : {}),
      hs_lead_status: event === 'lead.won' ? 'CONNECTED' : 'NEW',
      ...(lead._custom || {})
    };
    Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);

    // HubSpot só faz "upsert" por e-mail. Sem e-mail (o normal no WhatsApp),
    // procuramos por telefone primeiro para não duplicar o contato.
    let contactId = null;

    const busca = await request(`${API}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers,
      body: {
        filterGroups: [{
          filters: [{ propertyName: 'phone', operator: 'EQ', value: lead.phone_e164 || lead.phone }]
        }],
        properties: ['phone', 'email'],
        limit: 1
      }
    });
    contactId = busca.body?.results?.[0]?.id || null;

    if (contactId) {
      await request(`${API}/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH', headers, body: { properties }
      });
    } else {
      const criado = await request(`${API}/crm/v3/objects/contacts`, {
        method: 'POST', headers, body: { properties }
      });
      contactId = criado.body?.id;
    }

    // Anota o contexto da conversa como nota vinculada ao contato
    if (lead.transcricao && (event === 'lead.qualified' || event === 'handoff.requested')) {
      await request(`${API}/crm/v3/objects/notes`, {
        method: 'POST', headers,
        body: {
          properties: {
            hs_note_body:
              `<b>Conversa no WhatsApp (ConversIA)</b><br>` +
              (lead.necessidade ? `<b>Necessidade:</b> ${escapeHtml(lead.necessidade)}<br>` : '') +
              (lead.prazo ? `<b>Prazo:</b> ${escapeHtml(lead.prazo)}<br>` : '') +
              `<br><pre>${escapeHtml(lead.transcricao.slice(0, 3000))}</pre>`,
            hs_timestamp: Date.now()
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
          }]
        }
      }).catch(e => console.warn('[hubspot] nota não criada:', e.message));
    }

    // Negócio no pipeline
    let dealId = null;
    if (config.criar_negocio !== false && ['lead.qualified', 'lead.won'].includes(event)) {
      const deal = await request(`${API}/crm/v3/objects/deals`, {
        method: 'POST', headers,
        body: {
          properties: {
            dealname: `${lead.nome || lead.phone} — ${lead.empresa || 'WhatsApp'}`,
            ...(config.pipeline_id ? { pipeline: config.pipeline_id } : {}),
            ...(config.stage_id ? { dealstage: config.stage_id } : {}),
            ...(lead.valor_venda ? { amount: String(lead.valor_venda) } : {}),
            ...(event === 'lead.won' ? { closedate: new Date().toISOString() } : {})
          },
          associations: contactId ? [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
          }] : []
        }
      });
      dealId = deal.body?.id;
    }

    return { externalId: contactId, dealId, status: 200, request: { properties }, response: { contactId, dealId } };
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}
