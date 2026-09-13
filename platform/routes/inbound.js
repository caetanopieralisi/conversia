// =============================================================================
// Webhook de entrada — a Evolution API posta aqui, direto.
//
// SUBSTITUI: "Recebe mensagem" -> "If" -> "Coleta" -> "Busca Config" -> "Salva
// mensagem" -> "Upsert contato" -> "Pausa debounce" -> "Busca buffer" ->
// "Agrupa" -> "Marca processado"  (10 nodes do n8n)
//
// TRÊS PROBLEMAS DO DESENHO ANTERIOR QUE ISSO RESOLVE:
//
// 1. O node `Wait` do debounce mantinha UMA EXECUÇÃO ABERTA por mensagem
//    recebida, por 15 segundos. 20 pessoas escrevendo ao mesmo tempo = 20
//    execuções presas. Se o n8n reinicia, todas somem — e ninguém é respondido.
//    Aqui a espera vira uma linha em `inbound_queue` com `process_after`.
//    Nada fica aberto; se o processo morre, a fila continua lá.
//
// 2. Não havia deduplicação. A Evolution reenvia o webhook em retry, e o
//    resultado era o cliente recebendo a mesma resposta duas vezes.
//    Agora há índice único em (client_id, external_id).
//
// 3. O `IF` travado em `remoteJid == '5517991794038@s.whatsapp.net'` fazia o
//    workflow multi-tenant atender exatamente um número: o seu. Nenhum cliente
//    real passava por ali. Isso virou uma allowlist opcional por cliente.
// =============================================================================

const express = require('express');
const pool = require('../db');
const evolution = require('../lib/evolution');
const media = require('../lib/media');
const events = require('../lib/events');
const worker = require('../lib/queue-worker');

const router = express.Router();

// -----------------------------------------------------------------------------
// Extração do payload da Evolution API
// -----------------------------------------------------------------------------

const TIPOS_TEXTO = ['conversation', 'extendedTextMessage'];

function extract(body) {
  const data = body?.data || {};
  const key = data.key || {};
  const message = data.message || {};

  const texto =
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.buttonsResponseMessage?.selectedDisplayText ||
    message.listResponseMessage?.title ||
    null;

  // Qual mídia veio junto (se veio)
  const mediaKey = ['audioMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'stickerMessage']
    .find(k => message[k]);

  return {
    event: body?.event,
    instance: body?.instance,
    remoteJid: key.remoteJid,
    fromMe: !!key.fromMe,
    messageId: key.id,
    pushName: data.pushName || null,
    texto,
    mediaType: mediaKey || null,
    mimetype: mediaKey ? message[mediaKey]?.mimetype : null,
    messageType: data.messageType,
    timestamp: data.messageTimestamp
  };
}

// -----------------------------------------------------------------------------
// POST /api/inbound/:token
// -----------------------------------------------------------------------------
// Cada cliente tem seu próprio token na URL — a instância nem precisa ser
// procurada, e um token vazado só expõe um cliente, não todos.

router.post('/:token', async (req, res) => {
  // Responde 200 IMEDIATAMENTE. A Evolution tem timeout curto e reenvia o
  // webhook se demorarmos; processar antes de responder gera duplicata.
  res.status(200).json({ received: true });

  try {
    await handle(req.params.token, req.body);
  } catch (e) {
    console.error('[inbound] falha ao processar:', e);
  }
});

// Compatibilidade: rota sem token, identificando o cliente pela instância.
// Existe para quem já tem instâncias apontando para o webhook antigo.
router.post('/', async (req, res) => {
  res.status(200).json({ received: true });
  try {
    await handle(null, req.body);
  } catch (e) {
    console.error('[inbound] falha ao processar:', e);
  }
});

async function handle(token, body) {
  const evt = extract(body);

  // Só mensagens novas de terceiros interessam
  if (evt.event && evt.event !== 'messages.upsert') return;
  if (evt.fromMe) return;
  if (!evt.remoteJid) return;
  if (evt.remoteJid.includes('@g.us') && process.env.IGNORE_GROUPS !== 'false') return; // grupos: fora por padrão
  if (evt.remoteJid === 'status@broadcast') return;

  // --- Identifica o cliente --------------------------------------------------
  const { rows } = token
    ? await pool.query('select * from public.clients where inbound_token = $1 and active = true', [token])
    : await pool.query('select * from public.clients where evolution_instance = $1 and active = true', [evt.instance]);

  const client = rows[0];
  if (!client) {
    console.warn('[inbound] cliente não encontrado', { token: !!token, instance: evt.instance });
    return;
  }

  // Allowlist de teste: com números cadastrados, só eles são atendidos.
  // É o que o `IF` hardcoded tentava fazer — agora por cliente e desligável.
  const allowlist = client.playbook?.numeros_teste;
  if (Array.isArray(allowlist) && allowlist.length) {
    const numero = evolution.toNumber(evt.remoteJid);
    if (!allowlist.map(n => evolution.toNumber(n)).includes(numero)) return;
  }

  const phone = evt.remoteJid;

  // --- Deduplicação ----------------------------------------------------------
  if (evt.messageId) {
    const dup = await pool.query(
      'select 1 from public.messages where client_id = $1 and external_id = $2',
      [client.client_id, evt.messageId]
    );
    if (dup.rowCount) return; // já processada num retry anterior
  }

  // --- Mídia: transcreve áudio, descreve imagem ------------------------------
  let conteudo = evt.texto;
  let transcript = null;
  let mediaUsage = null;

  if (evt.mediaType && evt.mediaType !== 'stickerMessage') {
    const processed = await media.processInbound({
      client,
      messageKey: { id: evt.messageId, remoteJid: evt.remoteJid, fromMe: false },
      mediaType: evt.mediaType,
      mimetype: evt.mimetype
    });
    if (processed.text) {
      transcript = evt.texto ? `${evt.texto}\n${processed.text}` : processed.text;
      conteudo = conteudo || `[${processed.kind}]`;
    }
    mediaUsage = processed.usage;
  }

  if (!conteudo && !transcript) return; // nada aproveitável

  // --- Grava a mensagem ------------------------------------------------------
  try {
    await pool.query(
      `insert into public.messages
         (client_id, phone, contact_name, direction, content, transcript, media_type, external_id, processed, created_at)
       values ($1,$2,$3,'inbound',$4,$5,$6,$7,false, now())
       -- o índice de dedupe é PARCIAL (where external_id is not null); o mesmo
       -- predicado precisa aparecer aqui para o Postgres conseguir inferi-lo
       on conflict (client_id, external_id) where external_id is not null do nothing`,
      [client.client_id, phone, evt.pushName, conteudo, transcript,
       evt.mediaType ? evt.mediaType.replace('Message', '') : null, evt.messageId]
    );
  } catch (e) {
    console.error('[inbound] falha ao gravar mensagem:', e.message);
    return;
  }

  if (mediaUsage) {
    await pool.query(
      `insert into public.usage_log (client_id, phone, model, kind, latency_ms, tokens_in, tokens_out, cost_usd)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [client.client_id, phone, mediaUsage.model || null, mediaUsage.kind || 'media',
       mediaUsage.latencyMs || null, mediaUsage.tokensIn || 0, mediaUsage.tokensOut || 0, mediaUsage.costUsd || null]
    ).catch(() => {});
  }

  // --- Lead ------------------------------------------------------------------
  const leadRes = await pool.query(
    `insert into public.leads (client_id, phone, name, status, last_inbound_at, followup_count, created_at)
     values ($1,$2,$3,'ativo', now(), 0, now())
     on conflict (client_id, phone) do update
        set last_inbound_at = now(),
            name = coalesce(nullif(excluded.name,''), public.leads.name),
            status = case when public.leads.status = 'fechado' then 'ativo' else public.leads.status end
     returning (xmax = 0) as inserted`,
    [client.client_id, phone, evt.pushName || null]
  );

  if (leadRes.rows[0]?.inserted) {
    await events.record(client.client_id, phone, 'lead.created', { name: evt.pushName, phone });
  }

  await evolution.markAsRead(client.evolution_instance, {
    remoteJid: phone, messageId: evt.messageId, fromMe: false
  });

  // --- Enfileira com debounce ------------------------------------------------
  // Mensagem nova numa conversa já enfileirada apenas EMPURRA o relógio: é assim
  // que "oi" + "queria saber" + "sobre o plano" viram uma resposta só.
  const debounce = Math.max(2, Number(client.debounce_segundos || 12));
  await pool.query(
    `insert into public.inbound_queue (client_id, phone, contact_name, process_after, status)
     values ($1,$2,$3, now() + ($4 || ' seconds')::interval, 'pending')
     on conflict (client_id, phone) where status in ('pending','processing')
     do update set process_after = now() + ($4 || ' seconds')::interval,
                   contact_name = coalesce(excluded.contact_name, public.inbound_queue.contact_name),
                   status = 'pending',
                   updated_at = now()`,
    [client.client_id, phone, evt.pushName || null, debounce]
  );

  await events.record(client.client_id, phone, 'message.received',
    { content: conteudo, transcript, media_type: evt.mediaType });

  // Em ambiente com processo longo (VPS/Docker), o worker interno acorda sozinho.
  // Em serverless, quem roda é o cron chamando /api/cron/tick.
  worker.wake();
}

module.exports = router;
module.exports.extract = extract;
// exposto para o teste de integração exercitar o caminho real sem subir HTTP
module.exports.__handle = handle;
