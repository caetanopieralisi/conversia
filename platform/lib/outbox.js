// =============================================================================
// Fila de saída.
//
// O agente não envia mais mensagem direto: ele enfileira as bolhas com o
// horário em que cada uma deve sair. Este módulo drena a fila.
//
// O ritmo de digitação continua exatamente igual do lado do cliente — quem o
// define é o `send_after` de cada bolha, não um sleep dentro do processo.
//
// Duas coisas que isso resolve de graça:
//   • um tick nunca fica preso esperando a digitação de uma conversa
//   • se o processo morrer no meio da resposta, o resto sai no próximo tick
//     (antes, as bolhas restantes simplesmente se perdiam)
// =============================================================================

const pool = require('../db');
const evolution = require('./evolution');
const events = require('./events');

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_TENTATIVAS = 3;

// Se a próxima bolha da MESMA conversa vence daqui a pouco, vale esperar dentro
// do mesmo tick: mantém o ritmo natural em vez de deixá-la para o tick seguinte.
const ESPERA_INLINE_MAX_MS = 6000;

// Intervalo mínimo entre duas bolhas da mesma conversa. Bate com o piso de
// humanize.typingDelay: abaixo disso a conversa deixa de parecer digitada.
const GAP_MINIMO_MS = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Enfileira a resposta do agente.
 *
 * @param {object} p
 * @param {object} p.client
 * @param {string} p.phone
 * @param {string[]} p.messages   bolhas de texto, na ordem
 * @param {Array} [p.effects]     efeitos do orquestrador (arquivos a enviar)
 * @param {string} [p.contactName]
 * @param {number} [p.delayInicial=0]  ms antes da primeira bolha
 * @returns {Promise<{enfileiradas:number, ultimoEnvioEm:Date}>}
 */
async function enqueueResposta({ client, phone, messages, effects = [], contactName, delayInicial = 0 }) {
  const humanize = require('./agent/humanize');
  const linhas = [];
  let quando = Date.now() + delayInicial;
  let seq = 0;

  for (const texto of messages) {
    // O tempo de "digitação" de uma bolha acontece ANTES dela aparecer.
    quando += humanize.typingDelay(texto);
    linhas.push({
      kind: 'text', content: texto, asset_id: null, caption: null,
      send_after: new Date(quando), seq: seq++
    });
  }

  // Arquivos vão depois do texto: a legenda explica o anexo antes de ele chegar.
  for (const efeito of effects.filter(e => e.type === 'asset')) {
    quando += 1500;
    linhas.push({
      kind: 'asset', content: null, asset_id: efeito.asset.id,
      caption: efeito.caption || '', send_after: new Date(quando), seq: seq++
    });
  }

  if (!linhas.length) return { enfileiradas: 0, ultimoEnvioEm: new Date(quando) };

  const valores = [];
  const params = [];
  for (const l of linhas) {
    const b = params.length;
    params.push(client.client_id, phone, l.kind, l.content, l.asset_id, l.caption,
                l.send_after, l.seq, contactName || null);
    valores.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`);
  }

  await pool.query(
    `insert into public.outbound_queue
       (client_id, phone, kind, content, asset_id, caption, send_after, seq, contact_name)
     values ${valores.join(',')}`,
    params
  );

  return { enfileiradas: linhas.length, ultimoEnvioEm: new Date(quando) };
}

/**
 * Reserva as bolhas vencidas.
 *
 * A trava é por CONVERSA, não por bolha: duas instâncias não podem estar
 * enviando na mesma conversa ao mesmo tempo, senão as bolhas chegam fora de
 * ordem. Dentro de uma conversa, sempre a de menor `seq` primeiro.
 */
async function reservar(limite = 20) {
  // Em duas etapas de propósito: o Postgres não aceita FOR UPDATE junto com
  // DISTINCT ON ("FOR UPDATE is not allowed with DISTINCT clause"). Então
  // primeiro escolhemos as candidatas (uma por conversa, a de menor seq) e
  // depois travamos essas linhas.
  //
  // O `q.status = 'pending'` no UPDATE não é redundante: entre escolher e
  // travar, outra instância pode ter pegado a mesma linha. SKIP LOCKED evita a
  // espera; a recheca de status evita o envio em duplicidade.
  // ATENÇÃO À ORDEM DOS FILTROS.
  // Primeiro escolhemos a bolha de MENOR seq pendente de cada conversa; só
  // depois perguntamos se ela já venceu. Fazer o contrário (filtrar por
  // send_after antes) permite que a bolha 3 seja enviada enquanto a 2 está
  // reagendada para daqui a instantes — e o cliente recebe a conversa fora de
  // ordem. Foi exatamente isso que o teste "motor picotado" pegou.
  const { rows } = await pool.query(
    `with proxima_de_cada as (
       select distinct on (client_id, phone) id, send_after
         from public.outbound_queue
        where status = 'pending'
        order by client_id, phone, seq asc, id asc
     ),
     candidatas as (
       select id from proxima_de_cada where send_after <= now() limit $1
     ),
     travadas as (
       select q.id
         from public.outbound_queue q
         join candidatas c on c.id = q.id
        where q.status = 'pending'
        for update of q skip locked
     )
     update public.outbound_queue q
        set status = 'sending', locked_at = now(), locked_by = $2, attempts = q.attempts + 1
       from travadas t
      where q.id = t.id and q.status = 'pending'
      returning q.*`,
    [limite, WORKER_ID]
  );
  return rows;
}

async function enviarUma(linha) {
  const { rows: cRows } = await pool.query(
    'select * from public.clients where client_id = $1',
    [linha.client_id]
  );
  const client = cRows[0];
  if (!client) throw new Error('cliente não encontrado');
  if (!client.evolution_instance) throw new Error('cliente sem evolution_instance');

  if (linha.kind === 'asset') {
    const { rows } = await pool.query('select * from public.assets where id = $1', [linha.asset_id]);
    const asset = rows[0];
    if (!asset) throw new Error(`arquivo ${linha.asset_id} não existe mais`);

    if (asset.kind === 'audio') {
      await evolution.sendAudio(client.evolution_instance, linha.phone, asset.url);
    } else {
      await evolution.sendMedia(client.evolution_instance, linha.phone, {
        mediatype: asset.kind === 'image' ? 'image' : asset.kind === 'video' ? 'video' : 'document',
        media: asset.url,
        mimetype: asset.mime_type,
        fileName: asset.file_name || asset.name,
        caption: linha.caption || ''
      });
    }

    await pool.query('update public.assets set send_count = coalesce(send_count,0) + 1 where id = $1', [asset.id]);
    await pool.query(
      `insert into public.messages (client_id, phone, direction, content, media_url, media_type, processed, author, created_at)
       values ($1,$2,'outbound',$3,$4,$5,true,'agent', now())`,
      [linha.client_id, linha.phone,
       `[${asset.kind}] ${asset.name}${linha.caption ? ' — ' + linha.caption : ''}`, asset.url, asset.kind]
    );
    await events.record(linha.client_id, linha.phone, 'asset.sent', { asset_id: asset.id, name: asset.name });
    return;
  }

  // Texto: "digitando..." curtinho só para a bolha não aparecer do nada
  await evolution.sendPresence(client.evolution_instance, linha.phone, 'composing', 900);
  await evolution.sendText(client.evolution_instance, linha.phone, linha.content);

  await pool.query(
    `insert into public.messages (client_id, phone, contact_name, direction, content, processed, author, created_at)
     values ($1,$2,$3,'outbound',$4,true,'agent', now())`,
    [linha.client_id, linha.phone, linha.contact_name, linha.content]
  );
}

async function marcarEnviada(id) {
  await pool.query(
    `update public.outbound_queue set status='sent', sent_at=now(), locked_at=null, locked_by=null where id=$1`,
    [id]
  );
}

async function marcarFalha(linha, erro) {
  const desistir = linha.attempts >= MAX_TENTATIVAS;
  await pool.query(
    `update public.outbound_queue
        set status = $2, last_error = $3, locked_at = null, locked_by = null,
            send_after = case when $2 = 'pending' then now() + interval '30 seconds' else send_after end
      where id = $1`,
    [linha.id, desistir ? 'error' : 'pending', String(erro.message || erro).slice(0, 500)]
  );

  if (desistir) {
    await pool.query(
      `insert into public.agent_alerts (client_id, message, level) values ($1,$2,'error')`,
      [linha.client_id,
       `Não consegui entregar uma mensagem para ${linha.phone} após ${MAX_TENTATIVAS} tentativas: ${String(erro.message || erro).slice(0, 200)}`]
    ).catch(() => {});

    // Uma bolha que falhou de vez invalida as seguintes da mesma resposta —
    // mandar a bolha 3 sem a 2 confunde mais o cliente do que o silêncio.
    await pool.query(
      `update public.outbound_queue
          set status='error', last_error='cancelada: a bolha anterior falhou'
        where client_id=$1 and phone=$2 and status='pending' and seq > $3
          and created_at >= $4::timestamptz - interval '1 minute'`,
      [linha.client_id, linha.phone, linha.seq, linha.created_at]
    );
  }
}

/**
 * Drena a fila de saída. Rápido de propósito: nunca dorme mais que
 * ESPERA_INLINE_MAX_MS, e só quando isso preserva o ritmo de uma conversa.
 *
 * @returns {Promise<{enviadas:number, erros:number}>}
 */
async function drain({ limite = 20, tempoMaximoMs = 20000 } = {}) {
  const inicio = Date.now();
  let enviadas = 0, erros = 0;

  const linhas = await reservar(limite);

  for (const primeira of linhas) {
    let linha = primeira;

    // Continua nesta conversa enquanto fizer sentido:
    //   • bolha já vencida  -> manda agora (recuperar atraso é o certo)
    //   • vence em ≤6s      -> espera aqui, para o ritmo não ficar preso à
    //                          cadência do motor
    //   • vence depois disso -> deixa para o próximo tick
    while (linha) {
      try {
        await enviarUma(linha);
        await marcarEnviada(linha.id);
        enviadas++;
      } catch (e) {
        console.error(`[outbox] falha ao enviar ${linha.id}:`, e.message);
        await marcarFalha(linha, e);
        erros++;
        break;   // conversa com problema: não insiste nas seguintes agora
      }

      const { rows } = await pool.query(
        `select id, send_after,
                extract(epoch from (send_after - now())) * 1000 as falta_ms
           from public.outbound_queue
          where client_id=$1 and phone=$2 and status='pending'
          order by seq asc, id asc limit 1`,
        [linha.client_id, linha.phone]
      );
      if (!rows[0]) break;

      // RITMO ANTES DE PRESSA.
      // Se o motor atrasou, todas as bolhas de uma resposta ficam vencidas ao
      // mesmo tempo. Mandar as três de uma vez "recupera o atraso" — e entrega
      // exatamente aquilo que denuncia um robô: três mensagens no mesmo segundo.
      // Então o que vale é o intervalo que o agente PRETENDIA entre as bolhas,
      // contado a partir do envio real da anterior.
      const gapPretendido = new Date(rows[0].send_after) - new Date(linha.send_after);
      const falta = Number(rows[0].falta_ms);
      // O piso é a rede de segurança: se por qualquer motivo os horários vierem
      // achatados (migração, edição manual, bug futuro), duas bolhas ainda assim
      // nunca saem no mesmo segundo.
      const esperar = Math.max(GAP_MINIMO_MS, falta, gapPretendido);

      const restante = tempoMaximoMs - (Date.now() - inicio);
      if (esperar > ESPERA_INLINE_MAX_MS || esperar > restante) {
        // Não cabe neste tick: reagenda preservando o ritmo e deixa para o próximo.
        await pool.query(
          `update public.outbound_queue
              set send_after = now() + ($2 || ' milliseconds')::interval
            where id = $1 and status = 'pending'`,
          [rows[0].id, Math.round(esperar)]
        );
        break;
      }

      if (esperar > 0) await sleep(esperar);

      // Reserva a PRÓXIMA bolha desta conversa (não uma qualquer da fila).
      [linha] = await reservarConversa(linha.client_id, linha.phone);
    }
  }

  return { enviadas, erros };
}

/** Reserva a próxima bolha vencida de UMA conversa específica. */
async function reservarConversa(clientId, phone) {
  const { rows } = await pool.query(
    `with proxima as (
       select id, send_after from public.outbound_queue
        where client_id = $1 and phone = $2 and status = 'pending'
        order by seq asc, id asc limit 1
     ),
     candidata as (
       -- só envia se a PRÓXIMA da fila já venceu; nunca pula a vez de ninguém
       select id from proxima where send_after <= now()
     ),
     travada as (
       select q.id from public.outbound_queue q
         join candidata c on c.id = q.id
        where q.status = 'pending'
        for update of q skip locked
     )
     update public.outbound_queue q
        set status='sending', locked_at=now(), locked_by=$3, attempts=q.attempts+1
       from travada t
      where q.id = t.id and q.status = 'pending'
      returning q.*`,
    [clientId, phone, WORKER_ID]
  );
  return rows;
}

/** Devolve à fila o que ficou preso em 'sending' (processo morreu no meio). */
async function destravar() {
  const { rowCount } = await pool.query(
    `update public.outbound_queue
        set status='pending', locked_at=null, locked_by=null
      where status='sending' and locked_at < now() - interval '2 minutes' and attempts < $1`,
    [MAX_TENTATIVAS]
  );
  return rowCount;
}

/** Cancela o que ainda não saiu numa conversa (usado quando um humano assume). */
async function cancelarPendentes(clientId, phone, motivo = 'humano assumiu a conversa') {
  const { rowCount } = await pool.query(
    `update public.outbound_queue
        set status='error', last_error=$3
      where client_id=$1 and phone=$2 and status='pending'`,
    [clientId, phone, motivo]
  );
  return rowCount;
}

async function pendentes(clientId) {
  const { rows } = await pool.query(
    `select count(*)::int as total,
            coalesce(max(extract(epoch from (now() - send_after))),0)::int as atraso_s
       from public.outbound_queue
      where status='pending' and send_after <= now()
        ${clientId ? 'and client_id = $1' : ''}`,
    clientId ? [clientId] : []
  );
  return rows[0];
}

module.exports = {
  enqueueResposta, drain, destravar, cancelarPendentes, pendentes, reservarConversa,
  reservar, enviarUma, WORKER_ID
};
