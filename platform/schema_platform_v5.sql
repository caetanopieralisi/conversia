-- Rode depois das v1-v4. Idempotente.

-- Rastreio de login (usado no radar de risco: cliente sumido = risco)
alter table public.users add column if not exists last_login timestamptz;

-- Cobrança manual (você mesmo cobra, sem gateway automático)
alter table public.clients add column if not exists monthly_fee numeric default 0;
alter table public.clients add column if not exists billing_day integer default 5;
alter table public.clients add column if not exists next_due_date date;
alter table public.clients add column if not exists payment_status text default 'em_dia'; -- em_dia | pendente | atrasado
alter table public.clients add column if not exists owner_phone text; -- telefone do dono da empresa (pra mandar cobrança/aviso)

-- Histórico de pagamentos confirmados (alimenta o gráfico de MRR/receita coletada)
create table if not exists public.payments_log (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  amount numeric not null,
  paid_at timestamptz default now()
);
create index if not exists idx_payments_log_client on public.payments_log(client_id, paid_at desc);
