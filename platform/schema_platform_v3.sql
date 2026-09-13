-- Rode depois do schema_platform.sql e schema_platform_v2.sql. Idempotente.

-- Receita e metas
alter table public.leads add column if not exists sale_value numeric;
alter table public.leads add column if not exists sold_at timestamptz;
alter table public.clients add column if not exists monthly_goal numeric default 0;

-- Radar de leads esquecidos (horas sem resposta pra considerar "esfriando")
alter table public.clients add column if not exists radar_hours integer default 24;

-- Relatório automático por e-mail
alter table public.clients add column if not exists report_email text;
alter table public.clients add column if not exists report_enabled boolean default false;

create table if not exists public.report_log (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  period_start date not null,
  period_end date not null,
  sent_at timestamptz default now()
);
create index if not exists idx_report_log_client on public.report_log(client_id, period_end desc);

-- Follow-up de resgate (regras configuráveis por tempo sem resposta)
create table if not exists public.follow_up_rules (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  name text not null,
  wait_hours integer not null,       -- horas sem o lead responder após nossa última mensagem
  message text not null,
  media_url text,                    -- opcional: imagem/arquivo anexado ao follow-up
  active boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_followup_rules_client on public.follow_up_rules(client_id, active);

-- Log de envios (evita mandar o mesmo follow-up várias vezes pro mesmo silêncio)
create table if not exists public.follow_up_log (
  id bigserial primary key,
  client_id text not null,
  phone text not null,
  rule_id bigint not null references public.follow_up_rules(id) on delete cascade,
  sent_at timestamptz default now()
);
create index if not exists idx_followup_log_lookup on public.follow_up_log(client_id, phone, rule_id, sent_at desc);
