-- =============================================================================
-- ConversIA — Migração v7 (modo gratuito / n8n como motor)
-- Rode depois da v6. Idempotente.   npm run migrate
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
--
-- Na v6, responder uma conversa era uma operação longa: o agente gerava o texto
-- e, no MESMO processo, dormia 1,2 a 5 segundos entre cada bolha para simular
-- digitação. Uma resposta de 3 bolhas segurava o processo por ~10 segundos.
--
-- Isso funciona num servidor dedicado. Não funciona bem quando o motor é um
-- agendador externo chamando um endpoint: se um tick processa 5 conversas
-- sequencialmente, ele fica 50 segundos no ar, e a conversa nº 5 espera pela
-- primeira sem nenhum motivo.
--
-- A v7 separa GERAR de ENVIAR:
--
--   gerar  → grava as bolhas em outbound_queue, cada uma com seu send_after
--   enviar → um drenador manda o que já venceu e sai
--
-- Cada passo passa a durar segundos. O ritmo humano da digitação continua
-- idêntico do lado do cliente — ele é dado pelo send_after, não por um sleep.
-- Efeito colateral bom: se o processo morrer no meio, as bolhas que faltavam
-- continuam na fila e saem no tick seguinte, em vez de se perderem.
-- =============================================================================

begin;

create table if not exists public.outbound_queue (
  id            bigserial primary key,
  client_id     text not null references public.clients(client_id) on delete cascade,
  phone         text not null,

  kind          text not null default 'text',   -- text | asset
  content       text,                           -- texto da bolha
  asset_id      bigint,                         -- quando kind = 'asset'
  caption       text,

  send_after    timestamptz not null,           -- o ritmo da digitação mora aqui
  seq           integer not null default 0,     -- ordem dentro da mesma resposta

  status        text not null default 'pending', -- pending | sending | sent | error
  attempts      integer default 0,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,

  contact_name  text,
  created_at    timestamptz default now(),
  sent_at       timestamptz
);

-- O drenador pergunta sempre a mesma coisa: "o que já venceu?"
create index if not exists idx_outbound_due
  on public.outbound_queue(send_after)
  where status = 'pending';

-- Ordem garantida dentro de uma conversa (bolha 2 nunca antes da bolha 1)
create index if not exists idx_outbound_conversa
  on public.outbound_queue(client_id, phone, seq, id)
  where status in ('pending', 'sending');

create index if not exists idx_outbound_limpeza
  on public.outbound_queue(status, created_at);

-- -----------------------------------------------------------------------------
-- Observabilidade do motor
-- -----------------------------------------------------------------------------
-- Sem isso, "o agente parou de responder" vira adivinhação. Com isso, dá para
-- ver na tela de saúde quando o motor bateu pela última vez.

create table if not exists public.heartbeat (
  nome        text primary key,     -- 'motor' | 'manutencao'
  ultimo_em   timestamptz not null default now(),
  origem      text,                 -- 'n8n' | 'vercel-cron' | 'worker-interno'
  detalhe     jsonb
);

insert into public.heartbeat (nome, ultimo_em, origem)
values ('motor', now() - interval '1 hour', 'nunca-rodou')
on conflict (nome) do nothing;

commit;

-- Verificação:
-- select count(*) from public.outbound_queue;
-- select * from public.heartbeat;
