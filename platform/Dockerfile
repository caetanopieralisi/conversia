# Imagem para rodar na sua VPS (a mesma que já hospeda o n8n e a Evolution API).
#
# Quando usar em vez da Vercel:
#   • custo zero adicional — a máquina já está paga e ligada
#   • o worker roda dentro do processo: não depende do motor do n8n
#   • sem cold start, sem limite de execução
#
# Migrar da Vercel para cá não muda uma linha de código: é a variável
# WORKER_MODE que decide quem processa a fila.

FROM node:22-alpine

# unzip: usado para extrair texto de .docx na base de conhecimento
# tini: garante que SIGTERM chegue ao Node (encerramento limpo no deploy)
RUN apk add --no-cache unzip tini

WORKDIR /app

# Camada de dependências separada: só reinstala quando o package.json muda
COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

# Não roda como root
RUN addgroup -g 1001 conversia && adduser -D -u 1001 -G conversia conversia \
 && chown -R conversia:conversia /app
USER conversia

ENV NODE_ENV=production \
    PORT=3000 \
    WORKER_MODE= \
    DELIVERY_MODE=outbox

EXPOSE 3000

# O healthcheck usa a mesma rota que o Vigia do n8n consulta.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
