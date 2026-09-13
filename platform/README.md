# Plataforma de Atendimento — Painel Web

App Node.js/Express + frontend simples (sem build step) que lê/escreve no mesmo
Postgres usado pelo n8n. Cada usuário loga e só vê os dados do seu `client_id`.

## Telas
- **Conversas**: lista por telefone, chat estilo WhatsApp, envio manual (handoff humano).
- **Leads**: lista, busca, filtro por status, alterar status manualmente.
- **Dashboard**: leads dos últimos 30 dias, contagem por status, tempo médio até 1ª resposta.

Atualização é por polling (a cada 5s) — simples e funciona em qualquer Postgres,
sem depender de recursos de Realtime.

## 1. Instalar
```bash
npm install
cp .env.example .env
```
Edite o `.env` com os dados do MESMO Postgres da Cloudify que o n8n usa, mais a
Evolution API (para o botão de enviar mensagem manual funcionar) e um `JWT_SECRET`
forte (gere com `openssl rand -hex 32`).

## 2. Rodar o schema extra
No mesmo banco onde já existem `clients`, `messages`, `leads`, `usage_log`, rode:
```bash
psql "postgresql://usuario:senha@host:5432/database" -f schema_platform.sql
```
Isso cria só a tabela `users` (login) e uns índices de performance.

## 3. Criar o primeiro usuário
Para cada cliente que já existe na tabela `clients`, crie um login:
```bash
node create-user.js <client_id> <email> <senha> "<Nome do usuário>"
# exemplo:
node create-user.js cliente_exemplo dono@escritorio.com senha123 "Dr. João"
```
Rode de novo com outro e-mail/senha para criar mais usuários (ex: um "agent" que
também vê as mesmas conversas — hoje o `role` é só informativo, não limita nada).

## 4. Rodar localmente (teste)
```bash
npm start
```
Acesse `http://localhost:3000`, faça login com o e-mail/senha criados no passo 3.

## 5. Deploy em produção
Qualquer VPS/serviço que rode Node.js funciona (a mesma onde está a Evolution API,
por exemplo, ou um serviço tipo Railway/Render/um droplet). Passos gerais:
1. Suba os arquivos (git clone ou upload).
2. `npm install --production`
3. Configure as variáveis de ambiente do `.env` no painel do serviço (ou arquivo `.env` na VPS).
4. Rode com um process manager, ex: `pm2 start server.js --name plataforma`
5. Configure um domínio/subdomínio (ex: `app.seudominio.com`) e HTTPS (Nginx + Certbot,
   ou o proxy já embutido no serviço de hospedagem).

## 6. Integrar com o Onboarding do n8n
Depois que o workflow `Onboarding_Cliente` cria a linha em `clients`, rode manualmente
(ou automatize depois com uma chamada HTTP a partir do próprio n8n) o `create-user.js`
para dar acesso ao dono do novo cliente.

## Limitações conhecidas (próximos passos se quiser evoluir)
- Sem recuperação de senha (adicionar depois com envio de e-mail).
- Um usuário só enxerga 1 client_id (não dá suporte a "sou dono de 2 negócios" ainda).
- Envio manual assume que o número já está no formato que a Evolution API espera
  (com DDI, ex: `5511999999999`) — ajustar no `routes/conversations.js` se sua Evolution
  usar outro formato.
