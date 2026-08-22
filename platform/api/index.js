require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('../routes/auth');
const conversationsRoutes = require('../routes/conversations');
const leadsRoutes = require('../routes/leads');
const metricsRoutes = require('../routes/metrics');
const agentRoutes = require('../routes/agent');
const adminRoutes = require('../routes/admin');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);

// Não serve arquivos estáticos aqui — a Vercel serve a pasta /public sozinha.
// Não usa app.listen — a Vercel invoca este app como função serverless por request.
module.exports = app;
