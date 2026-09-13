// Kommo (ex-amoCRM) — token de longa duração.
// Comum em operações de WhatsApp no Brasil.

const { request } = require('./_http');

module.exports = {
  provider: 'kommo',
  label: 'Kommo (amoCRM)',
  descricao: 'Cria contato e lead no funil do Kommo, com a conversa anexada como nota.',
  campos: [
    { nome: 'access_token', label: 'Token de longa duração', tipo: 'password', obrigatorio: true,
      ajuda: 'Kommo > Configurações > Integrações > crie uma integração > "Token de longa duração"' },
    { nome: 'subdominio', label: 'Subdomínio', tipo: 'text', obrigatorio: true,
      ajuda: 'Se sua URL é acme.kommo.com, informe: acme' },
    { nome: 'pipeline_id', label: 'ID do funil', tipo: 'text', obrigatorio: false },
    { nome: 'status_id', label: 'ID do estágio', tipo: 'text', obrigatorio: false }
  ],

  async test({ access_token, subdominio }) {
    const res = await request(`https://${subdominio}.kommo.com/api/v4/account`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    return { ok: true, detalhe: `Conectado à conta ${res.body?.name || subdominio}` };
  },

  async push(event, lead, config) {
    const base = `https://${config.subdominio}.kommo.com/api/v4`;
    const headers = { Authorization: `Bearer ${config.access_token}`, 'Content-Type': 'application/json' };

    // O Kommo aceita criar lead + contato aninhado numa chamada só (_embedded)
    const body = [{
      name: `${lead.nome || lead.phone}${lead.empresa ? ' — ' + lead.empresa : ''}`,
      ...(config.pipeline_id ? { pipeline_id: Number(config.pipeline_id) } : {}),
      ...(config.status_id ? { status_id: Number(config.status_id) } : {}),
      ...(lead.valor_venda ? { price: Math.round(Number(lead.valor_venda)) } : {}),
      _embedded: {
        contacts: [{
          first_name: lead.nome || `WhatsApp ${lead.phone}`,
          custom_fields_values: [
            { field_code: 'PHONE', values: [{ value: lead.phone_e164 || lead.phone, enum_code: 'WORK' }] },
            ...(lead.email ? [{ field_code: 'EMAIL', values: [{ value: lead.email, enum_code: 'WORK' }] }] : [])
          ]
        }]
      }
    }];

    const res = await request(`${base}/leads/complex`, { method: 'POST', headers, body });
    const leadId = res.body?.[0]?.id;

    if (leadId && lead.transcricao) {
      await request(`${base}/leads/${leadId}/notes`, {
        method: 'POST', headers,
        body: [{
          note_type: 'common',
          params: {
            text:
              `Conversa no WhatsApp (ConversIA)\n` +
              (lead.necessidade ? `Necessidade: ${lead.necessidade}\n` : '') +
              (lead.prazo ? `Prazo: ${lead.prazo}\n` : '') +
              `\n${lead.transcricao.slice(0, 3000)}`
          }
        }]
      }).catch(e => console.warn('[kommo] nota não criada:', e.message));
    }

    return { externalId: leadId, status: res.status, request: body, response: res.body };
  }
};
