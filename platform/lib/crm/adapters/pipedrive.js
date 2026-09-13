// Pipedrive — API token pessoal (Configurações > Pessoal > API).

const { request } = require('./_http');

module.exports = {
  provider: 'pipedrive',
  label: 'Pipedrive',
  descricao: 'Cria pessoa e negócio, e registra a conversa como nota no negócio.',
  campos: [
    { nome: 'api_token', label: 'API Token', tipo: 'password', obrigatorio: true,
      ajuda: 'Pipedrive > Configurações pessoais > API > seu token' },
    { nome: 'dominio', label: 'Domínio da empresa', tipo: 'text', obrigatorio: true,
      ajuda: 'Se sua URL é acme.pipedrive.com, informe: acme' },
    { nome: 'pipeline_id', label: 'ID do funil', tipo: 'text', obrigatorio: false },
    { nome: 'stage_id', label: 'ID do estágio', tipo: 'text', obrigatorio: false },
    { nome: 'owner_id', label: 'ID do responsável', tipo: 'text', obrigatorio: false }
  ],

  async test({ api_token, dominio }) {
    const res = await request(`https://${dominio}.pipedrive.com/api/v1/users/me?api_token=${encodeURIComponent(api_token)}`);
    return { ok: true, detalhe: `Conectado como ${res.body?.data?.name || 'usuário'}` };
  },

  async push(event, lead, config) {
    const base = `https://${config.dominio}.pipedrive.com/api/v1`;
    const token = encodeURIComponent(config.api_token);
    const headers = { 'Content-Type': 'application/json' };

    // Evita duplicar: procura pessoa pelo telefone antes de criar
    let personId = null;
    const busca = await request(
      `${base}/persons/search?term=${encodeURIComponent(lead.phone)}&fields=phone&exact_match=true&api_token=${token}`
    ).catch(() => null);
    personId = busca?.body?.data?.items?.[0]?.item?.id || null;

    const personBody = {
      name: lead.nome || `WhatsApp ${lead.phone}`,
      phone: [{ value: lead.phone_e164 || lead.phone, primary: true, label: 'work' }],
      ...(lead.email ? { email: [{ value: lead.email, primary: true }] } : {}),
      ...(config.owner_id ? { owner_id: Number(config.owner_id) } : {}),
      ...(lead._custom || {})
    };

    if (personId) {
      await request(`${base}/persons/${personId}?api_token=${token}`, { method: 'PUT', headers, body: personBody });
    } else {
      const criado = await request(`${base}/persons?api_token=${token}`, { method: 'POST', headers, body: personBody });
      personId = criado.body?.data?.id;
    }

    let dealId = null;
    if (['lead.qualified', 'lead.won'].includes(event)) {
      const deal = await request(`${base}/deals?api_token=${token}`, {
        method: 'POST', headers,
        body: {
          title: `${lead.nome || lead.phone}${lead.empresa ? ' — ' + lead.empresa : ''}`,
          person_id: personId,
          ...(config.pipeline_id ? { pipeline_id: Number(config.pipeline_id) } : {}),
          ...(config.stage_id ? { stage_id: Number(config.stage_id) } : {}),
          ...(config.owner_id ? { user_id: Number(config.owner_id) } : {}),
          ...(lead.valor_venda ? { value: lead.valor_venda, currency: 'BRL' } : {}),
          status: event === 'lead.won' ? 'won' : 'open'
        }
      });
      dealId = deal.body?.data?.id;

      if (dealId && lead.transcricao) {
        await request(`${base}/notes?api_token=${token}`, {
          method: 'POST', headers,
          body: {
            deal_id: dealId,
            content:
              `<b>Conversa no WhatsApp (ConversIA)</b><br>` +
              (lead.necessidade ? `Necessidade: ${lead.necessidade}<br>` : '') +
              (lead.prazo ? `Prazo: ${lead.prazo}<br>` : '') +
              `<br>${lead.transcricao.slice(0, 3000).replace(/\n/g, '<br>')}`
          }
        }).catch(e => console.warn('[pipedrive] nota não criada:', e.message));
      }
    }

    return { externalId: personId, dealId, status: 200, request: personBody, response: { personId, dealId } };
  }
};
