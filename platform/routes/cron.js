const express = require('express');
const pool = require('../db');

const router = express.Router();

function checkSecret(req, res) {
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  const secret = req.headers['x-cron-secret'] || req.query.secret || bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Chave de cron inválida ou CRON_SECRET não configurado' });
    return false;
  }
  return true;
}

async function sendViaEvolution(instance, phone, message, mediaUrl) {
  if (!process.env.EVOLUTION_API_URL || !process.env.EVOLUTION_API_KEY) throw new Error('Evolution API não configurada');
  if (mediaUrl) {
    const resp = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, mediatype: 'image', media: mediaUrl, caption: message })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  } else {
    const resp = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, text: message })
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
}

/**
 * Decide o texto do follow-up.
 * Regra com mensagem fixa: usa ela. Regra com "{{ia}}" (ou vazia): pede ao
 * modelo uma mensagem que retoma o que a pessoa falou. Se a IA falhar, cai numa
 * mensagem neutra — nunca deixa de enviar por causa disso.
 */
async function resolveFollowUpMessage(rule, candidate) {
  const usarIA = !rule.message?.trim() || /\{\{\s*ia\s*\}\}/i.test(rule.message);
  if (!usarIA) return rule.message;

  try {
    const llm = require('../lib/llm');
    const salesPrompt = require('../lib/agent/salesPrompt');

    const [clientRes, leadRes, stateRes] = await Promise.all([
      pool.query('select * from public.clients where client_id = $1', [rule.client_id]),
      pool.query('select * from public.leads where client_id = $1 and phone = $2', [rule.client_id, candidate.phone]),
      pool.query('select * from public.conversation_state where client_id = $1 and phone = $2', [rule.client_id, candidate.phone])
    ]);
    const client = clientRes.rows[0];
    const lead = leadRes.rows[0] || {};

    const { rows: msgs } = await pool.query(
      `select direction, coalesce(transcript, content) as content
         from public.messages where client_id = $1 and phone = $2
         order by created_at desc limit 10`,
      [rule.client_id, candidate.phone]
    );
    const historico = msgs.reverse()
      .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Você'}: ${m.content}`)
      .join('\n');

    const res = await llm.chat({
      provider: client.llm_provider || 'openai',
      model: client.llm_model || 'gpt-4.1-mini',
      temperature: 0.8,   // follow-up repetido é pior que follow-up criativo
      maxTokens: 200,
      system: salesPrompt.buildFollowUp({
        client, lead, state: stateRes.rows[0] || {},
        tentativa: (lead.followup_count || 0) + 1
      }),
      messages: [{ role: 'user', content: `Conversa anterior:\n${historico}\n\nEscreva o follow-up.` }]
    });

    const humanize = require('../lib/agent/humanize');
    const texto = humanize.clean(res.content).split('\n\n')[0].trim();

    await pool.query(
      `insert into public.usage_log (client_id, phone, tokens_in, tokens_out, model, cost_usd, kind)
       values ($1,$2,$3,$4,$5,$6,'followup')`,
      [rule.client_id, candidate.phone, res.usage.tokensIn, res.usage.tokensOut, res.model, res.costUsd]
    ).catch(() => {});

    if (texto && texto.length > 10) return texto;
  } catch (e) {
    console.error('[followup] IA falhou, usando texto padrão:', e.message);
  }

  return rule.message?.replace(/\{\{\s*ia\s*\}\}/gi, '').trim() ||
         'Oi! Fiquei na dúvida se ficou alguma pendência do nosso papo. Posso ajudar em alguma coisa?';
}

async function runFollowUps() {
  let count = 0;
  const rules = await pool.query(
    `select r.*, c.evolution_instance from public.follow_up_rules r
     join public.clients c on c.client_id = r.client_id
     where r.active = true and c.active = true`
  );

  for (const rule of rules.rows) {
    // "silêncio" conta a partir da última vez que o LEAD falou (ou da criação, se nunca respondeu).
    // Isso faz várias regras formarem uma sequência automática (24h, 3 dias, 7 dias...) e
    // param sozinhas assim que o lead responder (last_inbound_at é atualizado nesse momento).
    const { rows: candidates } = await pool.query(
      `select l.phone, coalesce(l.last_inbound_at, l.created_at) as silencio_desde
       from public.leads l
       where l.client_id = $1
         and l.status = 'ativo'
         and exists (
           select 1 from public.messages msg
           where msg.client_id = l.client_id and msg.phone = l.phone and msg.direction = 'outbound'
         )
         and coalesce(l.last_inbound_at, l.created_at) < now() - ($2 || ' hours')::interval
         and not exists (
           select 1 from public.follow_up_log fl
           where fl.client_id = l.client_id and fl.phone = l.phone and fl.rule_id = $3
             and fl.sent_at > coalesce(l.last_inbound_at, l.created_at)
         )`,
      [rule.client_id, rule.wait_hours, rule.id]
    );

    for (const c of candidates) {
      try {
        // Follow-up gerado por IA quando a regra pede (mensagem vazia ou "{{ia}}").
        // Um texto fixo repetido para todo mundo é o que faz follow-up ser
        // ignorado; retomar um detalhe da conversa é o que faz a pessoa responder.
        const mensagem = await resolveFollowUpMessage(rule, c);
        await sendViaEvolution(rule.evolution_instance, c.phone, mensagem, rule.media_url);
        await pool.query(
          `insert into public.messages (client_id, phone, contact_name, direction, content, processed, author, created_at)
           values ($1, $2, null, 'outbound', $3, true, 'agent:followup', now())`,
          [rule.client_id, c.phone, mensagem]
        );
        await pool.query(
          `insert into public.follow_up_log (client_id, phone, rule_id) values ($1, $2, $3)`,
          [rule.client_id, c.phone, rule.id]
        );
        count++;
      } catch (e) {
        await pool.query(
          `insert into public.agent_alerts (client_id, message, level) values ($1, $2, 'warning')`,
          [rule.client_id, `Falha ao enviar follow-up "${rule.name}" para ${c.phone}: ${String(e)}`]
        ).catch(() => {});
      }
    }
  }
  return count;
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY não configurada');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.REPORT_FROM_EMAIL || 'ConversIA <onboarding@resend.dev>',
      to: [to],
      subject,
      html
    })
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}

async function runWeeklyReports() {
  let count = 0;
  const clients = await pool.query(`select * from public.clients where report_enabled = true and report_email is not null`);

  for (const client of clients.rows) {
    const last = await pool.query(
      `select sent_at from public.report_log where client_id = $1 order by sent_at desc limit 1`,
      [client.client_id]
    );
    const lastSent = last.rows[0]?.sent_at;
    if (lastSent && (Date.now() - new Date(lastSent).getTime()) < 6 * 24 * 3600 * 1000) continue;

    const periodEnd = new Date();
    const periodStart = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const metrics = await pool.query(
      `select
         count(*) filter (where l.created_at >= $2) as leads_semana,
         count(*) filter (where l.status = 'vendido' and l.sold_at >= $2) as vendas_semana,
         coalesce(sum(l.sale_value) filter (where l.status = 'vendido' and l.sold_at >= $2), 0) as receita_semana
       from public.leads l where l.client_id = $1`,
      [client.client_id, periodStart.toISOString()]
    );
    const m = metrics.rows[0];

    const html = `
      <h2>Relatório semanal — ${client.nome_empresa || client.client_id}</h2>
      <p>Período: ${periodStart.toLocaleDateString('pt-BR')} a ${periodEnd.toLocaleDateString('pt-BR')}</p>
      <ul>
        <li>Novos leads: <b>${m.leads_semana}</b></li>
        <li>Vendas fechadas: <b>${m.vendas_semana}</b></li>
        <li>Receita gerada: <b>R$ ${Number(m.receita_semana).toFixed(2)}</b></li>
      </ul>
      <p>Acesse a plataforma ConversIA para mais detalhes.</p>`;

    try {
      await sendEmail(client.report_email, `Relatório semanal — ${client.nome_empresa || 'ConversIA'}`, html);
      await pool.query(
        `insert into public.report_log (client_id, period_start, period_end) values ($1, $2, $3)`,
        [client.client_id, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10)]
      );
      count++;
    } catch (e) {
      await pool.query(
        `insert into public.agent_alerts (client_id, message, level) values ($1, $2, 'warning')`,
        [client.client_id, `Falha ao enviar relatório semanal por e-mail: ${String(e)}`]
      ).catch(() => {});
    }
  }
  return count;
}

async function checkOverduePayments() {
  const { rows } = await pool.query(
    `update public.clients set payment_status = 'atrasado'
     where next_due_date < current_date and payment_status != 'atrasado'
     returning client_id, nome_empresa`
  );
  for (const c of rows) {
    await pool.query(
      `insert into public.agent_alerts (client_id, message, level) values ($1, $2, 'warning')`,
      [c.client_id, `Mensalidade vencida — ${c.nome_empresa || c.client_id}`]
    ).catch(() => {});
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// /api/cron/queue  —  ALTA FREQUÊNCIA (a cada minuto)
//
// É o que faz o agente responder em hospedagem serverless: processa a fila de
// conversas cujo debounce já venceu. Separado do /tick porque o tick faz
// trabalho pesado (relatórios, cobrança) e não pode rodar de minuto em minuto.
// Numa VPS o worker interno já cuida disso e esta rota vira só uma rede de
// segurança — rodar as duas coisas é inofensivo (o lock impede duplicidade).
// ---------------------------------------------------------------------------
router.all('/queue', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const worker = require('../lib/queue-worker');
  try {
    const resultado = await worker.tick({
      limit: Number(req.query.limit) || 10,
      limiteSaida: Number(req.query.saida) || 20,
      origem: req.query.origem || req.headers['x-motor'] || 'cron'
    });
    res.json(resultado);
  } catch (e) {
    console.error('[cron/queue]', e);
    res.status(500).json({ error: String(e.message) });
  }
});

// ---------------------------------------------------------------------------
// /api/cron/outbox  —  só entrega, não gera resposta.
// Útil se você quiser um motor com duas cadências: entrega bem rápida e
// geração um pouco mais espaçada.
// ---------------------------------------------------------------------------
router.all('/outbox', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const outbox = require('../lib/outbox');
  try {
    await outbox.destravar();
    res.json(await outbox.drain({ limite: Number(req.query.limit) || 20 }));
  } catch (e) {
    console.error('[cron/outbox]', e);
    res.status(500).json({ error: String(e.message) });
  }
});

// ---------------------------------------------------------------------------
// /api/cron/tick  —  BAIXA FREQUÊNCIA (de hora em hora, ou diário)
// Follow-ups, relatórios, cobrança e reenvio de integrações que falharam.
// ---------------------------------------------------------------------------
router.all('/tick', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const results = { follow_ups_enviados: 0, relatorios_enviados: 0, erros: [] };

  // A fila entra aqui também: se o cron de alta frequência não estiver
  // configurado, o agente ainda responde (mais devagar) em vez de nunca.
  try {
    const worker = require('../lib/queue-worker');
    results.fila = await worker.tick({ limit: 20 });
  } catch (e) {
    results.erros.push('fila: ' + String(e.message));
  }

  try {
    results.follow_ups_enviados = await runFollowUps();
  } catch (e) {
    results.erros.push('follow-ups: ' + String(e));
  }

  try {
    results.relatorios_enviados = await runWeeklyReports();
  } catch (e) {
    results.erros.push('relatorios: ' + String(e));
  }

  try {
    results.mensalidades_marcadas_atrasadas = await checkOverduePayments();
  } catch (e) {
    results.erros.push('cobranca: ' + String(e));
  }

  // Reenvia sincronizações de CRM que falharam (rede caiu, CRM fora do ar)
  try {
    results.integracoes_reenviadas = await require('../lib/crm').retryFailed(25);
  } catch (e) {
    results.erros.push('integracoes: ' + String(e.message));
  }

  // Higiene: a fila cresce para sempre se ninguém limpar
  try {
    await pool.query(`delete from public.inbound_queue where status in ('done','error') and updated_at < now() - interval '7 days'`);
    await pool.query(`delete from public.integration_log where created_at < now() - interval '30 days'`);
  } catch { /* não crítico */ }

  res.json(results);
});

module.exports = router;
