-- Rode depois das v1, v2 e v3. Idempotente.

-- Notas internas no lead (nunca vão pro WhatsApp)
create table if not exists public.lead_notes (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  phone text not null,
  author text,
  note text not null,
  created_at timestamptz default now()
);
create index if not exists idx_lead_notes_lookup on public.lead_notes(client_id, phone, created_at desc);

-- Base de conhecimento (RAG) — arquivos enviados pelo cliente
create table if not exists public.knowledge_sources (
  id bigserial primary key,
  client_id text not null references public.clients(client_id),
  filename text not null,
  status text default 'processando', -- processando | pronto | erro
  error_message text,
  created_at timestamptz default now()
);

-- Pedaços de texto extraídos + embedding (guardado como JSON, sem depender da extensão pgvector,
-- pra funcionar em qualquer Postgres, mesmo sem privilégio de instalar extensão)
create table if not exists public.knowledge_chunks (
  id bigserial primary key,
  client_id text not null,
  source_id bigint references public.knowledge_sources(id) on delete cascade,
  content text not null,
  embedding jsonb not null,
  created_at timestamptz default now()
);
create index if not exists idx_knowledge_chunks_client on public.knowledge_chunks(client_id);
