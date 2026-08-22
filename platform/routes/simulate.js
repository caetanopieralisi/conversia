const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Testa o prompt atual do agente chamando a Anthropic API diretamente,
// sem passar pelo WhatsApp — pra você validar o comportamento antes de ativar.
router.post('/', async (req, res) => {
  const { clientId } = req.user;
  const { message, history } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Mensagem é obrigatória' });

  const { rows } = await pool.query('select system_prompt, nome_empresa, nicho from public.clients where client_id = $1', [clientId]);
  const client = rows[0];
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({ error: 'Simulador não configurado: defina ANTHROPIC_API_KEY nas variáveis de ambiente da plataforma.' });
  }

  const systemPrompt = client.system_prompt || `Você é o agente de atendimento da empresa ${client.nome_empresa || ''}, do ramo ${client.nicho || ''}.`;
  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: message }];

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: systemPrompt,
        messages
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: data.error?.message || 'Erro ao chamar a IA' });
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'Erro de conexão com a IA', detail: String(e) });
  }
});

module.exports = router;
