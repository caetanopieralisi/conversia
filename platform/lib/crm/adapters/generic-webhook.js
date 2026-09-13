// Webhook genérico — o conector universal.
//
// É o mais importante da lista: cobre qualquer CRM que não tem adaptador
// dedicado (inclusive planilhas via Zapier/Make/n8n, ERPs internos, sistemas
// caseiros). O cliente informa uma URL, escolhe o método e, se quiser, mapeia
// os nomes dos campos. Nada precisa ser programado do nosso lado.

const crypto = require('crypto');
const { request } = require('./_http');

module.exports = {
  provider: 'webhook',
  label: 'Webhook / Qualquer sistema',
  descricao:
    'Envia o lead para qualquer URL. Use para CRMs sem conector pronto, ' +
    'automações (Zapier, Make, n8n) ou sistemas internos.',
  campos: [
    { nome: 'url', label: 'URL de destino', tipo: 'text', obrigatorio: true },
    { nome: 'metodo', label: 'Método HTTP', tipo: 'select', opcoes: ['POST', 'PUT', 'PATCH'], padrao: 'POST' },
    { nome: 'auth_header', label: 'Cabeçalho de autenticação', tipo: 'text', obrigatorio: false,
      ajuda: 'Ex: Authorization' },
    { nome: 'auth_value', label: 'Valor do cabeçalho', tipo: 'password', obrigatorio: false,
      ajuda: 'Ex: Bearer abc123' },
    { nome: 'secret', label: 'Segredo para assinatura HMAC', tipo: 'password', obrigatorio: false,
      ajuda: 'Se informado, enviamos X-ConversIA-Signature para você validar a origem' },
    { nome: 'formato', label: 'Formato do corpo', tipo: 'select', opcoes: ['completo', 'plano'], padrao: 'completo',
      ajuda: '"plano" envia os campos na raiz do JSON — mais fácil para Zapier/Make' }
  ],

  async test({ url }) {
    if (!/^https?:\/\//.test(url || '')) throw new Error('Informe uma URL http(s) válida');
    return { ok: true, aviso: 'URL válida. O teste real acontece no primeiro envio.' };
  },

  async push(event, lead, config) {
    const payload = config.formato === 'plano'
      ? { evento: event, ...lead, qualificacao: undefined, ...(lead.qualificacao || {}), ...(lead._custom || {}) }
      : { event, timestamp: new Date().toISOString(), data: { ...lead, ...(lead._custom || {}) } };

    const bodyStr = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json', 'X-ConversIA-Event': event };

    if (config.auth_header && config.auth_value) headers[config.auth_header] = config.auth_value;

    if (config.secret) {
      const ts = Math.floor(Date.now() / 1000);
      headers['X-ConversIA-Timestamp'] = String(ts);
      headers['X-ConversIA-Signature'] =
        'sha256=' + crypto.createHmac('sha256', config.secret).update(`${ts}.${bodyStr}`).digest('hex');
    }

    const res = await request(config.url, {
      method: config.metodo || 'POST',
      headers,
      body: bodyStr,
      timeoutMs: 15000
    });

    return { externalId: res.body?.id || null, status: res.status, request: payload, response: res.body };
  }
};
