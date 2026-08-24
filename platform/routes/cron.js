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
        await sendViaEvolution(rule.evolution_instance, c.phone, rule.message, rule.media_url);
        await pool.query(
          `insert into public.messages (client_id, phone, contact_name, direction, content, processed, created_at)
           values ($1, $2, null, 'outbound', $3, true, now())`,
          [rule.client_id, c.phone, rule.message]
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

// Endpoint chamado periodicamente (Vercel Cron ou serviço externo) pra rodar follow-ups e relatórios
router.all('/tick', async (req, res) => {
  if (!checkSecret(req, res)) return;
  const results = { follow_ups_enviados: 0, relatorios_enviados: 0, erros: [] };

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

  res.json(results);
});

module.exports = router;
