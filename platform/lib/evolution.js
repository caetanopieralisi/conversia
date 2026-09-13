// =============================================================================
// Cliente da Evolution API v2.
//
// Concentra num só lugar tudo que fala com o WhatsApp. Antes isso estava
// espalhado em 3 arquivos de rota + 6 nodes do n8n, cada um com seu próprio
// tratamento de erro (ou nenhum).
//
// Endpoints conforme doc.evolution-api.com (v2):
//   POST /instance/create
//   GET  /instance/connect/{instance}          -> QR code
//   GET  /instance/connectionState/{instance}
//   POST /webhook/set/{instance}
//   POST /message/sendText/{instance}
//   POST /message/sendMedia/{instance}
//   POST /message/sendWhatsAppAudio/{instance}
//   POST /chat/sendPresence/{instance}
//   POST /chat/getBase64FromMediaMessage/{instance}
//   POST /chat/markMessageAsRead/{instance}
// =============================================================================

const { withRetry } = require('./retry');

const BASE = () => (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.EVOLUTION_API_KEY;

class EvolutionError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'EvolutionError';
    this.status = status;
    this.body = body;
    // 401/403 = chave errada, 404 = instância não existe: repetir não adianta
    this.retryable = status === 429 || status >= 500 || status === undefined;
  }
}

async function call(path, { method = 'POST', body, timeoutMs = 30000 } = {}) {
  if (!BASE() || !KEY()) {
    throw new EvolutionError('EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurados', 500);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', apikey: KEY() },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      throw new EvolutionError(
        data?.response?.message?.[0] || data?.message || `HTTP ${res.status}`,
        res.status,
        data
      );
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new EvolutionError(`Timeout após ${timeoutMs}ms`, undefined);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const retrying = fn => withRetry(fn, { attempts: 3, baseDelayMs: 600, shouldRetry: e => e.retryable !== false });

// -----------------------------------------------------------------------------
// Normalização de número
// -----------------------------------------------------------------------------
// O banco guarda o JID completo ("5517999999999@s.whatsapp.net") porque é o que a
// Evolution manda no webhook. Os endpoints de envio querem só os dígitos.
// Grupos (@g.us) mantêm o sufixo.
function toNumber(phoneOrJid) {
  const s = String(phoneOrJid || '');
  if (s.includes('@g.us')) return s;
  return s.split('@')[0].replace(/\D/g, '');
}

// -----------------------------------------------------------------------------
// Envio
// -----------------------------------------------------------------------------

async function sendText(instance, to, text, { delay, quotedId } = {}) {
  return retrying(() => call(`/message/sendText/${encodeURIComponent(instance)}`, {
    body: {
      number: toNumber(to),
      text,
      ...(delay ? { delay } : {}),
      ...(quotedId ? { quoted: { key: { id: quotedId } } } : {})
    }
  }));
}

/**
 * Envia imagem, vídeo ou documento.
 * @param {'image'|'video'|'document'} mediatype
 * @param {string} media  URL pública OU base64 puro (sem o prefixo data:)
 */
async function sendMedia(instance, to, { mediatype, media, mimetype, fileName, caption, delay } = {}) {
  return retrying(() => call(`/message/sendMedia/${encodeURIComponent(instance)}`, {
    body: {
      number: toNumber(to),
      mediatype: mediatype || 'document',
      media,
      mimetype: mimetype || guessMime(fileName, mediatype),
      fileName: fileName || 'arquivo',
      caption: caption || '',
      ...(delay ? { delay } : {})
    },
    timeoutMs: 60000
  }));
}

/** Áudio de voz (PTT — aparece como a bolinha de gravação, não como arquivo). */
async function sendAudio(instance, to, audioUrlOrBase64, { delay } = {}) {
  return retrying(() => call(`/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, {
    body: { number: toNumber(to), audio: audioUrlOrBase64, ...(delay ? { delay } : {}) },
    timeoutMs: 60000
  }));
}

/**
 * "digitando..." — é o detalhe que mais faz o atendimento parecer humano.
 * Falha aqui nunca deve derrubar o envio da mensagem, então não propaga erro.
 */
async function sendPresence(instance, to, presence = 'composing', delay = 1500) {
  try {
    await call(`/chat/sendPresence/${encodeURIComponent(instance)}`, {
      body: { number: toNumber(to), presence, delay },
      timeoutMs: 8000
    });
  } catch { /* cosmético: ignora */ }
}

async function markAsRead(instance, { remoteJid, messageId, fromMe = false }) {
  try {
    await call(`/chat/markMessageAsRead/${encodeURIComponent(instance)}`, {
      body: { readMessages: [{ remoteJid, id: messageId, fromMe }] },
      timeoutMs: 8000
    });
  } catch { /* cosmético: ignora */ }
}

/** Baixa a mídia de uma mensagem recebida e devolve base64. */
async function getMediaBase64(instance, messageKeyOrId) {
  const message = typeof messageKeyOrId === 'string'
    ? { key: { id: messageKeyOrId } }
    : { key: messageKeyOrId };
  const data = await retrying(() => call(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    body: { message, convertToMp4: false },
    timeoutMs: 60000
  }));
  return {
    base64: data.base64 || data.media || null,
    mimetype: data.mimetype || data.mimeType || null,
    fileName: data.fileName || null
  };
}

// -----------------------------------------------------------------------------
// Gestão de instância (usado pelo onboarding em 1 clique)
// -----------------------------------------------------------------------------

async function createInstance(instanceName, { webhookUrl, events } = {}) {
  return call('/instance/create', {
    body: {
      instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      ...(webhookUrl ? {
        webhook: {
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: events || ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']
        }
      } : {})
    },
    timeoutMs: 45000
  });
}

/** Retorna o QR code (base64/pairing code) para escanear. */
async function connect(instanceName) {
  return call(`/instance/connect/${encodeURIComponent(instanceName)}`, { method: 'GET', timeoutMs: 30000 });
}

async function connectionState(instanceName) {
  return call(`/instance/connectionState/${encodeURIComponent(instanceName)}`, { method: 'GET', timeoutMs: 15000 });
}

async function setWebhook(instanceName, url, events) {
  // Versões diferentes da Evolution aceitam o corpo com ou sem o wrapper "webhook".
  // Tenta o formato novo e cai no antigo se ele reclamar do schema.
  const payload = {
    enabled: true,
    url,
    webhookByEvents: false,
    webhookBase64: false,
    events: events || ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']
  };
  try {
    return await call(`/webhook/set/${encodeURIComponent(instanceName)}`, { body: { webhook: payload } });
  } catch (e) {
    if (e.status === 400 || e.status === 404) {
      return call(`/webhook/set/${encodeURIComponent(instanceName)}`, { body: payload });
    }
    throw e;
  }
}

async function deleteInstance(instanceName) {
  return call(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: 'DELETE', timeoutMs: 20000 });
}

async function logout(instanceName) {
  return call(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: 'DELETE', timeoutMs: 20000 });
}

// -----------------------------------------------------------------------------

const MIME_BY_EXT = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  csv: 'text/csv', txt: 'text/plain', zip: 'application/zip'
};

function guessMime(fileName, mediatype) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (mediatype === 'image') return 'image/jpeg';
  if (mediatype === 'video') return 'video/mp4';
  return 'application/octet-stream';
}

module.exports = {
  sendText, sendMedia, sendAudio, sendPresence, markAsRead, getMediaBase64,
  createInstance, connect, connectionState, setWebhook, deleteInstance, logout,
  toNumber, guessMime, EvolutionError, isConfigured: () => !!(BASE() && KEY())
};
