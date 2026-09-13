require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// ---------------------------------------------------------------------------
// CORS: a API pública v1 é chamada de qualquer origem (é o objetivo dela);
// o painel não deveria ser. `cors()` sem argumento liberava tudo para todas as
// rotas, inclusive as autenticadas por JWT.
// ---------------------------------------------------------------------------
const origensPermitidas = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use('/api/v1', cors());               // API pública: aberta por design
app.use('/api/inbound', cors());          // webhook da Evolution
app.use(cors({
  origin: origensPermitidas.length ? origensPermitidas : true,
  credentials: true
}));

app.use(express.json({ limit: '25mb' }));
app.set('trust proxy', 1);

// Log de requisição enxuto — o suficiente para investigar sem virar ruído
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const t = Date.now();
    res.on('finish', () => {
      if (res.statusCode >= 400 || Date.now() - t > 3000) {
        console.log(`[http] ${res.statusCode} ${req.method} ${req.path} ${Date.now() - t}ms`);
      }
    });
  }
  next();
});

// --- Rotas do painel -------------------------------------------------------
app.use('/api/auth', require('../routes/auth'));
app.use('/api/conversations', require('../routes/conversations'));
app.use('/api/leads', require('../routes/leads'));
app.use('/api/metrics', require('../routes/metrics'));
app.use('/api/agent', require('../routes/agent'));
app.use('/api/admin', require('../routes/admin'));
app.use('/api/quick-replies', require('../routes/quick-replies'));
app.use('/api/team', require('../routes/team'));
app.use('/api/alerts', require('../routes/alerts'));
app.use('/api/webhooks', require('../routes/webhooks'));
app.use('/api/simulate', require('../routes/simulate'));
app.use('/api/follow-up-rules', require('../routes/follow-up-rules'));
app.use('/api/upload', require('../routes/upload'));
app.use('/api/cron', require('../routes/cron'));
app.use('/api/lead-notes', require('../routes/lead-notes'));
app.use('/api/knowledge', require('../routes/knowledge'));

// --- Novas (v6) ------------------------------------------------------------
app.use('/api/inbound', require('../routes/inbound'));           // Evolution -> plataforma
app.use('/api/v1', require('../routes/public-api'));             // plataforma -> sistemas do cliente
app.use('/api/integrations', require('../routes/integrations')); // CRMs, chaves, webhooks
app.use('/api/assets', require('../routes/assets'));             // arquivos que o agente envia
app.use('/api/playbook', require('../routes/playbook'));         // configuração do vendedor
app.use('/api/onboarding', require('../routes/onboarding'));     // criação de cliente em 1 passo

// --- Saúde -----------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const pool = require('../db');
  const health = { ok: true, versao: '6.0.0', hora: new Date().toISOString(), checagens: {} };

  try {
    const t = Date.now();
    await pool.query('select 1');
    health.checagens.banco = { ok: true, ms: Date.now() - t };
  } catch (e) {
    health.ok = false;
    health.checagens.banco = { ok: false, erro: e.message };
  }

  health.checagens.evolution = { configurado: require('../lib/evolution').isConfigured() };
  health.checagens.openai = { configurado: !!process.env.OPENAI_API_KEY };
  health.checagens.criptografia = { configurado: !!process.env.ENCRYPTION_KEY };

  try {
    const { rows } = await pool.query(
      `select count(*) filter (where status='pending')::int as pendentes,
              count(*) filter (where status='error')::int as erros,
              coalesce(max(extract(epoch from (now() - process_after))) filter (where status='pending'),0)::int as atraso_s
         from public.inbound_queue`
    );
    health.checagens.fila_entrada = rows[0];
    if (rows[0].atraso_s > 120) health.ok = false;
  } catch { /* migração v6 ainda não rodou */ }

  try {
    const { rows } = await pool.query(
      `select count(*) filter (where status='pending')::int as pendentes,
              count(*) filter (where status='error')::int as erros,
              coalesce(max(extract(epoch from (now() - send_after))) filter (where status='pending' and send_after <= now()),0)::int as atraso_s
         from public.outbound_queue`
    );
    health.checagens.fila_saida = rows[0];
    if (rows[0].atraso_s > 120) health.ok = false;
  } catch { /* migração v7 ainda não rodou */ }

  // O MOTOR ESTÁ VIVO?
  // Esta é a checagem mais importante do modo gratuito: se o n8n parar de
  // disparar o tick, tudo o mais continua "verde" enquanto ninguém é
  // respondido. Aqui isso aparece como falha, em segundos.
  try {
    const { rows } = await pool.query(
      `select origem, extract(epoch from (now() - ultimo_em))::int as segundos_atras
         from public.heartbeat where nome = 'motor'`
    );
    if (rows[0]) {
      const h = rows[0];
      const limite = Number(process.env.MOTOR_ALERTA_SEGUNDOS || 180);
      health.checagens.motor = {
        origem: h.origem,
        ultimo_tick_ha_segundos: h.segundos_atras,
        ok: h.segundos_atras <= limite,
        ...(h.segundos_atras > limite
          ? { alerta: `O motor não roda há ${h.segundos_atras}s. Verifique se o workflow "1 · Motor" está ATIVO no n8n.` }
          : {})
      };
      if (h.segundos_atras > limite) health.ok = false;
    }
  } catch { /* migração v7 ainda não rodou */ }

  res.status(health.ok ? 200 : 503).json(health);
});

// --- Erros -----------------------------------------------------------------
// Sem isso, uma rejeição não tratada numa rota async derruba o processo inteiro
// em vez de devolver 500 naquela requisição.
app.use((err, req, res, _next) => {
  console.error('[erro não tratado]', req.method, req.path, err);
  if (res.headersSent) return;
  res.status(500).json({
    error: 'Erro interno',
    ...(process.env.NODE_ENV !== 'production' ? { detail: String(err.message), stack: err.stack } : {})
  });
});

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

module.exports = app;
