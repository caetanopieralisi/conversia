// =============================================================================
// Orquestrador do agente.
//
// Substitui os nodes do n8n: "Busca Trechos" -> "Gera Embedding" -> "Calcula
// Similaridade" -> "Agente IA" -> "Detecta Handoff" -> "Separa mensagens".
//
// Fluxo:
//   carrega config e estado -> monta contexto (RAG + memória) -> loop de
//   tool-calling -> guardrails -> humaniza -> devolve as mensagens a enviar
//
// PROJETADO PARA NUNCA DEIXAR O CLIENTE SEM RESPOSTA: qualquer falha em qualquer
// etapa degrada para algo útil em vez de estourar. Um agente que fica mudo custa
// o lead; um que responde "vou confirmar e já te falo" mantém a conversa viva.
// =============================================================================

const pool = require('../../db');
const llm = require('../llm');
const evolution = require('../evolution');
const events = require('../events');
const rag = require('./rag');
const tools = require('./tools');
const salesPrompt = require('./salesPrompt');
const humanize = require('./humanize');
const guardrails = require('./guardrails');

const MAX_TOOL_ROUNDS = 4; // teto de idas e voltas com ferramentas por mensagem

/** 'outbox' (padrão) ou 'direct'. Ver o bloco de envio, mais abaixo. */
const deliveryMode = () => (process.env.DELIVERY_MODE || 'outbox').toLowerCase();

// -----------------------------------------------------------------------------

// Antes isto era um Promise.all com as cinco consultas. Parecia mais rápido e
// era: cinco conexões novas abertas no mesmo instante. Em serverless, contra o
// endpoint direto do Postgres, esse disparo simultâneo estourava o
// connectionTimeout e o erro saía como "timeout exceeded when trying to
// connect" — que parece banco fora do ar e é só rajada. Derrubou conversa em
// produção mesmo depois de eu aumentar o pool.
//
// Sequencial, são cinco consultas de índice: algo como 150 ms no total, contra
// uma resposta de IA que leva 1 a 2 segundos. O ganho do paralelo não pagava o
// risco. Uma conexão de cada vez, reaproveitada.
async function loadContext(clientId, phone) {
  const clientRes = await pool.query('select * from public.clients where client_id = $1', [clientId]);
  const stateRes = await pool.query('select * from public.conversation_state where client_id = $1 and phone = $2', [clientId, phone]);
  const leadRes = await pool.query('select * from public.leads where client_id = $1 and phone = $2', [clientId, phone]);
  const assetsRes = await pool.query('select id, name, description, url, mime_type, kind, file_name from public.assets where client_id = $1 and active = true order by id', [clientId]);
  const historyRes = await pool.query(
    `select direction, content, transcript, media_type, created_at
       from public.messages
      where client_id = $1 and phone = $2
      order by created_at desc
      limit 24`,
    [clientId, phone]
  );

  return {
    client: clientRes.rows[0],
    state: stateRes.rows[0] || {},
    lead: leadRes.rows[0] || {},
    assets: assetsRes.rows,
    history: historyRes.rows.reverse()
  };
}

/** Converte o histórico do banco no formato de mensagens do LLM. */
function toLlmMessages(history, currentText) {
  const msgs = [];
  for (const m of history) {
    // O que o cliente mandou em áudio entra como o texto transcrito — é assim que
    // o agente "escuta" sem que nada mais no sistema precise saber disso.
    const content = m.transcript || m.content;
    if (!content || !String(content).trim()) continue;
    msgs.push({ role: m.direction === 'inbound' ? 'user' : 'assistant', content: String(content).slice(0, 4000) });
  }
  // Colapsa turnos consecutivos do mesmo papel (o buffer gera vários inbounds seguidos)
  const collapsed = [];
  for (const m of msgs) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else collapsed.push({ ...m });
  }
  // Garante que a última mensagem é a atual do usuário
  const last = collapsed[collapsed.length - 1];
  if (currentText && (!last || last.role !== 'user' || !last.content.includes(currentText.slice(0, 40)))) {
    collapsed.push({ role: 'user', content: currentText });
  }
  return collapsed.slice(-20);
}

function foraDoHorario(client) {
  const bh = client.business_hours;
  if (!bh?.enabled) return false;
  try {
    const tz = bh.tz || client.timezone || 'America/Sao_Paulo';
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const dia = String(agora.getDay());
    const janela = bh.dias?.[dia];
    if (!janela) return true;
    const [ini, fim] = janela;
    const minutos = agora.getHours() * 60 + agora.getMinutes();
    const toMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
    return minutos < toMin(ini) || minutos >= toMin(fim);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------

/**
 * Gera a resposta do agente para uma conversa.
 *
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.phone
 * @param {string} params.text        texto agregado do buffer (já com áudio transcrito)
 * @param {string} [params.contactName]
 * @param {boolean}[params.dryRun]    true = não envia nada, só devolve (usado pelo simulador)
 * @returns {Promise<{messages: string[], effects: Array, handoff: object|null, usage: Array, trace: Array, stage: string}>}
 */
async function respond({ clientId, phone, text, contactName, dryRun = false }) {
  const started = Date.now();
  const { client, state, lead, assets, history } = await loadContext(clientId, phone);

  if (!client) throw new Error(`Cliente ${clientId} não encontrado`);
  if (!client.active) return { messages: [], skipped: 'cliente_inativo', usage: [], trace: [] };
  if (client.agent_enabled === false) return { messages: [], skipped: 'agente_desligado', usage: [], trace: [] };

  // Garante que existe linha de estado (as ferramentas dão UPDATE nela)
  await pool.query(
    `insert into public.conversation_state (client_id, phone) values ($1,$2)
     on conflict (client_id, phone) do nothing`,
    [clientId, phone]
  );

  // --- Guardrails de entrada -------------------------------------------------
  const bloqueio = await guardrails.checkBefore({ client, state, phone });
  if (bloqueio) {
    return { messages: bloqueio.messages || [], skipped: bloqueio.reason, usage: [], trace: [] };
  }

  // --- Contexto de conhecimento ---------------------------------------------
  const ctxUsage = [];
  let knowledge = '';
  try {
    const found = await rag.search(clientId, text, { limit: 6 });
    knowledge = rag.formatContext(found.chunks);
    if (found.usage) ctxUsage.push(found.usage);
  } catch (e) {
    console.error('[agent] RAG falhou (seguindo sem contexto):', e.message);
  }

  // --- Contexto de execução das ferramentas ---------------------------------
  const ctx = {
    client,
    phone,
    state: { ...state, stage: state.stage || 'abertura' },
    lead,
    collected: { ...(state.collected || {}), ...(lead.qualification || {}) },
    assets,
    effects: [],
    usage: ctxUsage,
    trace: [],
    handoff: null,
    sentAssets: new Set(),
    // usado pelo guardrail de "preço sem base": se nada foi recuperado, qualquer
    // valor que apareça na resposta foi inventado pelo modelo
    knowledgeHadContent: !!knowledge
  };

  const system = salesPrompt.build({
    client,
    state: ctx.state,
    assets,
    knowledge,
    lead,
    foraDoHorario: foraDoHorario(client)
  });

  const messages = toLlmMessages(history, text);
  const toolSchemas = tools.schemasFor(client, assets);

  // --- Loop de tool-calling --------------------------------------------------
  let final = '';
  let rounds = 0;

  try {
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const res = await llm.chat({
        provider: client.llm_provider || 'openai',
        model: client.llm_model || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: Number(client.llm_temperature ?? 0.6),
        system,
        messages,
        tools: toolSchemas,
        maxTokens: 700
      });

      ctx.usage.push({ ...res.usage, model: res.model, kind: 'chat', latencyMs: res.latencyMs, costUsd: res.costUsd });

      if (res.content) final = res.content;

      if (!res.toolCalls?.length) break;

      // Registra a intenção de usar ferramenta no histórico do turno
      messages.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }))
      });

      for (const call of res.toolCalls) {
        const result = await tools.run(call.name, call.arguments, ctx);
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result).slice(0, 4000) });
      }
      // volta ao topo: o modelo agora responde com o resultado em mãos
    }
  } catch (e) {
    console.error('[agent] LLM falhou:', e);
    await pool.query(
      `insert into public.agent_alerts (client_id, message, level) values ($1,$2,'error')`,
      [clientId, `Agente falhou ao responder ${phone}: ${e.message}`]
    ).catch(() => {});

    // Degradação: responde algo humano e chama gente, em vez de sumir.
    const fallback = client.playbook?.mensagem_falha ||
      'Deu uma travada aqui do meu lado, me desculpa. Já pedi pra alguém do time te chamar, tá?';
    if (!dryRun) {
      await deliver({ client, phone, messages: [fallback], contactName });
      await notifyHuman(client, phone, { motivo: `Falha técnica do agente: ${e.message}`, urgencia: 'alta' });
    }
    return { messages: [fallback], effects: [], handoff: { motivo: 'falha_tecnica' }, usage: ctx.usage, trace: ctx.trace, error: e.message };
  }

  // --- Guardrails de saída ---------------------------------------------------
  final = guardrails.checkAfter(final, { client, ctx, history });

  const bubbles = humanize.split(final, { maxBubbles: 4 });

  // Nunca sai vazio: se o modelo só chamou ferramenta e não escreveu nada,
  // ainda assim a pessoa precisa receber alguma coisa.
  if (!bubbles.length) {
    bubbles.push(ctx.handoff
      ? 'Já passei aqui pro time, alguém te chama em instantes.'
      : 'Me dá um minutinho que eu confirmo isso e já te retorno.');
  }

  // --- Persistência do estado ------------------------------------------------
  await pool.query(
    `update public.conversation_state
        set agent_turns = coalesce(agent_turns,0) + 1, last_agent_run = now(), updated_at = now()
      where client_id = $1 and phone = $2`,
    [clientId, phone]
  ).catch(() => {});

  await logUsage(clientId, phone, ctx.usage, Date.now() - started);

  // --- Envio -----------------------------------------------------------------
  // Dois modos, mesma experiência para o cliente final:
  //
  //   outbox (padrão) — enfileira as bolhas com horário de envio e retorna já.
  //                     O drenador manda no ritmo certo. Deixa cada tick curto,
  //                     que é o que permite o motor rodar a cada 5s de graça.
  //   direct          — envia aqui mesmo, dormindo entre as bolhas. Só faz
  //                     sentido em processo longo (VPS) e sem concorrência.
  if (!dryRun) {
    if (deliveryMode() === 'direct') {
      await deliver({ client, phone, messages: bubbles, contactName, effects: ctx.effects });
    } else {
      const outbox = require('../outbox');
      await outbox.enqueueResposta({
        client, phone, messages: bubbles, effects: ctx.effects, contactName
      });
    }
    await runEffects({ client, phone, ctx });
  }

  return {
    messages: bubbles,
    effects: ctx.effects,
    handoff: ctx.handoff,
    usage: ctx.usage,
    trace: ctx.trace,
    stage: ctx.state.stage,
    collected: ctx.collected,
    knowledgeUsed: knowledge ? knowledge.split('\n\n').length : 0,
    latencyMs: Date.now() - started
  };
}

// -----------------------------------------------------------------------------
// Envio pelo WhatsApp
// -----------------------------------------------------------------------------

async function deliver({ client, phone, messages, contactName, effects = [] }) {
  const instance = client.evolution_instance;
  if (!instance) throw new Error(`Cliente ${client.client_id} sem evolution_instance configurada`);

  for (let i = 0; i < messages.length; i++) {
    const text = messages[i];
    const delay = humanize.typingDelay(text);

    await evolution.sendPresence(instance, phone, 'composing', delay);
    await new Promise(r => setTimeout(r, delay));

    try {
      await evolution.sendText(instance, phone, text);
    } catch (e) {
      console.error('[agent] falha ao enviar mensagem:', e.message);
      await pool.query(
        `insert into public.agent_alerts (client_id, message, level) values ($1,$2,'error')`,
        [client.client_id, `Falha ao enviar WhatsApp para ${phone}: ${e.message}`]
      ).catch(() => {});
      break; // não insiste nas seguintes: a instância provavelmente caiu
    }

    await pool.query(
      `insert into public.messages (client_id, phone, contact_name, direction, content, processed, author, created_at)
       values ($1,$2,$3,'outbound',$4,true,'agent',now())`,
      [client.client_id, phone, contactName || null, text]
    ).catch(() => {});
  }

  // Arquivos vão DEPOIS do texto: a legenda explica o anexo antes dele chegar.
  for (const effect of effects.filter(e => e.type === 'asset')) {
    await sendAsset(client, phone, effect.asset, effect.caption);
  }
}

async function sendAsset(client, phone, asset, caption) {
  const instance = client.evolution_instance;
  try {
    if (asset.kind === 'audio') {
      await evolution.sendAudio(instance, phone, asset.url);
    } else {
      await evolution.sendMedia(instance, phone, {
        mediatype: asset.kind === 'image' ? 'image' : asset.kind === 'video' ? 'video' : 'document',
        media: asset.url,
        mimetype: asset.mime_type,
        fileName: asset.file_name || asset.name,
        caption: caption || ''
      });
    }
    await pool.query('update public.assets set send_count = coalesce(send_count,0) + 1 where id = $1', [asset.id]);
    await pool.query(
      `insert into public.messages (client_id, phone, direction, content, media_url, media_type, processed, author, created_at)
       values ($1,$2,'outbound',$3,$4,$5,true,'agent',now())`,
      [client.client_id, phone, `[${asset.kind}] ${asset.name}${caption ? ' — ' + caption : ''}`, asset.url, asset.kind]
    );
    await events.record(client.client_id, phone, 'asset.sent', { asset_id: asset.id, name: asset.name });
  } catch (e) {
    console.error('[agent] falha ao enviar arquivo:', e.message);
    await pool.query(
      `insert into public.agent_alerts (client_id, message, level) values ($1,$2,'warning')`,
      [client.client_id, `Falha ao enviar o arquivo "${asset.name}" para ${phone}: ${e.message}`]
    ).catch(() => {});
  }
}

async function runEffects({ client, phone, ctx }) {
  for (const effect of ctx.effects) {
    if (effect.type === 'handoff') {
      await notifyHuman(client, phone, effect);
    } else if (effect.type === 'event') {
      await events.record(client.client_id, phone, effect.event, effect.payload, { sync: true });
    }
  }
}

async function notifyHuman(client, phone, { motivo, urgencia, resumo }) {
  await pool.query(
    `update public.leads set status = 'aguardando_humano' where client_id = $1 and phone = $2`,
    [client.client_id, phone]
  ).catch(() => {});

  // Pausa o bot por 2h: se um humano assumiu, o agente responder por cima é pior
  // do que não responder. Passadas 2h sem ninguém agir, ele volta sozinho.
  await pool.query(
    `insert into public.conversation_state (client_id, phone, paused, paused_by, paused_until, stage, updated_at)
     values ($1,$2,true,'agent:handoff', now() + interval '2 hours','humano', now())
     on conflict (client_id, phone) do update
        set paused = true, paused_by = 'agent:handoff',
            paused_until = now() + interval '2 hours', stage = 'humano', updated_at = now()`,
    [client.client_id, phone]
  ).catch(() => {});

  const destino = client.numero_responsavel || client.owner_phone;
  if (destino && client.evolution_instance) {
    const { rows } = await pool.query(
      'select name, email, qualification from public.leads where client_id = $1 and phone = $2',
      [client.client_id, phone]
    );
    const lead = rows[0] || {};
    const dados = Object.entries(lead.qualification || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    const texto = [
      urgencia === 'alta' ? '🔴 *ATENDIMENTO URGENTE*' : '🟡 *Transferência para humano*',
      '',
      `*Contato:* ${lead.name || 'sem nome'}`,
      `*WhatsApp:* ${evolution.toNumber(phone)}`,
      lead.email ? `*E-mail:* ${lead.email}` : '',
      '',
      `*Motivo:* ${motivo}`,
      resumo ? `\n*Resumo:* ${resumo}` : '',
      dados ? `\n*Já levantado:*\n${dados}` : '',
      '',
      '_O agente está pausado nesta conversa por 2h._'
    ].filter(Boolean).join('\n');

    await evolution.sendText(client.evolution_instance, destino, texto).catch(e =>
      console.error('[agent] falha ao notificar humano:', e.message)
    );
  }

  await events.record(client.client_id, phone, 'handoff.requested', { motivo, urgencia, resumo }, { sync: true });
}

async function logUsage(clientId, phone, usage, latencyMs) {
  for (const u of usage) {
    await pool.query(
      `insert into public.usage_log (client_id, phone, tokens_in, tokens_out, model, cost_usd, kind, latency_ms, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
      [clientId, phone, u.tokensIn || 0, u.tokensOut || 0, u.model || null, u.costUsd || null, u.kind || 'chat', u.latencyMs || latencyMs]
    ).catch(() => {});
  }
}

module.exports = { respond, deliver, sendAsset, notifyHuman, loadContext, foraDoHorario, toLlmMessages };
