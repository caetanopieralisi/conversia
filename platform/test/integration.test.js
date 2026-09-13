// =============================================================================
// Teste de integração ponta a ponta.
//
// Percorre o caminho real: webhook da Evolution -> fila -> orquestrador ->
// RAG -> ferramentas -> guardrails -> envio. Banco de verdade; apenas as
// chamadas de rede (OpenAI e Evolution API) são simuladas.
//
// Rodar:
//   DATABASE_URL=postgres://... node --test test/integration.test.js
// Se a variável não estiver definida, os testes são pulados (não quebram o CI).
// =============================================================================

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const TEM_BANCO = !!process.env.PGHOST || !!process.env.DATABASE_URL;

process.env.JWT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
process.env.OPENAI_API_KEY ||= 'sk-test-fake';
process.env.EVOLUTION_API_URL ||= 'https://evolution.test';
process.env.EVOLUTION_API_KEY ||= 'fake-key';
process.env.WORKER_MODE = 'cron';   // não inicia o loop interno durante o teste

// -----------------------------------------------------------------------------
// Simulação da rede
// -----------------------------------------------------------------------------

const chamadas = { openai: [], evolution: [], outros: [] };
let respostaLLM = null;   // define o que o "modelo" responde em cada teste

const fetchOriginal = globalThis.fetch;

function instalarMock() {
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body;

    if (u.includes('/embeddings')) {
      chamadas.openai.push({ tipo: 'embedding', body });
      const n = Array.isArray(body.input) ? body.input.length : 1;
      return json({
        data: Array.from({ length: n }, () => ({ embedding: Array(1536).fill(0.01) })),
        usage: { prompt_tokens: 10 }
      });
    }

    if (u.includes('/chat/completions')) {
      chamadas.openai.push({ tipo: 'chat', body });
      const r = typeof respostaLLM === 'function' ? respostaLLM(chamadas.openai.length, body) : respostaLLM;
      return json({
        model: body.model,
        choices: [{ message: r.message, finish_reason: r.finish_reason || 'stop' }],
        usage: { prompt_tokens: 500, completion_tokens: 80 }
      });
    }

    if (u.includes('evolution.test')) {
      chamadas.evolution.push({ url: u, body });
      if (u.includes('getBase64FromMediaMessage')) {
        return json({ base64: Buffer.from('audio-falso').toString('base64'), mimetype: 'audio/ogg' });
      }
      return json({ key: { id: 'FAKE' + chamadas.evolution.length }, status: 'PENDING' });
    }

    if (u.includes('/audio/transcriptions')) {
      chamadas.openai.push({ tipo: 'transcricao' });
      return json({ text: 'quanto custa o plano essencial?' });
    }

    chamadas.outros.push(u);
    return json({});
  };
}

const json = obj => new Response(JSON.stringify(obj), {
  status: 200, headers: { 'Content-Type': 'application/json' }
});

const resetChamadas = () => { chamadas.openai = []; chamadas.evolution = []; chamadas.outros = []; };

// A partir da v7 o agente ENFILEIRA a resposta; quem envia é o drenador.
// Nos testes, isso vira um passo explícito: vence tudo e drena.
async function entregar(pool) {
  await pool.query("update public.outbound_queue set send_after = now() - interval '1 second' where status = 'pending'");
  return require('../lib/outbox').drain({ limite: 50, tempoMaximoMs: 5000 });
}

const textoLLM = t => ({ message: { role: 'assistant', content: t, tool_calls: [] } });
const toolLLM = (nome, args, texto = null) => ({
  message: {
    role: 'assistant',
    content: texto,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: nome, arguments: JSON.stringify(args) } }]
  },
  finish_reason: 'tool_calls'
});

// -----------------------------------------------------------------------------

describe('pipeline ponta a ponta', { skip: !TEM_BANCO ? 'sem banco de testes configurado' : false }, () => {
  let pool, inbound, worker, orchestrator;
  const CLIENT = 'teste_e2e';
  const TOKEN = 'token_de_teste_e2e';
  const PHONE = '5511988887777@s.whatsapp.net';

  before(async () => {
    instalarMock();
    pool = require('../db');
    inbound = require('../routes/inbound');
    worker = require('../lib/queue-worker');
    orchestrator = require('../lib/agent/orchestrator');

    await limpar(pool, CLIENT);
    // a fila é global: resíduo de outro cliente faria o worker processar a mais
    await pool.query("delete from public.inbound_queue where status in ('pending','processing')");

    await pool.query(
      `insert into public.clients
         (client_id, nome_empresa, nicho, evolution_instance, numero_responsavel, active, agent_enabled,
          inbound_token, debounce_segundos, llm_provider, llm_model, max_agent_turns, playbook)
       values ($1,'Acme Consultoria','consultoria','acme_inst','5517999999999@s.whatsapp.net',
               true,true,$2,1,'openai','gpt-4.1-mini',12,$3)`,
      [CLIENT, TOKEN, JSON.stringify({
        objetivo: 'Qualificar e agendar diagnóstico',
        perguntas_qualificacao: [
          { campo: 'nome', pergunta: 'Com quem falo?', obrigatorio: true },
          { campo: 'empresa', pergunta: 'De qual empresa?', obrigatorio: true }
        ],
        criterio_qualificado: 'nome e empresa'
      })]
    );

    const src = await pool.query(
      `insert into public.knowledge_sources (client_id, filename, status) values ($1,'precos.pdf','pronto') returning id`,
      [CLIENT]
    );
    await pool.query(
      `insert into public.knowledge_chunks (client_id, source_id, content, embedding)
       values ($1,$2,'O plano Essencial custa R$ 497 por mês e inclui atendimento ilimitado.',$3),
              ($1,$2,'A garantia é de 30 dias com devolução integral.',$3)`,
      [CLIENT, src.rows[0].id, JSON.stringify(Array(1536).fill(0.01))]
    );

    await pool.query(
      `insert into public.assets (client_id, name, description, url, kind, mime_type, file_name)
       values ($1,'Catálogo 2026','quando o cliente pedir para ver os produtos','https://cdn.test/cat.pdf','document','application/pdf','catalogo.pdf')`,
      [CLIENT]
    );
  });

  after(async () => {
    if (pool) { await limpar(pool, CLIENT); await pool.end().catch(() => {}); }
    globalThis.fetch = fetchOriginal;
  });

  // ---------------------------------------------------------------------------

  test('webhook grava mensagem, cria lead e enfileira', async () => {
    resetChamadas();
    await inbound.__handle(TOKEN, webhookBody({ id: 'MSG_A', texto: 'oi, queria saber do plano' }));

    const msgs = await pool.query('select * from public.messages where client_id=$1 and phone=$2', [CLIENT, PHONE]);
    assert.strictEqual(msgs.rowCount, 1, 'mensagem não foi gravada');
    assert.strictEqual(msgs.rows[0].external_id, 'MSG_A');
    assert.strictEqual(msgs.rows[0].processed, false);

    const lead = await pool.query('select * from public.leads where client_id=$1 and phone=$2', [CLIENT, PHONE]);
    assert.strictEqual(lead.rowCount, 1, 'lead não foi criado');

    const fila = await pool.query(`select * from public.inbound_queue where client_id=$1 and status='pending'`, [CLIENT]);
    assert.strictEqual(fila.rowCount, 1, 'não enfileirou');

    const evt = await pool.query(`select * from public.lead_events where client_id=$1 and type='lead.created'`, [CLIENT]);
    assert.strictEqual(evt.rowCount, 1, 'evento lead.created não registrado');
  });

  test('webhook reenviado (mesmo id) NÃO duplica', async () => {
    await inbound.__handle(TOKEN, webhookBody({ id: 'MSG_A', texto: 'oi, queria saber do plano' }));
    const msgs = await pool.query(`select count(*)::int t from public.messages where client_id=$1 and external_id='MSG_A'`, [CLIENT]);
    assert.strictEqual(msgs.rows[0].t, 1, 'retry da Evolution duplicou a mensagem');
  });

  test('segunda mensagem apenas empurra o debounce (uma linha na fila)', async () => {
    await inbound.__handle(TOKEN, webhookBody({ id: 'MSG_B', texto: 'é urgente' }));
    const fila = await pool.query(`select count(*)::int t from public.inbound_queue where client_id=$1 and status='pending'`, [CLIENT]);
    assert.strictEqual(fila.rows[0].t, 1, 'criou fila duplicada em vez de reagendar');
  });

  test('worker responde: junta o buffer, consulta a base e envia', async () => {
    resetChamadas();
    respostaLLM = textoLLM('Oi! Que bom te ver por aqui.\n\nO plano Essencial custa R$ 497 por mês. Com quem eu falo?');

    await pool.query(`update public.inbound_queue set process_after = now() - interval '1 second' where client_id=$1`, [CLIENT]);
    const r = await worker.tick({ limit: 5 });
    assert.strictEqual(r.processadas, 1, `worker não processou (erros: ${r.erros})`);
    await entregar(pool);

    // As duas mensagens do buffer viraram um texto só
    const chat = chamadas.openai.find(c => c.tipo === 'chat');
    assert.ok(chat, 'o modelo não foi chamado');
    const ultima = chat.body.messages[chat.body.messages.length - 1].content;
    assert.ok(ultima.includes('plano') && ultima.includes('urgente'), 'buffer não foi agrupado');

    // O contexto da base entrou no system prompt
    assert.ok(chat.body.messages[0].content.includes('R$ 497'), 'RAG não injetou o preço no prompt');

    // Resposta enviada em 2 bolhas + presença "digitando"
    const envios = chamadas.evolution.filter(c => c.url.includes('sendText'));
    assert.strictEqual(envios.length, 2, `esperado 2 bolhas, veio ${envios.length}`);
    assert.ok(chamadas.evolution.some(c => c.url.includes('sendPresence')), 'não enviou "digitando..."');

    // Gravou a saída e limpou o buffer
    const out = await pool.query(`select count(*)::int t from public.messages where client_id=$1 and direction='outbound'`, [CLIENT]);
    assert.strictEqual(out.rows[0].t, 2);
    const pend = await pool.query(`select count(*)::int t from public.messages where client_id=$1 and direction='inbound' and processed=false`, [CLIENT]);
    assert.strictEqual(pend.rows[0].t, 0, 'buffer não foi marcado como processado');

    const fila = await pool.query(`select status from public.inbound_queue where client_id=$1`, [CLIENT]);
    assert.strictEqual(fila.rows[0].status, 'done');

    // Custo registrado
    const uso = await pool.query(`select * from public.usage_log where client_id=$1 and kind='chat'`, [CLIENT]);
    assert.ok(uso.rowCount > 0, 'não registrou uso');
    assert.strictEqual(uso.rows[0].tokens_in, 500);
  });

  test('ferramenta registrar_informacao grava a qualificação e dispara lead.qualified', async () => {
    resetChamadas();
    let chamada = 0;
    respostaLLM = () => {
      chamada++;
      return chamada === 1
        ? toolLLM('registrar_informacao', { dados: { nome: 'Marina', empresa: 'Acme' } })
        : textoLLM('Prazer, Marina! Me conta o que está acontecendo na Acme hoje.');
    };

    // sem dryRun: no simulador os eventos de CRM não devem disparar, então o
    // teste do disparo precisa percorrer o caminho de produção
    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'sou a Marina, da Acme' });

    assert.ok(r.trace.some(t => t.tool === 'registrar_informacao'), 'ferramenta não foi executada');

    const lead = await pool.query('select qualification, name from public.leads where client_id=$1 and phone=$2', [CLIENT, PHONE]);
    assert.strictEqual(lead.rows[0].qualification.nome, 'Marina');
    assert.strictEqual(lead.rows[0].qualification.empresa, 'Acme');
    assert.strictEqual(lead.rows[0].name, 'Marina', 'nome não subiu para a coluna do lead');

    // criterio_qualificado = "nome e empresa" -> deve ter qualificado
    const evt = await pool.query(`select * from public.lead_events where client_id=$1 and type='lead.qualified'`, [CLIENT]);
    assert.strictEqual(evt.rowCount, 1, 'evento lead.qualified não disparou');
  });

  test('ferramenta enviar_arquivo manda o documento pela Evolution', async () => {
    resetChamadas();
    const asset = await pool.query('select id from public.assets where client_id=$1', [CLIENT]);
    let chamada = 0;
    respostaLLM = () => {
      chamada++;
      return chamada === 1
        ? toolLLM('enviar_arquivo', { arquivo_id: Number(asset.rows[0].id), mensagem: 'Segue o catálogo' })
        : textoLLM('Te mandei o catálogo aqui!');
    };

    await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'me manda o catálogo' });
    await entregar(pool);

    const media = chamadas.evolution.filter(c => c.url.includes('sendMedia'));
    assert.strictEqual(media.length, 1, 'arquivo não foi enviado');
    assert.strictEqual(media[0].body.media, 'https://cdn.test/cat.pdf');
    assert.strictEqual(media[0].body.mediatype, 'document');
    assert.strictEqual(media[0].body.caption, 'Segue o catálogo');

    const evt = await pool.query(`select * from public.lead_events where client_id=$1 and type='asset.sent'`, [CLIENT]);
    assert.strictEqual(evt.rowCount, 1);
  });

  test('o mesmo arquivo NÃO é enviado duas vezes na mesma resposta', async () => {
    resetChamadas();
    const asset = await pool.query('select id from public.assets where client_id=$1', [CLIENT]);
    const id = Number(asset.rows[0].id);
    let chamada = 0;
    respostaLLM = () => {
      chamada++;
      if (chamada <= 2) return toolLLM('enviar_arquivo', { arquivo_id: id, mensagem: 'catálogo' });
      return textoLLM('Pronto!');
    };

    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'manda de novo' });
    await entregar(pool);

    // O modelo pediu o arquivo duas vezes; o handler recusou a segunda.
    const efeitos = r.effects.filter(e => e.type === 'asset');
    assert.strictEqual(efeitos.length, 1, 'o mesmo arquivo entrou duas vezes na fila de envio');
    const media = chamadas.evolution.filter(c => c.url.includes('sendMedia'));
    assert.strictEqual(media.length, 1, 'arquivo duplicado foi enviado ao cliente');
  });

  test('transferir_humano pausa o bot e avisa o responsável', async () => {
    resetChamadas();
    let chamada = 0;
    respostaLLM = () => {
      chamada++;
      return chamada === 1
        ? toolLLM('transferir_humano', { motivo: 'quer negociar valor', urgencia: 'alta', resumo: 'Marina, da Acme' })
        : textoLLM('Já pedi pro nosso time te chamar agora, tá?');
    };

    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'quero desconto, chama alguém' });
    assert.ok(r.handoff, 'handoff não foi marcado');

    const st = await pool.query('select * from public.conversation_state where client_id=$1 and phone=$2', [CLIENT, PHONE]);
    assert.strictEqual(st.rows[0].paused, true, 'conversa não foi pausada');
    assert.strictEqual(st.rows[0].stage, 'humano');

    const lead = await pool.query('select status from public.leads where client_id=$1 and phone=$2', [CLIENT, PHONE]);
    assert.strictEqual(lead.rows[0].status, 'aguardando_humano');

    // Notificação foi para o número do responsável, não para o cliente
    const aviso = chamadas.evolution.find(c => c.url.includes('sendText') && c.body.number === '5517999999999');
    assert.ok(aviso, 'responsável não foi notificado');
    assert.ok(aviso.body.text.includes('negociar valor'));
  });

  test('com a conversa pausada, o agente não responde por cima do humano', async () => {
    resetChamadas();
    respostaLLM = textoLLM('não deveria sair');
    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'oi de novo' });
    assert.strictEqual(r.skipped, 'conversa_pausada');
    assert.strictEqual(chamadas.evolution.filter(c => c.url.includes('sendText')).length, 0);
    assert.strictEqual(chamadas.openai.filter(c => c.tipo === 'chat').length, 0, 'gastou token com a conversa pausada');
  });

  test('falha do modelo degrada para mensagem humana + handoff, nunca fica mudo', async () => {
    await pool.query(`update public.conversation_state set paused=false, paused_until=null where client_id=$1`, [CLIENT]);
    resetChamadas();
    respostaLLM = () => { throw new Error('502 do provedor'); };

    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'oi' });
    assert.strictEqual(r.messages.length, 1);
    assert.ok(r.messages[0].length > 10, 'mensagem de fallback vazia');
    assert.ok(chamadas.evolution.some(c => c.url.includes('sendText')), 'não enviou nada ao cliente');

    const alerta = await pool.query(`select * from public.agent_alerts where client_id=$1 and level='error'`, [CLIENT]);
    assert.ok(alerta.rowCount > 0, 'não gerou alerta para o admin');
  });

  test('agente falhando NÃO engole a mensagem: ela volta para a fila', async () => {
    // Regressão de um bug que apareceu em produção: processOne marcava as
    // mensagens como processed=true ANTES de chamar o agente. Quando o agente
    // falhava (um timeout de conexão no banco), o item voltava para 'pending',
    // a segunda passada não achava mensagem não processada, fechava como
    // 'sem_mensagens' — e o cliente nunca era respondido, sem nenhum erro à
    // vista. Um "Oi" desapareceu assim.
    await pool.query(`update public.conversation_state set paused=false, paused_until=null where client_id=$1`, [CLIENT]);
    await pool.query(`delete from public.inbound_queue where client_id=$1`, [CLIENT]);
    await pool.query(`update public.messages set processed=true where client_id=$1`, [CLIENT]);
    resetChamadas();

    const { rows: [msg] } = await pool.query(
      `insert into public.messages (client_id, phone, direction, content, processed)
       values ($1,$2,'inbound','tem horário amanhã?', false) returning id`,
      [CLIENT, PHONE]
    );
    const { rows: [item] } = await pool.query(
      `insert into public.inbound_queue (client_id, phone, status, process_after, attempts)
       values ($1,$2,'processing', now(), 1) returning *`,
      [CLIENT, PHONE]
    );

    const original = orchestrator.respond;
    orchestrator.respond = async () => { throw new Error('timeout exceeded when trying to connect'); };
    try {
      await assert.rejects(() => worker.processOne(item), /timeout exceeded/);
    } finally {
      orchestrator.respond = original;
    }

    const { rows: [depois] } = await pool.query('select processed from public.messages where id=$1', [msg.id]);
    assert.strictEqual(depois.processed, false, 'a mensagem ficou marcada como processada e sumiu');

    const { rows: [fila] } = await pool.query('select status from public.inbound_queue where id=$1', [item.id]);
    assert.strictEqual(fila.status, 'pending', 'o item não voltou para a fila');

    // E a repetição agora encontra a mensagem, em vez de fechar como 'sem_mensagens'
    const r = await worker.processOne({ ...item, attempts: 2 });
    assert.notStrictEqual(r.skipped, 'sem_mensagens', 'a repetição não achou a mensagem');
    assert.ok(chamadas.evolution.some(c => c.url.includes('sendText')), 'não respondeu na segunda tentativa');
  });

  test('áudio recebido é transcrito e vira texto para o agente', async () => {
    resetChamadas();
    await pool.query(`update public.conversation_state set paused=false, paused_until=null where client_id=$1`, [CLIENT]);

    await inbound.__handle(TOKEN, webhookBody({
      id: 'MSG_AUDIO', texto: null,
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', seconds: 5 } },
      messageType: 'audioMessage'
    }));

    assert.ok(chamadas.evolution.some(c => c.url.includes('getBase64FromMediaMessage')), 'não baixou o áudio');
    assert.ok(chamadas.openai.some(c => c.tipo === 'transcricao'), 'não chamou a transcrição');

    const msg = await pool.query(`select * from public.messages where client_id=$1 and external_id='MSG_AUDIO'`, [CLIENT]);
    assert.strictEqual(msg.rowCount, 1);
    assert.ok(msg.rows[0].transcript.includes('quanto custa o plano essencial'),
      `transcrição não foi salva: ${msg.rows[0].transcript}`);
    assert.strictEqual(msg.rows[0].media_type, 'audio');
  });

  test('mensagem própria (fromMe) e grupo são ignorados', async () => {
    const antes = await pool.query('select count(*)::int t from public.messages where client_id=$1', [CLIENT]);
    await inbound.__handle(TOKEN, webhookBody({ id: 'MSG_ME', texto: 'eu mesmo', fromMe: true }));
    await inbound.__handle(TOKEN, webhookBody({ id: 'MSG_GRUPO', texto: 'grupo', remoteJid: '123456@g.us' }));
    const depois = await pool.query('select count(*)::int t from public.messages where client_id=$1', [CLIENT]);
    assert.strictEqual(depois.rows[0].t, antes.rows[0].t, 'processou mensagem que deveria ignorar');
  });

  test('token de webhook inválido não cria nada', async () => {
    const antes = await pool.query('select count(*)::int t from public.messages', []);
    await inbound.__handle('token_que_nao_existe', webhookBody({ id: 'MSG_X', texto: 'oi' }));
    const depois = await pool.query('select count(*)::int t from public.messages', []);
    assert.strictEqual(depois.rows[0].t, antes.rows[0].t);
  });

  test('cliente inativo não consome LLM', async () => {
    resetChamadas();
    await pool.query('update public.clients set active=false where client_id=$1', [CLIENT]);
    const r = await orchestrator.respond({ clientId: CLIENT, phone: PHONE, text: 'oi' });
    assert.strictEqual(r.skipped, 'cliente_inativo');
    assert.strictEqual(chamadas.openai.length, 0);
    await pool.query('update public.clients set active=true where client_id=$1', [CLIENT]);
  });

  // ---------------------------------------------------------------------------

  function webhookBody({ id, texto, fromMe = false, remoteJid = PHONE, message, messageType = 'conversation' }) {
    return {
      event: 'messages.upsert',
      instance: 'acme_inst',
      data: {
        key: { remoteJid, fromMe, id },
        pushName: 'Marina',
        message: message || (texto ? { conversation: texto } : {}),
        messageType,
        messageTimestamp: Math.floor(Date.now() / 1000)
      }
    };
  }
});

async function limpar(pool, clientId) {
  for (const t of ['outbound_queue', 'inbound_queue', 'lead_events', 'agent_alerts', 'usage_log', 'messages',
                   'conversation_state', 'leads', 'knowledge_chunks', 'knowledge_sources',
                   'assets', 'integrations', 'api_keys', 'webhook_endpoints', 'follow_up_rules', 'users']) {
    await pool.query(`delete from public.${t} where client_id = $1`, [clientId]).catch(() => {});
  }
  await pool.query('delete from public.clients where client_id = $1', [clientId]).catch(() => {});
}
