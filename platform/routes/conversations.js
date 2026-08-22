const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Lista de conversas (últimas mensagens agrupadas por telefone)
router.get('/', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    `select distinct on (m.phone)
        m.phone, m.contact_name, m.content, m.direction, m.created_at,
        coalesce(cs.paused, false) as paused,
        l.status as lead_status
     from public.messages m
     left join public.conversation_state cs on cs.client_id = m.client_id and cs.phone = m.phone
     left join public.leads l on l.client_id = m.client_id and l.phone = m.phone
     where m.client_id = $1
     order by m.phone, m.created_at desc`,
    [clientId]
  );
  rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(rows);
});

// Histórico de uma conversa específica
router.get('/:phone', async (req, res) => {
  const { clientId } = req.user;
  const { phone } = req.params;
  const { rows } = await pool.query(
    `select id, direction, content, created_at
     from public.messages
     where client_id = $1 and phone = $2
     order by created_at asc`,
    [clientId, phone]
  );
  res.json(rows);
});

// Envio manual de mensagem pelo atendente humano
router.post('/:phone/send', async (req, res) => {
  const { clientId } = req.user;
  const { phone } = req.params;
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Mensagem vazia' });

  const clientRes = await pool.query('select * from public.clients where client_id = $1', [clientId]);
  const client = clientRes.rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  try {
    const resp = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${client.evolution_instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, text: message })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Falha ao enviar via Evolution API', detail: errText });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Erro de conexão com a Evolution API', detail: String(e) });
  }

  await pool.query(
    `insert into public.messages (client_id, phone, contact_name, direction, content, processed, created_at)
     values ($1, $2, null, 'outbound', $3, true, now())`,
    [clientId, phone, message]
  );

  res.json({ ok: true });
});

// Estado de pausa da conversa (pra decidir se o bot responde ou não)
router.get('/:phone/pause', async (req, res) => {
  const { clientId } = req.user;
  const { rows } = await pool.query(
    'select paused from public.conversation_state where client_id = $1 and phone = $2',
    [clientId, req.params.phone]
  );
  res.json({ paused: rows[0]?.paused || false });
});

// Pausa/retoma o agente numa conversa específica
router.put('/:phone/pause', async (req, res) => {
  const { clientId } = req.user;
  const { phone } = req.params;
  const { paused } = req.body || {};
  await pool.query(
    `insert into public.conversation_state (client_id, phone, paused, updated_at)
     values ($1, $2, $3, now())
     on conflict (client_id, phone) do update set paused = $3, updated_at = now()`,
    [clientId, phone, !!paused]
  );
  res.json({ ok: true, paused: !!paused });
});

// Envio de mídia (imagem/arquivo por URL) pelo atendente humano
router.post('/:phone/send-media', async (req, res) => {
  const { clientId } = req.user;
  const { phone } = req.params;
  const { url, caption } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL da mídia é obrigatória' });

  const clientRes = await pool.query('select * from public.clients where client_id = $1', [clientId]);
  const client = clientRes.rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  try {
    const resp = await fetch(`${process.env.EVOLUTION_API_URL}/message/sendMedia/${client.evolution_instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, mediatype: 'image', media: url, caption: caption || '' })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(502).json({ error: 'Falha ao enviar via Evolution API', detail: errText });
    }
  } catch (e) {
    return res.status(502).json({ error: 'Erro de conexão com a Evolution API', detail: String(e) });
  }

  await pool.query(
    `insert into public.messages (client_id, phone, contact_name, direction, content, processed, created_at)
     values ($1, $2, null, 'outbound', $3, true, now())`,
    [clientId, phone, caption ? `[imagem] ${caption}` : '[imagem]']
  );
  res.json({ ok: true });
});

module.exports = router;
