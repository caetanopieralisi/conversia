// =============================================================================
// Guardrails — o que impede o agente de causar prejuízo.
//
// Um agente de vendas erra de formas caras: inventa preço, entra em loop
// repetindo a mesma frase, responde por cima de um humano, vaza dado sensível,
// ou queima orçamento numa conversa que não vai a lugar nenhum.
// Nenhuma dessas coisas é resolvida por prompt. São checagens de código.
// =============================================================================

const pool = require('../../db');

// -----------------------------------------------------------------------------
// ANTES de chamar o modelo
// -----------------------------------------------------------------------------

/**
 * @returns {Promise<null | {reason: string, messages?: string[]}>}
 *          null = pode responder. Objeto = não responde (e por quê).
 */
async function checkBefore({ client, state, phone }) {
  // 1. Conversa pausada (humano assumiu, ou o dono pausou no painel)
  if (state.paused) {
    const expirou = state.paused_until && new Date(state.paused_until) < new Date();
    if (!expirou) return { reason: 'conversa_pausada' };
    // Pausa venceu: religa sozinho, sem ninguém precisar lembrar.
    await pool.query(
      `update public.conversation_state
          set paused = false, paused_by = null, paused_until = null, updated_at = now()
        where client_id = $1 and phone = $2`,
      [client.client_id, phone]
    );
  }

  // 2. Teto de turnos por conversa — evita o bot que conversa para sempre
  const max = client.max_agent_turns || 12;
  if ((state.agent_turns || 0) >= max) {
    return {
      reason: 'limite_de_turnos',
      messages: ['Acho melhor alguém do time falar direto com você pra resolver isso rápido. Já pedi pra te chamarem.']
    };
  }

  // 3. Limite mensal de mensagens do plano do cliente
  if (client.monthly_message_limit > 0) {
    const { rows } = await pool.query(
      `select count(*)::int as total from public.messages
        where client_id = $1 and direction = 'outbound' and created_at >= date_trunc('month', now())`,
      [client.client_id]
    );
    if (rows[0].total >= client.monthly_message_limit) {
      await pool.query(
        `insert into public.agent_alerts (client_id, message, level) values ($1,$2,'warning')`,
        [client.client_id, `Limite mensal de ${client.monthly_message_limit} mensagens atingido — o agente parou de responder.`]
      ).catch(() => {});
      return { reason: 'limite_mensal_atingido' };
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// DEPOIS do modelo responder
// -----------------------------------------------------------------------------

// Padrões que nunca devem sair, independentemente do que o modelo gerou.
const PROIBIDO = [
  { re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, nome: 'CPF' },
  { re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, nome: 'cartão' },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, nome: 'chave de API' },
  { re: /\b(?:agência|ag\.?)\s*\d{4}[\s-]*(?:conta|c\/c)\s*[\d-]{5,}/gi, nome: 'dados bancários' }
];

/**
 * @param {string} text  resposta crua do modelo
 * @returns {string}     resposta saneada
 */
function checkAfter(text, { client, ctx, history = [] }) {
  let out = String(text || '');

  // 1. Vazamento de dado sensível
  for (const p of PROIBIDO) {
    if (p.re.test(out)) {
      out = out.replace(p.re, '[removido]');
      console.warn(`[guardrails] ${p.nome} removido da resposta de ${client.client_id}`);
    }
    p.re.lastIndex = 0;
  }

  // 2. Vazamento do prompt de sistema
  if (/(?:meu|o)\s+(?:prompt|system prompt|instruções do sistema)/i.test(out) &&
      out.length > 400) {
    out = 'Isso eu não consigo compartilhar, mas me diz o que você precisa que eu te ajudo.';
  }

  // 3. Loop: repetiu quase igual a uma das últimas respostas
  const anteriores = history
    .filter(m => m.direction === 'outbound')
    .slice(-3)
    .map(m => normalize(m.content));
  const atual = normalize(out);
  if (atual && anteriores.some(a => similarity(a, atual) > 0.85)) {
    console.warn(`[guardrails] resposta repetida detectada em ${client.client_id}`);
    ctx.trace.push({ guardrail: 'resposta_repetida' });
    out = 'Deixa eu tentar de outro jeito: me conta com suas palavras o que você precisa resolver, que eu te direciono certinho.';
  }

  // 4. Preço solto sem base de conhecimento — o erro mais caro que existe.
  // Se o agente citou valor e nada veio da base, o número foi inventado.
  const temValor = /R\$\s?\d/i.test(out);
  const usouBase = ctx.trace.some(t => t.tool === 'buscar_conhecimento' && t.hits > 0);
  if (temValor && !usouBase && !ctx.knowledgeHadContent) {
    console.warn(`[guardrails] valor citado sem base em ${client.client_id}`);
    ctx.trace.push({ guardrail: 'preco_sem_base' });
    out = out.replace(/R\$\s?[\d.,]+(?:\s?(?:mil|milhões?))?/gi, 'um valor que eu preciso confirmar');
  }

  return out.trim();
}

// -----------------------------------------------------------------------------

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similaridade por sobreposição de trigramas (Dice). Barato e suficiente aqui. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = s => {
    const set = new Set();
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

module.exports = { checkBefore, checkAfter, similarity, normalize, PROIBIDO };
