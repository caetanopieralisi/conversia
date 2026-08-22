-- Rode isso UMA VEZ, depois do schema_platform.sql original.
-- Todas as instruções são idempotentes (podem rodar de novo sem erro).

-- Pausar o agente numa conversa específica (sem desligar o bot inteiro)
create table if not exists public.conversation_state (
  client_id text not null references public.clients(client_id),
  phone text not null,
  paused boolean default false,
  updated_at timestamptz default now(),
  primary key (client_id, phone)
);

-- Respostas rápidas do atendente humano
create table if not exists public.quick_replies (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  title text not null,
  content text not null,
  created_at timestamptz default now()
);

-- Alertas/erros do agente (falha na Evolution API, IA fora do ar, etc.)
create table if not exists public.agent_alerts (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  message text not null,
  level text default 'error', -- error | warning | info
  resolved boolean default false,
  created_at timestamptz default now()
);
create index if not exists idx_alerts_client on public.agent_alerts(client_id, created_at desc);

-- Plano / cobrança do cliente
alter table public.clients add column if not exists plan text default 'trial'; -- trial | pago | inadimplente
alter table public.clients add column if not exists created_at timestamptz default now();

-- Configurações globais da plataforma (ex: prompt padrão para novos clientes)
create table if not exists public.platform_settings (
  key text primary key,
  value text
);
insert into public.platform_settings (key, value)
values ('default_prompt', 'Você é um agente de atendimento simpático, objetivo e prestativo.')
on conflict (key) do nothing;

-- users.role já existe (owner|agent) — nada a alterar, só reforçando o índice de busca
create index if not exists idx_users_client on public.users(client_id);
