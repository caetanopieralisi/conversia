// =============================================================================
// Mídia recebida: áudio e imagem.
//
// É isso que faz o agente "escutar áudio". O truque é que nada mais no sistema
// precisa saber que houve áudio: a transcrição é gravada na coluna `transcript`
// da mensagem, e o orquestrador já lê `transcript || content`. Para o cérebro do
// agente, um áudio é apenas mais um texto.
//
// Mesma ideia para imagem: uma foto vira uma descrição em texto. Se o cliente
// manda a foto de um produto, de um documento ou de um print de erro, o agente
// "vê" e responde sobre aquilo.
// =============================================================================

const { withRetry } = require('./retry');
const evolution = require('./evolution');
const llm = require('./llm');

const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // limite prático da API de transcrição

/**
 * Transcreve um áudio.
 * @param {Buffer} buffer
 * @param {string} [mimetype]
 * @returns {Promise<{text: string, usage: object}>}
 */
async function transcribe(buffer, mimetype = 'audio/ogg') {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada');
  if (!buffer?.length) throw new Error('Áudio vazio');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('Áudio grande demais para transcrever');

  const model = process.env.TRANSCRIBE_MODEL || 'whisper-1';
  // O WhatsApp manda voz em OGG/Opus. A extensão precisa bater com o mimetype,
  // senão a API rejeita o arquivo mesmo com o conteúdo correto.
  const ext = mimetype.includes('mp4') || mimetype.includes('m4a') ? 'm4a'
            : mimetype.includes('mpeg') || mimetype.includes('mp3') ? 'mp3'
            : mimetype.includes('wav') ? 'wav'
            : 'ogg';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), `audio.${ext}`);
  form.append('model', model);
  form.append('language', process.env.TRANSCRIBE_LANGUAGE || 'pt');
  // Vocabulário de domínio melhora muito a transcrição de termos de negócio
  form.append('prompt', 'Conversa comercial em português do Brasil pelo WhatsApp.');

  const started = Date.now();
  const data = await withRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetch(
        `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/audio/transcriptions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
          body: form,
          signal: controller.signal
        }
      );
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      if (!res.ok) {
        const err = new Error(body?.error?.message || `HTTP ${res.status}`);
        err.retryable = res.status === 429 || res.status >= 500;
        throw err;
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }, { attempts: 3, baseDelayMs: 800, shouldRetry: e => e.retryable !== false });

  return {
    text: (data.text || '').trim(),
    usage: { kind: 'transcription', model, latencyMs: Date.now() - started, tokensIn: 0, tokensOut: 0 }
  };
}

/**
 * Descreve uma imagem recebida.
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @param {string} [contexto] o que a empresa vende — deixa a descrição útil, não genérica
 */
async function describeImage(buffer, mimetype = 'image/jpeg', contexto = '') {
  const dataUrl = `data:${mimetype};base64,${buffer.toString('base64')}`;

  const res = await llm.chat({
    provider: 'openai',
    model: process.env.VISION_MODEL || 'gpt-4.1-mini',
    system:
      'Você descreve imagens que clientes mandam no WhatsApp de uma empresa. ' +
      'Descreva de forma objetiva e útil para quem vai responder: o que aparece, ' +
      'e qualquer texto legível (transcreva literalmente números, códigos, valores). ' +
      'Se for documento, print de erro ou comprovante, diga isso e transcreva o conteúdo. ' +
      'Máximo 4 linhas. Não invente o que não dá para ver.' +
      (contexto ? `\n\nA empresa atua com: ${contexto}` : ''),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'O que tem nesta imagem?' },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
      ]
    }],
    maxTokens: 300,
    temperature: 0.2
  });

  return { text: res.content.trim(), usage: { ...res.usage, model: res.model, kind: 'vision', costUsd: res.costUsd } };
}

/**
 * Processa a mídia de uma mensagem recebida e devolve o texto equivalente.
 * Nunca estoura: se a transcrição falhar, devolve um marcador que permite ao
 * agente pedir educadamente que a pessoa escreva — bem melhor que ficar mudo.
 *
 * @returns {Promise<{text: string|null, usage: object|null, kind: string, failed?: boolean}>}
 */
async function processInbound({ client, messageKey, mediaType, mimetype }) {
  const kindMap = { audioMessage: 'audio', imageMessage: 'image', videoMessage: 'video', documentMessage: 'document' };
  const kind = kindMap[mediaType] || mediaType;

  if (kind === 'audio' && client.audio_enabled === false) {
    return { text: '[cliente mandou um áudio — a transcrição está desligada nesta conta]', usage: null, kind };
  }
  if (kind === 'image' && client.vision_enabled === false) {
    return { text: '[cliente mandou uma imagem — a leitura de imagem está desligada nesta conta]', usage: null, kind };
  }

  try {
    const { base64, mimetype: mt } = await evolution.getMediaBase64(client.evolution_instance, messageKey);
    if (!base64) throw new Error('A Evolution API não devolveu a mídia');
    const buffer = Buffer.from(base64, 'base64');
    const mime = mt || mimetype;

    if (kind === 'audio') {
      const { text, usage } = await transcribe(buffer, mime || 'audio/ogg');
      return {
        text: text ? `[áudio transcrito] ${text}` : '[áudio sem fala identificável]',
        usage,
        kind
      };
    }

    if (kind === 'image') {
      const { text, usage } = await describeImage(buffer, mime || 'image/jpeg', client.nicho || '');
      return { text: `[imagem recebida] ${text}`, usage, kind };
    }

    if (kind === 'document') {
      return { text: '[o cliente enviou um documento]', usage: null, kind };
    }
    if (kind === 'video') {
      return { text: '[o cliente enviou um vídeo]', usage: null, kind };
    }
    return { text: null, usage: null, kind };
  } catch (e) {
    console.error('[media] falha ao processar', kind, e.message);
    return {
      text: kind === 'audio'
        ? '[o cliente mandou um áudio que não consegui ouvir — peça gentilmente para ele escrever ou reenviar]'
        : `[o cliente mandou ${kind === 'image' ? 'uma imagem' : 'um arquivo'} que não consegui abrir]`,
      usage: null,
      kind,
      failed: true
    };
  }
}

module.exports = { transcribe, describeImage, processInbound };
