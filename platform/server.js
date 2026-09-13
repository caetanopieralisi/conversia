// Modo processo longo (VPS, Docker, Railway, Render).
// Na Vercel quem roda é api/index.js como função serverless, e a pasta /public
// é servida direto — este arquivo não é usado lá.

require('dotenv').config();
const express = require('express');
const path = require('path');
const app = require('./api/index');

const localApp = express();
localApp.use(express.static(path.join(__dirname, 'public')));
localApp.use(app);

// SPA: qualquer rota não-API cai no index.html (o roteamento é por hash)
localApp.get(/^\/(?!api\/).*/, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

const PORT = process.env.PORT || 3000;
const server = localApp.listen(PORT, () => {
  console.log(`ConversIA v6 rodando na porta ${PORT}`);

  // Fora do modo serverless, a própria aplicação processa a fila de mensagens.
  // Sem isso o agente só responderia quando o cron externo passasse.
  if (process.env.WORKER_MODE !== 'cron') {
    require('./lib/queue-worker').start({ intervalMs: Number(process.env.WORKER_INTERVAL_MS) || 3000 });
  }
});

// Encerramento limpo: termina o que está em andamento antes de sair, para não
// deixar uma conversa respondida pela metade num deploy.
for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    console.log(`\n${sinal} recebido, encerrando...`);
    server.close(async () => {
      await require('./db').end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  });
}
