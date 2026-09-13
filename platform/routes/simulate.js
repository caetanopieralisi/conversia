// =============================================================================
// Simulador — testa o agente REAL, sem WhatsApp.
//
// O simulador antigo chamava a OpenAI direto com o system_prompt cru. Ou seja:
// testava outra coisa. RAG, ferramentas, guardrails e a quebra em mensagens
// nada disso passava por ali — o que se via no simulador não era o que o
// cliente recebia no WhatsApp.
//
// Agora ele roda o mesmo orquestrador da produção, com dryRun: nada é enviado,
// nada é gravado em `messages`, mas todo o resto acontece de verdade — e a
// resposta traz o rastro (o que buscou, que ferramenta chamou, quanto custou).
// =============================================================================

const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../auth');
const orchestrator = require('../lib/agent/orchestrator');
const rag = require('../lib/agent/rag');

const router = express.Router();
router.use(requireAuth);

const asyncH = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Telefone reservado para o simulador: isola o estado da conversa de teste dos
// contatos reais, e mantém a memória entre mensagens da mesma sessão de teste.
const jidTeste = (clientId, sessao = 'default') =>
  `sim-${sessao}-${clientId}@simulador.local`;

router.post('/', asyncH(async (req, res) => {
  const { message, sessao, reset } = req.body || {};
  if (!message?.trim() && !reset) return res.status(400).json({ error: 'Escreva uma mensagem' });

  const clientId = req.user.clientId;
  const phone = jidTeste(clientId, sessao);

  if (reset) {
    await pool.query('delete from public.messages where client_id = $1 and phone = $2', [clientId, phone]);
    await pool.query('delete from public.conversation_state where client_id = $1 and phone = $2', [clientId, phone]);
    await pool.query('delete from public.leads where client_id = $1 and phone = $2', [clientId, phone]);
    if (!message?.trim()) return res.json({ ok: true, reset: true, messages: [] });
  }

  // O lead de teste precisa existir: as ferramentas gravam nele.
  await pool.query(
    `insert into public.leads (client_id, phone, name, status, source, created_at, last_inbound_at)
     values ($1,$2,'[simulador]','ativo','simulador', now(), now())
     on conflict (client_id, phone) do update set last_inbound_at = now()`,
    [clientId, phone]
  );

  // Grava a mensagem do "cliente" para o agente ter histórico entre turnos
  await pool.query(
    `insert into public.messages (client_id, phone, direction, content, processed, created_at)
     values ($1,$2,'inbound',$3,true, now())`,
    [clientId, phone, message]
  );

  const started = Date.now();
  const result = await orchestrator.respond({
    clientId, phone, text: message, contactName: '[simulador]', dryRun: true
  });

  // Espelha a resposta no histórico (dryRun não escreve sozinho)
  for (const m of result.messages) {
    await pool.query(
      `insert into public.messages (client_id, phone, direction, content, processed, author, created_at)
       values ($1,$2,'outbound',$3,true,'agent', now())`,
      [clientId, phone, m]
    );
  }

  const custo = (result.usage || []).reduce((s, u) => s + (u.costUsd || 0), 0);

  res.json({
    messages: result.messages,
    // Tudo abaixo é o diagnóstico: é o que permite ajustar o playbook com base
    // em evidência em vez de tentativa e erro.
    diagnostico: {
      estagio: result.stage,
      coletado: result.collected,
      handoff: result.handoff,
      ferramentas_usadas: result.trace,
      trechos_de_conhecimento: result.knowledgeUsed,
      arquivos_enviados: (result.effects || []).filter(e => e.type === 'asset').map(e => e.asset.name),
      custo_usd: Number(custo.toFixed(6)),
      tempo_ms: Date.now() - started,
      modelo: result.usage?.find(u => u.kind === 'chat')?.model
    }
  });
}));

/** Testa só a busca na base de conhecimento — útil para depurar RAG. */
router.post('/knowledge', asyncH(async (req, res) => {
  const { pergunta } = req.body || {};
  if (!pergunta) return res.status(400).json({ error: 'Escreva a pergunta' });

  const found = await rag.search(req.user.clientId, pergunta, { limit: 8 });
  res.json({
    estrategia: found.strategy,
    total: found.chunks.length,
    trechos: found.chunks.map(c => ({
      conteudo: c.content.slice(0, 400),
      score: Number((c.score || 0).toFixed(4)),
      origem: c.title
    })),
    aviso: found.chunks.length === 0
      ? 'Nada encontrado. O agente vai dizer que não sabe — que é o comportamento correto. Se ele deveria saber, suba o documento na Base de conhecimento.'
      : null
  });
}));

router.get('/history', asyncH(async (req, res) => {
  const phone = jidTeste(req.user.clientId, req.query.sessao);
  const { rows } = await pool.query(
    'select direction, content, created_at from public.messages where client_id = $1 and phone = $2 order by created_at asc',
    [req.user.clientId, phone]
  );
  res.json(rows);
}));

module.exports = router;
