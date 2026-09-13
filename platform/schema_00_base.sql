-- =============================================================================
-- ConversIA — Schema base (tabelas núcleo)
--
-- Estas tabelas foram criadas à mão no Supabase quando o projeto nasceu e nunca
-- estiveram versionadas — o que significa que ninguém conseguia recriar o banco
-- do zero (nem você, num disaster recovery, nem um cliente self-hosted).
-- Este arquivo reconstrói exatamente o que os workflows do n8n e a plataforma
-- esperam encontrar. É idempotente: rodar num banco que já tem os dados é seguro.
--
-- ORDEM DE EXECUÇÃO:
--   1. schema_00_base.sql   <- este
--   2. schema_platform.sql
--   3. schema_platform_v2.sql .. v5.sql
--   4. schema_platform_v6.sql
--
-- Ou simplesmente: npm run migrate
-- =============================================================================

create extension if not exists pgcrypto;  -- gen_random_bytes / gen_random_uuid

-- -----------------------------------------------------------------------------
-- clients — uma linha por empresa atendida (o "tenant")
-- -----------------------------------------------------------------------------
create table if not exists public.clients (
  id                   bigserial primary key,
  client_id            text unique not null,
  nome_empresa         text,
  nicho                text,
  evolution_instance   text,
  numero_responsavel   text,          -- JID do humano que recebe o handoff
  system_prompt        text,
  sheet_id             text,          -- Google Sheet espelho (legado, opcional)
  debounce_segundos    integer default 12,
  horas_para_followup  integer default 24,
  max_followups        integer default 3,
  active               boolean default true,
  created_at           timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- messages — espelho de tudo que entra e sai no WhatsApp
-- -----------------------------------------------------------------------------
create table if not exists public.messages (
  id            bigserial primary key,
  client_id     text not null,
  phone         text not null,
  contact_name  text,
  direction     text not null check (direction in ('inbound', 'outbound')),
  content       text,
  processed     boolean default false,
  created_at    timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- leads — um contato por telefone, por cliente
-- -----------------------------------------------------------------------------
create table if not exists public.leads (
  id               bigserial primary key,
  client_id        text not null,
  phone            text not null,
  name             text,
  email            text,
  summary          text,
  urgent           boolean default false,
  status           text default 'ativo',   -- ativo | aguardando_humano | fechado | vendido
  last_inbound_at  timestamptz,
  last_followup_at timestamptz,
  followup_count   integer default 0,
  created_at       timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- usage_log — consumo por conversa (base da cobrança e do controle de custo)
-- -----------------------------------------------------------------------------
create table if not exists public.usage_log (
  id          bigserial primary key,
  client_id   text not null,
  phone       text,
  chars_in    integer,
  chars_out   integer,
  created_at  timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- Reconciliação com o banco legado
--
-- "create table if not exists" é tudo ou nada: se a tabela já existe, o bloco
-- inteiro é ignorado e uma coluna que falte continua faltando — e o erro só
-- aparece em produção, na primeira escrita. Quem criou essas tabelas à mão no
-- Supabase (é o caso deste projeto) precisa deste bloco.
-- -----------------------------------------------------------------------------
alter table public.clients add column if not exists nome_empresa        text;
alter table public.clients add column if not exists nicho               text;
alter table public.clients add column if not exists evolution_instance  text;
alter table public.clients add column if not exists numero_responsavel  text;
alter table public.clients add column if not exists system_prompt       text;
alter table public.clients add column if not exists sheet_id            text;
alter table public.clients add column if not exists debounce_segundos   integer default 12;
alter table public.clients add column if not exists horas_para_followup integer default 24;
alter table public.clients add column if not exists max_followups       integer default 3;
alter table public.clients add column if not exists active              boolean default true;

alter table public.messages add column if not exists contact_name text;
alter table public.messages add column if not exists content      text;
alter table public.messages add column if not exists processed    boolean default false;
alter table public.messages add column if not exists created_at   timestamptz default now();

alter table public.leads add column if not exists name             text;
alter table public.leads add column if not exists email            text;
alter table public.leads add column if not exists summary          text;
alter table public.leads add column if not exists urgent           boolean default false;
alter table public.leads add column if not exists status           text default 'ativo';
alter table public.leads add column if not exists last_inbound_at  timestamptz;
alter table public.leads add column if not exists last_followup_at timestamptz;
alter table public.leads add column if not exists followup_count   integer default 0;

alter table public.usage_log add column if not exists phone      text;
alter table public.usage_log add column if not exists chars_in   integer;
alter table public.usage_log add column if not exists chars_out  integer;
alter table public.usage_log add column if not exists created_at timestamptz default now();

-- -----------------------------------------------------------------------------
-- Chaves estrangeiras (adicionadas só se ainda não existirem)
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_client_fk') then
    alter table public.messages
      add constraint messages_client_fk foreign key (client_id)
      references public.clients(client_id) on delete cascade;
  end if;
exception when others then
  raise notice 'messages_client_fk não criada (provavelmente há client_id órfão): %', sqlerrm;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_client_fk') then
    alter table public.leads
      add constraint leads_client_fk foreign key (client_id)
      references public.clients(client_id) on delete cascade;
  end if;
exception when others then
  raise notice 'leads_client_fk não criada (provavelmente há client_id órfão): %', sqlerrm;
end $$;

create index if not exists idx_messages_client on public.messages(client_id, created_at desc);
create index if not exists idx_leads_client on public.leads(client_id);
