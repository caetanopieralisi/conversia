require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('../routes/auth');
const conversationsRoutes = require('../routes/conversations');
const leadsRoutes = require('../routes/leads');
const metricsRoutes = require('../routes/metrics');
const agentRoutes = require('../routes/agent');
const adminRoutes = require('../routes/admin');
const quickRepliesRoutes = require('../routes/quick-replies');
const teamRoutes = require('../routes/team');
const alertsRoutes = require('../routes/alerts');
const webhooksRoutes = require('../routes/webhooks');
const simulateRoutes = require('../routes/simulate');
const followUpRulesRoutes = require('../routes/follow-up-rules');
const uploadRoutes = require('../routes/upload');
const cronRoutes = require('../routes/cron');
const leadNotesRoutes = require('../routes/lead-notes');
const knowledgeRoutes = require('../routes/knowledge');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/quick-replies', quickRepliesRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/alerts', alertsRoutes);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/simulate', simulateRoutes);
app.use('/api/follow-up-rules', followUpRulesRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/cron', cronRoutes);
app.use('/api/lead-notes', leadNotesRoutes);
app.use('/api/knowledge', knowledgeRoutes);

// Não serve arquivos estáticos aqui — a Vercel serve a pasta /public sozinha.
// Não usa app.listen — a Vercel invoca este app como função serverless por request.
module.exports = app;
