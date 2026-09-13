const express = require('express');
const pool = require('../db');

const router = express.Router();

// O n8n (ex: um node "Error Trigger") chama essa rota quando o agente falha.
// Protegido por uma chave simples no header x-webhook-secret.
router.post('/agent-alert', async (req, res) => {
  const secret = req.headers['x-webhook-secret'];
  if (!process.env.WEBHOOK_SECRET || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Chave inválida' });
  }
  const { client_id, message, level } = req.body || {};
  if (!client_id || !message) return res.status(400).json({ error: 'client_id e message são obrigatórios' });

  await pool.query(
    'insert into public.agent_alerts (client_id, message, level) values ($1, $2, $3)',
    [client_id, message, level || 'error']
  );
  res.json({ ok: true });
});

module.exports = router;
