-- Rode isso UMA VEZ no mesmo Postgres que já tem clients/messages/leads/usage_log.
-- Cria a tabela de usuários que fazem login na plataforma, cada um amarrado a um client_id.

create table if not exists public.users (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  email text unique not null,
  password_hash text not null,
  name text,
  role text default 'owner', -- owner | agent
  created_at timestamptz default now()
);

-- Índices usados pelas telas da plataforma
create index if not exists idx_messages_client_created on public.messages(client_id, created_at desc);
create index if not exists idx_leads_client_status on public.leads(client_id, status);
