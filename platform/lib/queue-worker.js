// =============================================================================
// Worker da fila de entrada.
//
// Pega as conversas cujo debounce venceu e manda o agente responder.
// Funciona nos dois modos de hospedagem, sem mudar nada no código:
//
//   • VPS / Docker (processo longo)  -> loop interno, acorda a cada 3s
//   • Vercel / serverless            -> o cron chama tick() a cada minuto
//
// O lock é feito no próprio banco com `FOR UPDATE SKIP LOCKED`. É o que permite
// rodar várias instâncias da aplicação em paralelo sem que duas respondam a
// mesma conversa — sem precisar de Redis nem fila externa.
// =============================================================================

const pool = require('../db');

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_ATTEMPTS = 3;

let running = false;
let loopTimer = null;

/**
 * Reserva até `limit` conversas prontas para processar.
 * SKIP LOCKED = quem chegou depois pula a linha travada em vez de esperar.
 */
async function claim(limit = 5) {
  const { rows } = await pool.query(
    `with pronto as (
       select id from public.inbound_queue
        where status = 'pending' and process_after <= now()
        order by process_after asc
        limit $1
        for update skip locked
     )
     update public.inbound_queue q
        set status = 'processing', locked_at = now(), locked_by = $2,
            attempts = q.attempts + 1, updated_at = now()
       from pronto
      where q.id = pronto.id
      returning q.*`,
    [limit, WORKER_ID]
  );
  return rows;
}

/** Devolve à fila o que ficou preso (processo morreu no meio). */
async function reclaimStale() {
  const { rowCount } = await pool.query(
    `update public.inbound_queue
        set status = 'pending', locked_at = null, locked_by = null, updated_at = now()
      where status = 'processing'
        and locked_at < now() - interval '5 minutes'
        and attempts < $1`,
    [MAX_ATTEMPTS]
  );
  if (rowCount) console.warn(`[worker] ${rowCount} conversa(s) presa(s) devolvida(s) à fila`);

  // Estourou as tentativas: marca erro e avisa, em vez de tentar para sempre.
  const { rows } = await pool.query(
    `update public.inbound_queue
        set status = 'error', last_error = coalesce(last_error, 'excedeu tentativas'), updated_at = now()
      where status = 'processing' and locked_at < now() - interval '5 minutes' and attempts >= $1
      returning client_id, phone, last_error`,
    [MAX_ATTEMPTS]
  );
  for (const r of rows) {
    await pool.query(
      `insert into public.agent_alerts (client_id, message, level) values ($1,$2,'error')`,
      [r.client_id, `Não foi possível responder ${r.phone} após ${MAX_ATTEMPTS} tentativas: ${r.last_error}`]
    ).catch(() => {});
  }
}

async function processOne(item) {
  // require tardio: evita ciclo de importação com o orquestrador
  const orchestrator = require('./agent/orchestrator');

  // Junta tudo que chegou e ainda não foi respondido — é o "Agrupa mensagens"
  const { rows: pendentes } = await pool.query(
    `select id, content, transcript from public.messages
      where client_id = $1 and phone = $2 and direction = 'inbound' and processed = false
      order by created_at asc`,
    [item.client_id, item.phone]
  );

  if (!pendentes.length) {
    await pool.query(`update public.inbound_queue set status = 'done', updated_at = now() where id = $1`, [item.id]);
    return { skipped: 'sem_mensagens' };
  }

  const texto = pendentes
    .map(m => m.transcript || m.content)
    .filter(Boolean)
    .join('\n')
    .trim();

  const ids = pendentes.map(m => m.id);

  // Marca como processadas ANTES de responder, para que uma segunda passada não
  // responda duas vezes ao mesmo texto.
  //
  // ATENÇÃO ao par disto lá embaixo: se o agente falhar, a marcação PRECISA ser
  // desfeita. Sem isso a mensagem some — a fila devolve o item para 'pending',
  // a repetição não encontra nenhuma mensagem não processada, cai no
  // 'sem_mensagens' e fecha como 'done'. O cliente nunca é respondido e nada
  // aparece como erro. Aconteceu em produção: um timeout de conexão no banco
  // engoliu um "Oi" inteiro.
  //
  // Responder duas vezes não é um risco real aqui: claim() usa
  // `for update skip locked` + locked_by, então duas passadas nunca pegam o
  // mesmo item ao mesmo tempo.
  await pool.query(
    `update public.messages set processed = true where id = any($1::bigint[])`,
    [ids]
  );

  try {
    const result = await orchestrator.respond({
      clientId: item.client_id,
      phone: item.phone,
      text: texto,
      contactName: item.contact_name
    });
    await pool.query(`update public.inbound_queue set status = 'done', updated_at = now() where id = $1`, [item.id]);
    return result;
  } catch (e) {
    // Devolve as mensagens para a fila junto com o item. Best-effort: se este
    // update também falhar, o erro original é o que interessa.
    try {
      await pool.query(
        `update public.messages set processed = false where id = any($1::bigint[])`,
        [ids]
      );
    } catch (e2) {
      console.error('[worker] não consegui desmarcar as mensagens:', e2.message);
    }

    await pool.query(
      `update public.inbound_queue
          set status = $2, last_error = $3, locked_at = null, locked_by = null, updated_at = now()
        where id = $1`,
      [item.id, item.attempts >= MAX_ATTEMPTS ? 'error' : 'pending', String(e.message).slice(0, 500)]
    );
    throw e;
  }
}

/**
 * Uma passada completa. É isto que o motor (n8n) chama a cada poucos segundos.
 *
 * A ORDEM IMPORTA: a fila de saída é drenada ANTES de gerar respostas novas.
 * Entregar o que já está pronto e vencido é mais urgente do que começar uma
 * conversa nova — e é o que mantém o ritmo de digitação fiel.
 *
 * @returns {Promise<{enviadas:number, processadas:number, erros:number}>}
 */
async function tick({ limit = 10, origem = 'desconhecida', drenarSaida = true, limiteSaida = 20 } = {}) {
  if (running) return { processadas: 0, enviadas: 0, erros: 0, skipped: 'ja_rodando' };
  running = true;

  const inicio = Date.now();
  let processadas = 0, erros = 0, enviadas = 0;

  try {
    // --- 1. Entregar o que já venceu -----------------------------------------
    if (drenarSaida) {
      const outbox = require('./outbox');
      try {
        await outbox.destravar();
        const r = await outbox.drain({ limite: limiteSaida });
        enviadas = r.enviadas;
        erros += r.erros;
      } catch (e) {
        console.error('[worker] falha ao drenar a saída:', e.message);
        erros++;
      }
    }

    // --- 2. Gerar respostas novas --------------------------------------------
    await reclaimStale();
    const items = await claim(limit);

    // Sequencial de propósito: cada conversa faz várias chamadas de LLM.
    // Paralelizar aqui estoura o rate limit da OpenAI e da Evolution juntos.
    // Com a fila de saída no lugar, cada item agora custa segundos, não dezenas
    // deles — então a fila não engasga como engasgaria antes.
    for (const item of items) {
      try {
        await processOne(item);
        processadas++;
      } catch (e) {
        erros++;
        console.error(`[worker] erro em ${item.client_id}/${item.phone}:`, e.message);
      }
    }

    // --- 3. Batimento --------------------------------------------------------
    // É o que permite a tela de saúde dizer "o motor parou há 4 minutos" em vez
    // de deixar você adivinhando por que ninguém está sendo respondido.
    await pool.query(
      `insert into public.heartbeat (nome, ultimo_em, origem, detalhe)
       values ('motor', now(), $1, $2::jsonb)
       on conflict (nome) do update set ultimo_em = now(), origem = $1, detalhe = $2::jsonb`,
      [origem, JSON.stringify({ enviadas, processadas, erros, ms: Date.now() - inicio })]
    ).catch(() => {});   // tabela só existe a partir da v7
  } finally {
    running = false;
  }

  return { enviadas, processadas, erros, ms: Date.now() - inicio };
}

/** Modo processo longo: acorda o loop assim que uma mensagem chega. */
function wake() {
  if (process.env.WORKER_MODE === 'cron') return; // serverless: quem manda é o cron
  if (loopTimer) return;
  loopTimer = setTimeout(async () => {
    loopTimer = null;
    try { await tick(); } catch (e) { console.error('[worker] tick falhou:', e.message); }
  }, 1000);
}

/** Loop contínuo, para quando a aplicação roda como processo longo (VPS/Docker). */
function start({ intervalMs = 3000 } = {}) {
  if (process.env.WORKER_MODE === 'cron') {
    console.log('[worker] modo cron — o loop interno não sobe; quem dispara é o motor externo (n8n)');
    return () => {};
  }
  console.log(`[worker] iniciado (${WORKER_ID}), varrendo a cada ${intervalMs}ms`);
  const handle = setInterval(async () => {
    try { await tick({ origem: 'worker-interno' }); }
    catch (e) { console.error('[worker] tick falhou:', e.message); }
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

module.exports = { tick, start, wake, claim, processOne, reclaimStale, WORKER_ID };
