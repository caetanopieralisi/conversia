// Este arquivo é usado SO para rodar localmente (npm start).
// Na Vercel, quem roda é api/index.js (funcao serverless) + a pasta /public servida direto.
require('dotenv').config();
const express = require('express');
const path = require('path');
const app = require('./api/index');

const localApp = express();
localApp.use(express.static(path.join(__dirname, 'public')));
localApp.use(app); // monta as rotas /api/* por cima dos arquivos estaticos

const PORT = process.env.PORT || 3000;
localApp.listen(PORT, () => console.log(`Plataforma (modo local) rodando na porta ${PORT}`));
