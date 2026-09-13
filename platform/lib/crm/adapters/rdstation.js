// RD Station Marketing — conversão via evento (o caminho mais simples e estável
// para entrar leads). Muito usado no mercado brasileiro.

const { request } = require('./_http');

module.exports = {
  provider: 'rdstation',
  label: 'RD Station Marketing',
  descricao: 'Registra o lead como uma conversão no RD Station, com os campos da qualificação.',
  campos: [
    { nome: 'api_key', label: 'Chave de API pública', tipo: 'password', obrigatorio: true,
      ajuda: 'RD Station > Integrações > Chave de API (a "public API key")' },
    { nome: 'identificador', label: 'Identificador da conversão', tipo: 'text', obrigatorio: false,
      ajuda: 'Nome que aparece no RD. Padrão: whatsapp-conversia' }
  ],

  async push(event, lead, config) {
    const identificador = config.identificador || 'whatsapp-conversia';

    // O RD exige e-mail. Sem e-mail, gera um placeholder rastreável a partir do
    // telefone — sem isso o lead simplesmente não entra, e é melhor entrar
    // identificável pelo telefone do que não entrar.
    const email = lead.email || `${lead.phone}@whatsapp.lead`;

    const body = {
      event_type: 'CONVERSION',
      event_family: 'CDP',
      payload: {
        conversion_identifier: `${identificador}${event === 'lead.won' ? '-venda' : ''}`,
        email,
        ...(lead.nome ? { name: lead.nome } : {}),
        ...(lead.phone_e164 ? { mobile_phone: lead.phone_e164, personal_phone: lead.phone_e164 } : {}),
        ...(lead.empresa ? { company_name: lead.empresa } : {}),
        ...(lead.cargo ? { job_title: lead.cargo } : {}),
        cf_origem: 'WhatsApp (ConversIA)',
        ...(lead.necessidade ? { cf_necessidade: lead.necessidade } : {}),
        ...(lead.prazo ? { cf_prazo: lead.prazo } : {}),
        ...(lead.orcamento ? { cf_orcamento: String(lead.orcamento) } : {}),
        ...(lead.estagio ? { cf_estagio: lead.estagio } : {}),
        ...(lead._custom || {})
      }
    };

    const res = await request(
      `https://api.rd.services/platform/conversions?api_key=${encodeURIComponent(config.api_key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
    );

    return {
      externalId: res.body?.event_uuid || email,
      status: res.status,
      request: body,
      response: res.body
    };
  }
};
