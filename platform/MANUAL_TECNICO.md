# ConversIA — Manual técnico (v7)

> Para **implantar do zero**, comece por `COMECE_AQUI.md`. Este arquivo é a
> referência técnica: arquitetura, API, e o que mudou em relação ao sistema antigo.

Guia único: o que mudou, como migrar, como colocar um cliente novo no ar e como
fazer o agente vender bem.

---

## 1. O que mudou, e por quê

A mudança estrutural: **o cérebro do agente saiu do n8n e entrou na plataforma.**

O n8n é excelente para orquestrar integrações. Ele é um lugar ruim para hospedar
um agente de vendas: não dá para versionar, testar, nem fazer o modelo chamar
ferramentas. Enquanto o agente vivia lá, ele nunca ia conseguir mandar um
arquivo, ouvir um áudio ou registrar um dado no CRM — porque cada uma dessas
coisas viraria mais um ramo de nodes, e nenhum deles seria testável.

```
ANTES                                    AGORA
Evolution → n8n (40 nodes) → WhatsApp    Evolution → Plataforma → WhatsApp
            └ prompt único                          └ agente com ferramentas
            └ RAG carregando tudo                   └ busca híbrida indexada
            └ Wait node segurando 15s               └ fila com debounce
            └ SQL interpolado                       └ queries parametrizadas
```

### Problemas concretos que a v6 corrige

| # | Problema na versão anterior | Consequência real | Correção |
|---|---|---|---|
| 1 | `IF` fixo em `remoteJid == 5517991794038` | O workflow "multi-tenant" atendia **só o seu número**. Nenhum cliente real passava. | Allowlist opcional por cliente (`playbook.numeros_teste`) |
| 2 | SQL montado por interpolação em ~10 nodes | Injeção de SQL; e um lead chamado `O'Brien` quebrava a query | Tudo parametrizado (`$1, $2`) |
| 3 | RAG fazia `SELECT` de **todos** os chunks + cosseno em JS | ~3 MB de JSON por mensagem com 500 chunks; piora conforme o cliente documenta mais | Busca híbrida: full-text indexado + embedding, com pgvector quando disponível |
| 4 | `websearch_to_tsquery` (implícito) exigia todos os termos | "quanto custa o plano" não achava "O plano Essencial custa R$ 497" | Termos unidos com OR, ordenados por `ts_rank` |
| 5 | Debounce com node `Wait` | Uma execução aberta por mensagem; reinício do n8n = ninguém respondido, sem aviso | Tabela `inbound_queue` + worker com lock |
| 6 | Sem deduplicação de webhook | Retry da Evolution = cliente respondido duas vezes | Índice único em `(client_id, external_id)` |
| 7 | Sem `unique(client_id, phone)` em `leads` | Os `ON CONFLICT` dos workflows falhavam em runtime | Constraint criada na migração |
| 8 | Simulador chamava a OpenAI direto | Testava outra coisa: sem RAG, sem ferramentas, sem guardrails | Simulador usa o orquestrador real em `dryRun` |
| 9 | Uso medido em **caracteres** | Cobrança e custo desconectados da realidade | Tokens reais de entrada/saída + custo em USD |
| 10 | Credenciais de terceiros em texto puro | Um dump do banco entregaria as credenciais de todos os clientes | AES-256-GCM em repouso |
| 11 | `cors()` liberando tudo | Qualquer site podia chamar as rotas autenticadas do painel | CORS aberto só em `/api/v1` e `/api/inbound` |
| 12 | Sem tratador de erro no Express | Uma promise rejeitada derrubava o processo inteiro | Handler global + `unhandledRejection` |

---

## 2. Migração (30 minutos)

Nada é destrutivo. Os workflows antigos continuam funcionando durante a transição.

### 2.1 Banco

```bash
cd platform
npm install
cp .env.example .env       # preencha (ver seção 2.2)
npm run migrate
```

O `migrate` aplica os schemas em ordem e registra o que já rodou em
`schema_migrations`. É seguro rodar quantas vezes quiser.

Ele imprime um diagnóstico no fim:

```
Estado: 3 cliente(s), 3 com token de webhook, 5 template(s) de playbook.
Busca vetorial: fallback jsonb (funciona; ative pgvector se a base crescer)
```

> **pgvector**: se o Supabase permitir `create extension vector`, a migração ativa
> sozinha e a busca fica ~10× mais rápida. Se não permitir, o fallback em JSON
> funciona normalmente — abaixo de ~2.000 trechos por cliente a diferença não
> aparece.

### 2.2 Variáveis novas

Além das que você já tem:

```bash
ENCRYPTION_KEY=$(openssl rand -hex 32)   # obrigatória: criptografa credenciais de CRM
PUBLIC_URL=https://seu-app.vercel.app    # obrigatória: monta a URL do webhook
WORKER_MODE=cron                         # 'cron' na Vercel; vazio em VPS/Docker
```

⚠️ **Trocar `ENCRYPTION_KEY` depois tornará ilegíveis as credenciais já salvas.**
Guarde-a junto com as outras chaves.

### 2.3 Cron

Na Vercel, `vercel.json` já traz o cron da fila. Confira que existe:

```json
"crons": [
  { "path": "/api/cron/queue", "schedule": "* * * * *" },
  { "path": "/api/cron/tick",  "schedule": "0 * * * *" }
]
```

> **A partir da v7 isso mudou.** O plano gratuito da Vercel limita crons a
> 1× por dia, mas o motor não precisa mais ser o cron da Vercel: o workflow
> `1 · Motor ConversIA` do n8n chama `/api/cron/queue` a cada ~5 segundos, de
> graça. Veja `COMECE_AQUI.md`. Os crons do `vercel.json` viram apenas rede de
> segurança diária.
>
> Em VPS/Docker, deixe `WORKER_MODE` vazio: a aplicação processa a fila sozinha
> e o motor do n8n vira opcional.

Em VPS basta deixar `WORKER_MODE` vazio e rodar `npm start` (com pm2 ou Docker).

### 2.4 Apontar o WhatsApp para a plataforma

Cada cliente ganhou um `inbound_token`. Para cada instância:

```bash
# no painel admin: Clientes → (cliente) → WhatsApp → "Reconfigurar webhook"
# ou direto na Evolution API:
curl -X POST "$EVOLUTION_API_URL/webhook/set/NOME_DA_INSTANCIA" \
  -H "apikey: $EVOLUTION_API_KEY" -H 'Content-Type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"https://SEU-APP/api/inbound/TOKEN_DO_CLIENTE","events":["MESSAGES_UPSERT"]}}'
```

Pegue o token com:
```sql
select client_id, nome_empresa, inbound_token from public.clients where active;
```

### 2.5 Desligar o workflow antigo

Depois que o primeiro cliente estiver respondendo pela plataforma
(confira em `/api/health` que a fila está zerada e em Conversas que as respostas
aparecem), desative o workflow `Atendimento WhatsApp - Multi-Tenant` no n8n.

Mantenha ativo o `Workflow de Erros`, ou substitua pelos Alertas da plataforma.

### 2.6 Verificação

```bash
curl https://SEU-APP/api/health
```

Espere `"ok": true` com `banco`, `evolution`, `openai` e `criptografia` configurados.
Se `fila.atraso_s` passar de 120, o worker não está rodando.

---

## 3. Colocar um cliente novo no ar

**Antes: 7 passos manuais em 3 ferramentas. Agora: um formulário.**

Painel admin → **Novo cliente**. Ou por API:

```bash
curl -X POST https://SEU-APP/api/onboarding \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "client_id": "padaria_central",
    "nome_empresa": "Padaria Central",
    "nicho": "alimentacao",
    "owner_email": "dono@padariacentral.com.br",
    "owner_phone": "5517999998888",
    "template_slug": "ecommerce",
    "monthly_fee": 497
  }'
```

Isso cria, numa chamada: o tenant, o login (com senha temporária), a instância na
Evolution API, o webhook apontado para o token do cliente, o playbook do nicho e
duas regras de follow-up. A resposta traz o **QR code** pronto para escanear.

Depois, o cliente (ou você) completa em **Checklist**:

```
GET /api/onboarding/padaria_central/checklist
```

Ele diz o que ainda bloqueia produção. Os quatro críticos:

1. **WhatsApp conectado** — o QR escaneado
2. **Playbook preenchido** — sem ele o agente não sabe o que perguntar
3. **Base de conhecimento** — é o que impede resposta inventada
4. **Número do responsável** — sem ele não existe transferência para humano

---

## 4. Fazer o agente vender bem

Esta é a parte que dá dinheiro. Três telas, nesta ordem.

### 4.1 Seu vendedor (playbook)

O cliente **não escreve prompt**. Ele preenche campos, e a plataforma monta as
instruções. O botão "Ver as instruções geradas" mostra exatamente o que o modelo
recebe — sem caixa-preta.

Os campos que mais mudam o resultado, em ordem:

**Objeções.** É o de maior impacto e o mais ignorado. Pegue as 5 frases que seu
time mais ouve quando o cliente hesita, e a melhor resposta que vocês dão hoje.
Sem isso, o agente improvisa na hora em que a venda se decide.

**Perguntas de qualificação.** Marque como *essencial* só o que realmente trava a
venda. Sete perguntas essenciais viram interrogatório e a pessoa some.

**O que a empresa vende.** Concreto: *"consultoria de R&S para empresas de 20 a
500 funcionários, com garantia de reposição de 90 dias"* — não *"soluções em RH"*.

**Critério de qualificado.** Expressão com os nomes dos campos:
`nome e empresa e (email ou telefone)`. Quando bate, o lead vai para o CRM sozinho.

### 4.2 Base de conhecimento

**É o que separa um agente que vende de um que causa prejuízo.**

O agente foi instruído a tratar a base como única fonte de verdade sobre preço,
prazo, política e produto. Fora dela, ele diz "vou confirmar" — e um guardrail em
código neutraliza qualquer valor em reais que apareça sem respaldo na base.

Suba: tabela de preços, condições comerciais, políticas de garantia e troca,
perguntas frequentes, descrição dos produtos/serviços, prazos.

Teste em **Testar agente → "Testar só a base de conhecimento"**. Se a pergunta que
um cliente faria não retorna o trecho certo, o documento está mal escrito ou
faltando — corrija antes de culpar o modelo.

### 4.3 Arquivos do agente

Cadastre catálogo, tabela de preços, portfólio. O campo **"quando enviar"** é o
que o modelo lê para decidir a hora. Escreva como explicaria a um vendedor novo:

- ❌ `"Catálogo"`
- ✅ `"quando o cliente pedir para ver os produtos, perguntar o que temos disponível, ou pedir fotos"`

### 4.4 Medir antes de publicar

```bash
npm run eval -- --client=padaria_central
```

Roda 8 cenários de cliente difícil (vago, pergunta preço, objeção, pede humano,
fica monossilábico...) e um modelo avaliador dá nota nos critérios de venda.
Sai com código de erro se um cenário **crítico** falhar — dá para usar em CI.

Cenários críticos: inventar preço, não transferir quando pedem humano, não
registrar a qualificação. São os três que custam dinheiro de verdade.

---

## 5. Integrações

### 5.1 Conectar um CRM

Painel → **Integrações** → escolher. Já vêm prontos:

| CRM | O que faz |
|---|---|
| HubSpot | Contato + negócio no pipeline + a conversa como nota |
| Pipedrive | Pessoa + negócio + nota |
| RD Station | Conversão com os campos da qualificação |
| Kommo (amoCRM) | Lead + contato + nota |
| **Webhook** | Qualquer outro sistema, Zapier, Make, n8n, ERP interno |

A credencial é testada no momento de salvar — você descobre que o token está
errado ali, não na primeira venda perdida.

Os eventos disparados: `lead.created`, `lead.qualified`, `lead.won`, `lead.lost`,
`handoff.requested`, `stage.changed`, `message.received`.

Falhas entram em fila de reenvio com backoff (5, 20, 45, 80, 125 min) e aparecem
em **Histórico**.

### 5.2 O sistema do cliente chamando a plataforma

Painel → **Integrações** → **Chaves de API**. Autenticação por `X-API-Key`.

```bash
# formulário do site cria o lead
curl -X POST https://SEU-APP/api/v1/leads \
  -H "X-API-Key: cvia_..." -H 'Content-Type: application/json' \
  -d '{"phone":"5511999998888","name":"Marina","qualification":{"produto":"plano pro"}}'

# o ERP marca a venda; o follow-up para sozinho
curl -X POST https://SEU-APP/api/v1/leads/5511999998888/status \
  -H "X-API-Key: cvia_..." -H 'Content-Type: application/json' \
  -d '{"status":"vendido","sale_value":4970}'

# disparar uma mensagem (pausa o agente por 2h automaticamente)
curl -X POST https://SEU-APP/api/v1/messages \
  -H "X-API-Key: cvia_..." -H 'Content-Type: application/json' \
  -d '{"phone":"5511999998888","text":"Sua proposta está pronta!"}'
```

Endpoints: `GET /me`, `GET|POST /leads`, `GET /leads/:phone`,
`POST /leads/:phone/status`, `GET /conversations/:phone/messages`,
`POST /messages`, `POST /conversations/:phone/agent`, `GET /metrics`.

### 5.3 Webhooks de saída

Painel → **Integrações** → **Webhooks**. Cada envio é assinado:

```
X-ConversIA-Timestamp: 1756819200
X-ConversIA-Signature: sha256=<hmac>
```

Valide assim (o timestamp entra no cálculo para impedir replay):

```js
const esperado = 'sha256=' + crypto
  .createHmac('sha256', SEU_SEGREDO)
  .update(`${req.headers['x-conversia-timestamp']}.${corpoBruto}`)
  .digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(req.headers['x-conversia-signature']))) {
  return res.status(401).end();
}
```

---

## 6. Operação

### Saúde

`GET /api/health` — banco, integrações configuradas e estado da fila.
Aponte seu monitoramento (UptimeRobot, BetterStack) para ele. Ele responde **503**
quando o banco cai ou a fila atrasa mais de 2 minutos.

### Sintomas e causas

| Sintoma | Causa provável | Onde olhar |
|---|---|---|
| Agente não responde | Worker parado ou cron não configurado | `/api/health` → `fila.atraso_s` |
| Responde muito devagar | Debounce alto, ou cron de 1 minuto em serverless | Playbook → segundos de espera |
| Inventa preço | Base de conhecimento vazia ou mal indexada | Testar agente → testar a base |
| Não manda arquivo | `description` do arquivo genérica demais | Arquivos → "quando enviar" |
| Não transfere | Sem número do responsável | Playbook → WhatsApp de transferência |
| Lead não chega no CRM | Credencial expirada | Integrações → Histórico |
| Responde duas vezes | Workflow antigo do n8n ainda ativo | Desative-o |

### Custos

`usage_log` grava tokens reais e custo em USD por chamada. Uma conversa típica de
qualificação com `gpt-4.1-mini` fica em torno de US$ 0,01–0,03. O simulador mostra
o custo de cada mensagem, o que ajuda a precificar a mensalidade com margem real.

Proteções: `monthly_message_limit` por cliente e `max_agent_turns` por conversa.

### Testes

```bash
npm test                                   # 40 testes das funções puras (sem banco)
PGHOST=... npm run test:all                # + 14 de integração ponta a ponta
npm run eval -- --client=X                 # qualidade de venda (consome API)
```

---

## 7. Arquitetura

```
platform/
├── api/index.js              Express: rotas, CORS, health, tratamento de erro
├── lib/
│   ├── agent/
│   │   ├── orchestrator.js   Loop principal: contexto → tools → guardrails → envio
│   │   ├── salesPrompt.js    Playbook → prompt de vendas
│   │   ├── tools.js          5 ferramentas do agente
│   │   ├── rag.js            Busca híbrida (full-text + embedding, fusão RRF)
│   │   ├── guardrails.js     Anti-invenção, anti-loop, anti-vazamento
│   │   └── humanize.js       Limpeza + quebra em bolhas + delay de digitação
│   ├── crm/                  Adaptadores de CRM (um arquivo por integração)
│   ├── llm.js                OpenAI / Anthropic / compatíveis + custo
│   ├── evolution.js          Cliente da Evolution API
│   ├── media.js              Transcrição de áudio + leitura de imagem
│   ├── events.js             Eventos → CRM + webhooks
│   ├── queue-worker.js       Fila com debounce e lock
│   └── crypto.js             AES-256-GCM + chaves de API
├── routes/                   Uma rota por recurso
├── scripts/migrate.js        Migração versionada
└── scripts/eval-agente.js    Avaliação de qualidade de venda
```

### Como uma mensagem vira resposta

```
1. Evolution → POST /api/inbound/:token       responde 200 em ~15ms
2. dedupe por external_id                     retry não duplica
3. áudio? transcreve · imagem? descreve       vira texto normal
4. grava mensagem + upsert do lead
5. enfileira com debounce                     mensagem nova empurra o relógio
   ─── até aqui, síncrono ───
6. worker reserva a conversa (SKIP LOCKED)    várias instâncias em paralelo, sem colisão
7. junta o buffer numa pergunta só
8. guardrails de entrada                      pausada? teto de turnos? limite do plano?
9. RAG híbrido                                trechos relevantes da base
10. monta o prompt a partir do playbook
11. loop de tool-calling (até 4 rodadas)      buscar, registrar, enviar arquivo, transferir
12. guardrails de saída                       preço sem base, loop, dado sensível
13. quebra em bolhas + "digitando..."
14. envia, grava, dispara eventos → CRM
```

### Adicionar um CRM novo

Crie `lib/crm/adapters/seu-crm.js` exportando `{ provider, label, descricao,
campos, push(event, lead, config), test(config) }` e registre em
`lib/crm/index.js`. Ele aparece no painel sozinho, com formulário gerado a partir
de `campos`. Nada mais precisa mudar.

---

## 8. Segurança — o que foi corrigido

- **Injeção de SQL** nos workflows do n8n → queries parametrizadas
- **CORS aberto** em rotas autenticadas → restrito a `CORS_ORIGINS`
- **Credenciais de CRM em texto puro** → AES-256-GCM, mascaradas na API
- **Chaves de API** guardadas como SHA-256, exibidas uma única vez
- **Webhook de entrada** com token por cliente: um token vazado expõe um cliente, não todos
- **Webhooks de saída** assinados com HMAC + timestamp (anti-replay)
- **Guardrails de saída** removem CPF, cartão e chave de API da resposta
- **Auditoria** em `audit_log` e `lead_events`

### Ainda pendente (assumido conscientemente)

- **Senha de admin padrão no código.** Defina `ADMIN_PASS_HASH` antes de produção:
  `npm run criar-admin -- SUA_SENHA`
- **Rate limit em memória** na API pública: protege uma instância só. Num cluster,
  troque por Redis.
- **Sem recuperação de senha** por e-mail.
- **Um usuário = um cliente.** Quem tem dois negócios precisa de dois logins.
