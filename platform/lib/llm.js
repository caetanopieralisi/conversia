// =============================================================================
// Camada de LLM — abstrai o provedor para que trocar de modelo seja uma coluna
// no banco, não um redeploy. Suporta OpenAI, Anthropic e qualquer endpoint
// compatível com a API da OpenAI (Groq, DeepSeek, OpenRouter, vLLM local...).
//
// Tudo aqui é normalizado para o formato de "tool calling" da OpenAI, que é o
// que o orquestrador consome. O adaptador da Anthropic traduz nos dois sentidos.
// =============================================================================

const { withRetry, TimeoutError } = require('./retry');

// Preço por 1 milhão de tokens (USD). Usado só para estimar custo no painel —
// se estiver desatualizado o agente continua funcionando, só o relatório fica
// impreciso. Sobrescreva com a variável de ambiente LLM_PRICING (JSON).
const DEFAULT_PRICING = {
  'gpt-4.1':               { in: 2.00,  out: 8.00 },
  'gpt-4.1-mini':          { in: 0.40,  out: 1.60 },
  'gpt-4.1-nano':          { in: 0.10,  out: 0.40 },
  'gpt-4o':                { in: 2.50,  out: 10.00 },
  'gpt-4o-mini':           { in: 0.15,  out: 0.60 },
  'claude-sonnet-4':       { in: 3.00,  out: 15.00 },
  'claude-haiku-4':        { in: 0.80,  out: 4.00 },
  'text-embedding-3-small':{ in: 0.02,  out: 0 },
  'whisper-1':             { in: 0,     out: 0 }
};

function pricing() {
  if (!process.env.LLM_PRICING) return DEFAULT_PRICING;
  try {
    return { ...DEFAULT_PRICING, ...JSON.parse(process.env.LLM_PRICING) };
  } catch {
    return DEFAULT_PRICING;
  }
}

function estimateCost(model, tokensIn, tokensOut) {
  const table = pricing();
  // casa por prefixo: "gpt-4.1-mini-2025-04-14" usa o preço de "gpt-4.1-mini"
  const key = Object.keys(table)
    .filter(k => (model || '').startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const p = table[key];
  return Number((((tokensIn || 0) * p.in + (tokensOut || 0) * p.out) / 1e6).toFixed(6));
}

async function fetchJson(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      const err = new Error(body?.error?.message || body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      // 429 e 5xx são transitórios; 4xx restante é erro de configuração nosso
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new TimeoutError(`Tempo esgotado após ${timeoutMs}ms em ${url}`);
      err.retryable = true;
      throw err;
    }
    if (e.retryable === undefined) e.retryable = true; // erro de rede
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Adaptador OpenAI (e compatíveis)
// -----------------------------------------------------------------------------
async function callOpenAI({ apiKey, baseUrl, model, system, messages, tools, temperature, maxTokens, timeoutMs }) {
  const body = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: temperature ?? 0.6,
    max_tokens: maxTokens ?? 800
  };
  if (tools?.length) {
    body.tools = tools.map(t => ({ type: 'function', function: t }));
    body.tool_choice = 'auto';
  }

  const started = Date.now();
  const data = await fetchJson(
    `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    },
    timeoutMs
  );

  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  return {
    content: msg.content || '',
    toolCalls: (msg.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      arguments: safeParse(tc.function?.arguments)
    })),
    finishReason: choice?.finish_reason,
    usage: {
      tokensIn: data.usage?.prompt_tokens ?? null,
      tokensOut: data.usage?.completion_tokens ?? null
    },
    model: data.model || model,
    latencyMs: Date.now() - started,
    raw: msg
  };
}

// -----------------------------------------------------------------------------
// Adaptador Anthropic — traduz do formato OpenAI e volta
// -----------------------------------------------------------------------------
async function callAnthropic({ apiKey, baseUrl, model, system, messages, tools, temperature, maxTokens, timeoutMs }) {
  const converted = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      // resultado de ferramenta vira um bloco tool_result dentro de uma msg do user
      const last = converted[converted.length - 1];
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') };
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else converted.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || tc.name,
          input: safeParse(tc.function?.arguments ?? tc.arguments) || {}
        });
      }
      converted.push({ role: 'assistant', content: blocks });
    } else {
      converted.push({ role: m.role, content: String(m.content ?? '') });
    }
  }

  const body = {
    model,
    system,
    messages: converted,
    max_tokens: maxTokens ?? 800,
    temperature: temperature ?? 0.6
  };
  if (tools?.length) {
    body.tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  }

  const started = Date.now();
  const data = await fetchJson(
    `${baseUrl || 'https://api.anthropic.com/v1'}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    },
    timeoutMs
  );

  const blocks = data.content || [];
  return {
    content: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
    toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({
      id: b.id,
      name: b.name,
      arguments: b.input || {}
    })),
    finishReason: data.stop_reason,
    usage: {
      tokensIn: data.usage?.input_tokens ?? null,
      tokensOut: data.usage?.output_tokens ?? null
    },
    model: data.model || model,
    latencyMs: Date.now() - started,
    raw: data
  };
}

function safeParse(s) {
  if (!s) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

// -----------------------------------------------------------------------------
// Ponto de entrada único
// -----------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {'openai'|'anthropic'|'compatible'} opts.provider
 * @param {string} opts.model
 * @param {string} opts.system         prompt de sistema
 * @param {Array}  opts.messages       histórico no formato OpenAI
 * @param {Array}  [opts.tools]        [{ name, description, parameters }]
 * @returns {Promise<{content, toolCalls, usage, costUsd, latencyMs, model}>}
 */
async function chat(opts) {
  const provider = opts.provider || 'openai';
  const apiKey =
    opts.apiKey ||
    (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);

  if (!apiKey) {
    throw new Error(
      provider === 'anthropic'
        ? 'ANTHROPIC_API_KEY não configurada'
        : 'OPENAI_API_KEY não configurada'
    );
  }

  // OPENAI_BASE_URL / ANTHROPIC_BASE_URL permitem apontar para Azure, um proxy
  // corporativo ou um mock em testes, sem tocar no código.
  const baseUrl =
    opts.baseUrl ||
    (provider === 'compatible' ? process.env.LLM_BASE_URL : undefined) ||
    (provider === 'anthropic' ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL);
  const impl = provider === 'anthropic' ? callAnthropic : callOpenAI;

  const result = await withRetry(
    () => impl({ ...opts, apiKey, baseUrl, timeoutMs: opts.timeoutMs ?? 60000 }),
    { attempts: 3, baseDelayMs: 700, shouldRetry: e => e.retryable !== false }
  );

  result.costUsd = estimateCost(result.model, result.usage.tokensIn, result.usage.tokensOut);
  return result;
}

// -----------------------------------------------------------------------------
// Embeddings
// -----------------------------------------------------------------------------
async function embed(texts, { model = 'text-embedding-3-small', apiKey } = {}) {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY não configurada');
  const input = Array.isArray(texts) ? texts : [texts];

  const data = await withRetry(
    () => fetchJson(
      `${process.env.EMBEDDINGS_BASE_URL || 'https://api.openai.com/v1'}/embeddings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input })
      },
      45000
    ),
    { attempts: 3, baseDelayMs: 700, shouldRetry: e => e.retryable !== false }
  );

  return {
    embeddings: data.data.map(d => d.embedding),
    usage: { tokensIn: data.usage?.prompt_tokens ?? null, tokensOut: 0 },
    model
  };
}

module.exports = { chat, embed, estimateCost, fetchJson };
