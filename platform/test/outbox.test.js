// =============================================================================
// Testes do modo gratuito: fila de saída + motor externo.
//
// O que precisa ser verdade para o plano gratuito funcionar:
//   1. gerar a resposta NÃO envia nada — só enfileira, e é rápido
//   2. o ritmo de digitação vive no send_after, não num sleep
//   3. a ordem das bolhas é respeitada, mesmo com o motor batendo picotado
//   4. um tick nunca demora o suficiente para estourar função serverless
//   5. se um humano assume, o que estava na fila do agente morre
// =============================================================================

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const TEM_BANCO = !!process.env.PGHOST || !!process.env.DATABASE_URL;

process.env.JWT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= 'c'.repeat(64);
process.env.OPENAI_API_KEY ||= 'sk-test-fake';
process.env.EVOLUTION_API_URL ||= 'https://evolution.test';
process.env.EVOLUTION_API_KEY ||= 'fake-key';
process.env.WORKER_MODE = 'cron';
process.env.DELIVERY_MODE = 'outbox';

const chamadas = { evolution: [], openai: [] };
let respostaLLM = null;
const fetchOriginal = globalThis.fetch;

const json = obj => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
const textoLLM = t => ({ message: { role: 'assistant', content: t, tool_calls: [] } });

function instalarMock() {
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    if (u.includes('/embeddings')) {
      const n = Array.isArray(body.input) ? body.input.length : 1;
      return json({ data: Array.from({ length: n }, () => ({ embedding: Array(1536).fill(0.01) })), usage: { prompt_tokens: 5 } });
    }
    if (u.includes('/chat/completions')) {
      chamadas.openai.push(body);
      const r = typeof respostaLLM === 'function' ? respostaLLM() : respostaLLM;
      return json({ model: body.model, choices: [{ message: r.message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40 } });
    }
    if (u.includes('evolution.test')) {
      chamadas.evolution.push({ url: u, body, em: Date.now() });
      return json({ key: { id: 'F' + chamadas.evolution.length } });
    }
    return json({});
  };
}
const reset = () => { chamadas.evolution = []; chamadas.openai = []; };
const envios = () => chamadas.evolution.filter(c => c.url.includes('sendText') || c.url.includes('sendMedia'));

describe('modo gratuito — fila de saída', { skip: !TEM_BANCO ? 'sem banco' : false }, () => {
  let pool, outbox, orchestrator, worker;
  const CLIENT = 'teste_outbox';
  const PHONE = '5511911112222@s.whatsapp.net';

  before(async () => {
    instalarMock();
    pool = require('../db');
    outbox = require('../lib/outbox');
    orchestrator = require('../lib/agent/orchestrator');
    worker = require('../lib/queue-worker');

    await limpar(pool, CLIENT);
    await pool.query("delete from public.inbound_queue where status in ('pending','processing')");
    await pool.query(
      `insert into public.clients
         (client_id, nome_empresa, evolution_instance, numero_responsavel, active, agent_enabled,
          inbound_token, debounce_segundos, llm_model, playbook)
       values ($1,'Outbox Ltda','ob_inst','5517900000000@s.whatsapp.net',true,true,
               'tok_outbox',1,'gpt-4.1-mini','{}'::jsonb)`,
      [CLIENT]
    );
    await pool.query(
      `insert into public.assets (client_id, name, description, url, kind, mime_type, file_name)
       values ($1,'Tabela','quando pedirem preços','https://cdn.test/tab.pdf','document','application/pdf','tabela.pdf')`,
      [CLIENT]
    );
  });

  after(async () => {
    // não fecha o pool aqui: o describe seguinte ainda usa a mesma conexão
    if (pool) await limpar(pool, CLIENT);
  });

  // ---------------------------------------------------------------------------

  test('gerar a resposta enfileira e NÃO envia nada', async () => {
    reset();
    respostaLLM = textoLLM('Oi! Que bom falar com você.\n\nMe conta o que você precisa?');

    const t0 = Date.now();
    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'oi' });
    const durou = Date.now() - t0;

    assert.strictEqual(envios().length, 0, 'enviou durante a geração — deveria só enfileirar');
    assert.strictEqual(r.messages.length, 2);

    const fila = await pool.query(
      `select * from public.outbound_queue where client_id=$1 order by seq`, [CLIENT]);
    assert.strictEqual(fila.rowCount, 2, 'não enfileirou as duas bolhas');
    assert.strictEqual(fila.rows[0].seq, 0);
    assert.strictEqual(fila.rows[1].seq, 1);

    // A geração precisa ser rápida: é o que permite o motor bater a cada 5s.
    assert.ok(durou < 3000, `geração demorou ${durou}ms — deveria ser quase instantânea sem os sleeps`);
  });

  test('o ritmo de digitação vive no send_after, escalonado', async () => {
    const fila = await pool.query(
      `select send_after, content from public.outbound_queue where client_id=$1 order by seq`, [CLIENT]);
    const t1 = new Date(fila.rows[0].send_after).getTime();
    const t2 = new Date(fila.rows[1].send_after).getTime();
    const gap = t2 - t1;
    assert.ok(gap >= 1200 && gap <= 5200, `intervalo entre bolhas de ${gap}ms fora da faixa humana`);
  });

  test('o drenador não envia o que ainda não venceu', async () => {
    reset();
    const r = await outbox.drain();
    assert.strictEqual(r.enviadas, 0, 'enviou bolha antes da hora');
  });

  test('vencido, envia na ordem certa', async () => {
    reset();
    await pool.query(
      `update public.outbound_queue set send_after = now() - interval '1 second' where client_id=$1`, [CLIENT]);

    const r = await outbox.drain();
    assert.ok(r.enviadas >= 2, `esperado 2 envios, veio ${r.enviadas}`);

    const textos = envios().map(e => e.body.text);
    assert.ok(textos[0].includes('Oi!'), `ordem errada: ${JSON.stringify(textos)}`);
    assert.ok(textos[1].includes('Me conta'));

    const pend = await pool.query(
      `select count(*)::int t from public.outbound_queue where client_id=$1 and status='pending'`, [CLIENT]);
    assert.strictEqual(pend.rows[0].t, 0, 'sobrou bolha pendente');

    const msgs = await pool.query(
      `select count(*)::int t from public.messages where client_id=$1 and direction='outbound'`, [CLIENT]);
    assert.strictEqual(msgs.rows[0].t, 2, 'não espelhou as mensagens enviadas');
  });

  test('arquivo entra na fila depois do texto', async () => {
    reset();
    await pool.query('delete from public.outbound_queue where client_id=$1', [CLIENT]);
    const asset = await pool.query('select id from public.assets where client_id=$1', [CLIENT]);

    await outbox.enqueueResposta({
      client: { client_id: CLIENT },
      phone: PHONE,
      messages: ['Segue a tabela!'],
      effects: [{ type: 'asset', asset: { id: Number(asset.rows[0].id) }, caption: 'nossos preços' }]
    });

    const fila = await pool.query(
      `select kind, seq from public.outbound_queue where client_id=$1 order by seq`, [CLIENT]);
    assert.strictEqual(fila.rows[0].kind, 'text');
    assert.strictEqual(fila.rows[1].kind, 'asset');

    await pool.query(`update public.outbound_queue set send_after = now() - interval '1 second' where client_id=$1`, [CLIENT]);
    await outbox.drain();

    const media = chamadas.evolution.filter(c => c.url.includes('sendMedia'));
    assert.strictEqual(media.length, 1, 'arquivo não foi enviado pela fila');
    assert.strictEqual(media[0].body.caption, 'nossos preços');
  });

  test('um tick completo termina rápido — cabe folgado em função serverless', async () => {
    reset();
    await pool.query('delete from public.outbound_queue where client_id=$1', [CLIENT]);
    respostaLLM = textoLLM('Primeira parte da resposta.\n\nSegunda parte.\n\nTerceira parte.');

    // três conversas chegando ao mesmo tempo
    for (const p of ['551191111001@s.whatsapp.net', '551191111002@s.whatsapp.net', '551191111003@s.whatsapp.net']) {
      await pool.query(
        `insert into public.messages (client_id, phone, direction, content, processed, created_at)
         values ($1,$2,'inbound','quero saber mais',false, now())`, [CLIENT, p]);
      await pool.query(
        `insert into public.leads (client_id, phone, status, created_at, last_inbound_at)
         values ($1,$2,'ativo', now(), now()) on conflict do nothing`, [CLIENT, p]);
      await pool.query(
        `insert into public.inbound_queue (client_id, phone, process_after, status)
         values ($1,$2, now() - interval '1 second','pending')
         on conflict (client_id, phone) where status in ('pending','processing')
         do update set process_after = now() - interval '1 second'`, [CLIENT, p]);
    }

    const t0 = Date.now();
    const r = await worker.tick({ limit: 10, origem: 'teste' });
    const durou = Date.now() - t0;

    assert.strictEqual(r.processadas, 3, `processou ${r.processadas} de 3`);
    // Antes da v7 isso levaria 3 conversas × 3 bolhas × ~2s = ~18s de sleep.
    assert.ok(durou < 8000, `tick levou ${durou}ms — longo demais para um motor de 5s`);

    const fila = await pool.query(
      `select count(*)::int t from public.outbound_queue where client_id=$1 and status='pending'`, [CLIENT]);
    assert.strictEqual(fila.rows[0].t, 9, `esperava 9 bolhas na fila, veio ${fila.rows[0].t}`);
  });

  test('o motor grava batimento (a tela de saúde depende disso)', async () => {
    const { rows } = await pool.query(`select origem, ultimo_em from public.heartbeat where nome='motor'`);
    assert.strictEqual(rows[0].origem, 'teste');
    assert.ok(Date.now() - new Date(rows[0].ultimo_em).getTime() < 20000, 'batimento não foi atualizado');
  });

  test('motor picotado entrega tudo, sem duplicar e sem perder ordem', async () => {
    reset();
    await pool.query(`update public.outbound_queue set send_after = now() - interval '1 second' where client_id=$1`, [CLIENT]);

    // Simula o motor do n8n batendo repetidamente. Com o ritmo humano imposto
    // (mínimo 1,2s entre bolhas), 9 bolhas em 3 conversas levam alguns ticks —
    // que é exatamente o comportamento desejado.
    let total = 0;
    const limite = Date.now() + 30000;
    while (total < 9 && Date.now() < limite) {
      total += (await outbox.drain({ limite: 5, tempoMaximoMs: 3000 })).enviadas;
      if (total < 9) await new Promise(r => setTimeout(r, 600));
    }

    assert.strictEqual(total, 9, `entregou ${total} de 9`);

    const restante = await pool.query(
      `select count(*)::int t from public.outbound_queue where client_id=$1 and status='pending'`, [CLIENT]);
    assert.strictEqual(restante.rows[0].t, 0, 'ficou bolha para trás');

    // ordem por conversa
    for (const p of ['551191111001@s.whatsapp.net', '551191111002@s.whatsapp.net']) {
      const desta = envios().filter(e => e.body.number === p.split('@')[0]).map(e => e.body.text);
      if (process.env.DEBUG_ORDEM) console.log(p, JSON.stringify(desta));
      assert.strictEqual(desta.length, 3, `${p} recebeu ${desta.length} mensagens`);
      assert.ok(desta[0].includes('Primeira'), `ordem quebrada em ${p}: ${JSON.stringify(desta)}`);
      assert.ok(desta[2].includes('Terceira'), `ordem quebrada em ${p}`);
    }
  });

  test('atendente humano cancela as bolhas que ainda não saíram', async () => {
    reset();
    await pool.query('delete from public.outbound_queue where client_id=$1', [CLIENT]);
    await outbox.enqueueResposta({
      client: { client_id: CLIENT }, phone: PHONE,
      messages: ['Bolha um.', 'Bolha dois.', 'Bolha três.'], delayInicial: 60000
    });

    const cancel = await outbox.cancelarPendentes(CLIENT, PHONE, 'atendente assumiu');
    assert.strictEqual(cancel, 3);

    await pool.query(`update public.outbound_queue set send_after = now() - interval '1 second' where client_id=$1`, [CLIENT]);
    const r = await outbox.drain();
    assert.strictEqual(r.enviadas, 0, 'enviou bolha do agente depois do humano assumir');
  });

  test('falha de envio não some: volta para a fila e depois vira alerta', async () => {
    reset();
    await pool.query('delete from public.outbound_queue where client_id=$1', [CLIENT]);
    await pool.query(`delete from public.agent_alerts where client_id=$1`, [CLIENT]);

    await outbox.enqueueResposta({
      client: { client_id: CLIENT }, phone: PHONE, messages: ['vai falhar']
    });
    await pool.query(`update public.outbound_queue set send_after = now() - interval '1 second' where client_id=$1`, [CLIENT]);

    const fetchBom = globalThis.fetch;
    globalThis.fetch = async (url, o) => {
      if (String(url).includes('sendText')) return new Response('{"message":"instancia fora do ar"}', { status: 500 });
      return fetchBom(url, o);
    };

    for (let i = 0; i < 3; i++) {
      await pool.query(`update public.outbound_queue set send_after = now() - interval '1 second' where client_id=$1 and status='pending'`, [CLIENT]);
      await outbox.drain();
    }
    globalThis.fetch = fetchBom;

    const linha = await pool.query(`select status, attempts from public.outbound_queue where client_id=$1`, [CLIENT]);
    assert.strictEqual(linha.rows[0].status, 'error', 'deveria ter desistido depois de 3 tentativas');

    const alerta = await pool.query(`select count(*)::int t from public.agent_alerts where client_id=$1`, [CLIENT]);
    assert.ok(alerta.rows[0].t > 0, 'não avisou o admin que a mensagem não foi entregue');
  });

  test('modo direct continua funcionando (VPS)', async () => {
    reset();
    process.env.DELIVERY_MODE = 'direct';
    await pool.query('delete from public.outbound_queue where client_id=$1', [CLIENT]);
    await pool.query(`update public.conversation_state set paused=false, paused_until=null, agent_turns=0 where client_id=$1`, [CLIENT]);
    respostaLLM = textoLLM('Resposta direta.');

    await orchestrator.respond({ clientId: CLIENT, phone: '551191111009@s.whatsapp.net', text: 'oi' });

    assert.ok(envios().length >= 1, 'modo direct não enviou');
    const fila = await pool.query(
      `select count(*)::int t from public.outbound_queue where client_id=$1`, [CLIENT]);
    assert.strictEqual(fila.rows[0].t, 0, 'modo direct não deveria usar a fila');
    process.env.DELIVERY_MODE = 'outbox';
  });
});

async function limpar(pool, clientId) {
  for (const t of ['outbound_queue', 'inbound_queue', 'lead_events', 'agent_alerts', 'usage_log',
                   'messages', 'conversation_state', 'leads', 'knowledge_chunks', 'knowledge_sources',
                   'assets', 'integrations', 'api_keys', 'webhook_endpoints', 'follow_up_rules', 'users']) {
    await pool.query(`delete from public.${t} where client_id = $1`, [clientId]).catch(() => {});
  }
  await pool.query('delete from public.clients where client_id = $1', [clientId]).catch(() => {});
}

// -----------------------------------------------------------------------------
// Regressão: o ritmo humano não pode desaparecer quando o motor atrasa.
// -----------------------------------------------------------------------------
describe('ritmo de digitação sob atraso do motor', { skip: !TEM_BANCO ? 'sem banco' : false }, () => {
  let pool, outbox;
  const CLIENT = 'teste_ritmo';
  const PHONE = '5511955550000@s.whatsapp.net';

  before(async () => {
    instalarMock();
    pool = require('../db');
    outbox = require('../lib/outbox');
    await limpar(pool, CLIENT);
    await pool.query(
      `insert into public.clients (client_id, nome_empresa, evolution_instance, active, inbound_token)
       values ($1,'Ritmo','r_inst',true,'tok_ritmo')`, [CLIENT]);
  });

  after(async () => {
    if (pool) { await limpar(pool, CLIENT); await pool.end().catch(() => {}); }
    globalThis.fetch = fetchOriginal;
  });

  test('três bolhas TODAS vencidas ainda saem espaçadas, não de uma vez', async () => {
    reset();
    await outbox.enqueueResposta({
      client: { client_id: CLIENT }, phone: PHONE,
      messages: [
        'Oi, Joana! Que bom te ver por aqui.',
        'Me conta rapidinho o que você precisa resolver hoje?',
        'Assim eu já te direciono certinho.'
      ]
    });

    // Simula 30s de motor parado. Importante: DESLOCA os horários, não os achata —
    // é assim que a realidade se comporta (cada bolha guarda seu próprio horário,
    // todos no passado). Achatar tudo no mesmo instante testaria outra coisa.
    await pool.query(
      `update public.outbound_queue set send_after = send_after - interval '30 seconds' where client_id=$1`, [CLIENT]);

    const t0 = Date.now();
    let enviadas = 0;
    // motor batendo a cada 5s, como o n8n faz
    for (let i = 0; i < 4 && enviadas < 3; i++) {
      enviadas += (await outbox.drain({ limite: 5, tempoMaximoMs: 8000 })).enviadas;
      if (enviadas < 3) await new Promise(r => setTimeout(r, 300));
    }
    assert.strictEqual(enviadas, 3, 'não entregou as três');

    const envs = envios();
    assert.strictEqual(envs.length, 3);

    for (let i = 1; i < envs.length; i++) {
      const gap = envs[i].em - envs[i - 1].em;
      assert.ok(gap >= 1100,
        `bolhas ${i} e ${i + 1} saíram com ${gap}ms de intervalo — parece robô (mínimo humano ~1,2s)`);
    }
    assert.ok(Date.now() - t0 >= 2400, 'a resposta inteira saiu rápido demais para ser crível');
  });

  test('a ordem continua correta mesmo com o reagendamento', async () => {
    const textos = envios().map(e => e.body.text);
    assert.ok(textos[0].includes('Oi, Joana'), `ordem quebrada: ${JSON.stringify(textos)}`);
    assert.ok(textos[2].includes('direciono'), `ordem quebrada: ${JSON.stringify(textos)}`);
  });
});
