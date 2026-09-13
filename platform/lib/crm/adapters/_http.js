// Cliente HTTP compartilhado pelos adaptadores de CRM.
// Timeout curto e erro com corpo legível: quando a integração de um cliente
// quebra, a mensagem no painel precisa dizer o que o CRM respondeu.

const { withRetry } = require('../../retry');

class HttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.retryable = status === 429 || status >= 500;
  }
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 2 } = {}) {
  return withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal
      });
      const text = await res.text();
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
      if (!res.ok) {
        const msg =
          parsed?.message || parsed?.error?.message || parsed?.error ||
          parsed?.errors?.[0]?.message || `HTTP ${res.status}`;
        throw new HttpError(String(msg).slice(0, 300), res.status, parsed);
      }
      return { status: res.status, body: parsed };
    } catch (e) {
      if (e.name === 'AbortError') throw new HttpError(`Timeout após ${timeoutMs}ms`, 408);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }, { attempts: retries + 1, baseDelayMs: 800, shouldRetry: e => e.retryable !== false });
}

module.exports = { request, HttpError };
