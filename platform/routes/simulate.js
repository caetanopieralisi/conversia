const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Testa o prompt atual do agente chamando a OpenAI diretamente,
// sem passar pelo WhatsApp — pra você validar o comportamento antes de ativar.
router.post('/', async (req, res) => {
  const { clientId } = req.user;
  const { message, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Mensagem é obrigatória' });

  const { rows } = await pool.query('select system_prompt, nome_empresa, nicho from public.clients where client_id = $1', [clientId]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(400).json({ error: 'Simulador não configurado: defina OPENAI_API_KEY nas variáveis de ambiente da Vercel.' });
  }

  const systemPrompt = client.system_prompt || `Você é o agente de atendimento da empresa ${client.nome_empresa || ''}, do ramo ${client.nicho || ''}.`;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: message }
  ];

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages,
        max_tokens: 500
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: data.error?.message || 'Erro ao chamar a IA' });
    const reply = data.choices?.[0]?.message?.content || '';
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'Erro de conexão com a IA', detail: String(e) });
  }
});

module.exports = router;
