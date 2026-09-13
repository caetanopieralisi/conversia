-- =============================================================================
-- ConversIA — Migração v6
-- Rode DEPOIS de schema_platform.sql e das v2..v5. Tudo idempotente.
--   psql "$DATABASE_URL" -f schema_platform_v6.sql
--
-- O que essa migração entrega:
--   1. Playbook de vendas por cliente (o agente deixa de depender de prompt cru)
--   2. Biblioteca de arquivos que o agente envia sozinho (catálogo, tabela, portfólio)
--   3. Busca híbrida na base de conhecimento (full-text nativo + embedding), sem
--      precisar da extensão pgvector — mas usando ela se estiver disponível
--   4. Fila de mensagens com debounce e deduplicação (substitui o Wait node do n8n)
--   5. Integrações de CRM + API pública com chaves + webhooks de saída
--   6. Custo real por conversa (tokens de entrada/saída, não estimativa por caractere)
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Correções estruturais no que já existe
-- -----------------------------------------------------------------------------

-- O upsert de leads depende de (client_id, phone) ser único. Se essa constraint
-- não existir, o ON CONFLICT dos workflows falha silenciosamente em runtime.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leads_client_phone_key' and conrelid = 'public.leads'::regclass
  ) then
    -- remove duplicatas antes de criar o índice único
    delete from public.leads a using public.leads b
      where a.ctid < b.ctid and a.client_id = b.client_id and a.phone = b.phone;
    alter table public.leads add constraint leads_client_phone_key unique (client_id, phone);
  end if;
end $$;

alter table public.leads add column if not exists created_at timestamptz default now();
alter table public.leads add column if not exists last_followup_at timestamptz;
alter table public.leads add column if not exists followup_count integer default 0;
alter table public.leads add column if not exists score integer default 0;
alter table public.leads add column if not exists stage text default 'novo';
alter table public.leads add column if not exists qualification jsonb default '{}'::jsonb;
alter table public.leads add column if not exists lost_reason text;
alter table public.leads add column if not exists source text default 'whatsapp';
alter table public.leads add column if not exists owner_user_id bigint;

-- Mensagens: mídia, transcrição e id externo (dedupe)
alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text;      -- image | audio | video | document | sticker
alter table public.messages add column if not exists transcript text;      -- áudio transcrito / imagem descrita
alter table public.messages add column if not exists external_id text;     -- key.id da Evolution API
alter table public.messages add column if not exists author text;          -- 'agent' | 'human:<email>' | 'system'

-- Dedupe de webhook: a Evolution reenvia o mesmo evento em retry.
create unique index if not exists uq_messages_external
  on public.messages(client_id, external_id) where external_id is not null;

create index if not exists idx_messages_phone_created
  on public.messages(client_id, phone, created_at desc);
create index if not exists idx_messages_unprocessed
  on public.messages(client_id, phone) where processed = false and direction = 'inbound';

-- -----------------------------------------------------------------------------
-- 1. Configuração do agente por cliente
-- -----------------------------------------------------------------------------

alter table public.clients add column if not exists llm_provider text default 'openai';   -- openai | anthropic | compatible
alter table public.clients add column if not exists llm_model text default 'gpt-4.1-mini';
alter table public.clients add column if not exists llm_temperature numeric default 0.6;
alter table public.clients add column if not exists timezone text default 'America/Sao_Paulo';
alter table public.clients add column if not exists business_hours jsonb default
  '{"enabled":false,"tz":"America/Sao_Paulo","dias":{"1":["08:00","18:00"],"2":["08:00","18:00"],"3":["08:00","18:00"],"4":["08:00","18:00"],"5":["08:00","18:00"]},"fora_horario":"Nosso time atende de segunda a sexta, das 8h às 18h. Já anotei sua mensagem e retornamos assim que abrirmos."}'::jsonb;

-- O playbook: é daqui que o prompt de vendas é MONTADO. O cliente preenche
-- campos no painel; o system prompt é gerado por código (lib/agent/salesPrompt.js).
alter table public.clients add column if not exists playbook jsonb default '{}'::jsonb;

-- Limites e proteção de custo
alter table public.clients add column if not exists monthly_message_limit integer default 0; -- 0 = ilimitado
alter table public.clients add column if not exists max_agent_turns integer default 12;      -- por conversa antes de sugerir humano
alter table public.clients add column if not exists agent_enabled boolean default true;
alter table public.clients add column if not exists audio_enabled boolean default true;
alter table public.clients add column if not exists vision_enabled boolean default true;
alter table public.clients add column if not exists voice_reply_enabled boolean default false; -- responder em áudio
alter table public.clients add column if not exists debounce_segundos integer default 12;
alter table public.clients add column if not exists inbound_token text;  -- token do webhook de entrada dedicado

-- Token único por cliente para o webhook de entrada (Evolution posta direto aqui)
update public.clients
   set inbound_token = encode(gen_random_bytes(16), 'hex')
 where inbound_token is null;

create unique index if not exists uq_clients_inbound_token on public.clients(inbound_token);
create index if not exists idx_clients_instance on public.clients(evolution_instance) where active;

-- -----------------------------------------------------------------------------
-- 2. Biblioteca de arquivos que o agente envia sozinho
-- -----------------------------------------------------------------------------
-- O agente recebe a lista (nome + quando_usar) e decide chamar a ferramenta
-- enviar_arquivo. É isso que faz ele mandar catálogo/tabela de preço na hora certa.

create table if not exists public.assets (
  id            bigserial primary key,
  client_id     text not null references public.clients(client_id) on delete cascade,
  name          text not null,              -- "Catálogo 2026"
  description   text not null,              -- "Quando o cliente pedir para ver os produtos"
  url           text not null,
  mime_type     text,
  kind          text not null default 'document', -- document | image | video | audio
  file_name     text,
  keywords      text,                       -- termos que reforçam o match
  send_count    integer default 0,
  active        boolean default true,
  created_at    timestamptz default now()
);
create index if not exists idx_assets_client on public.assets(client_id) where active;

-- -----------------------------------------------------------------------------
-- 3. Base de conhecimento: busca híbrida
-- -----------------------------------------------------------------------------
-- Antes: SELECT de TODOS os chunks + cosseno em JS a cada mensagem. Com 500 chunks
-- isso são ~3MB de JSON trafegando por mensagem. Agora: full-text nativo do
-- Postgres filtra os candidatos, e o cosseno roda só em cima do topo.

alter table public.knowledge_chunks add column if not exists title text;
alter table public.knowledge_chunks add column if not exists position integer default 0;
alter table public.knowledge_chunks add column if not exists tokens integer;

-- Coluna gerada de full-text em português. STORED = calculada uma vez na escrita.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'knowledge_chunks' and column_name = 'content_tsv'
  ) then
    alter table public.knowledge_chunks
      add column content_tsv tsvector
      generated always as (to_tsvector('portuguese', coalesce(content, ''))) stored;
  end if;
end $$;

create index if not exists idx_knowledge_tsv on public.knowledge_chunks using gin(content_tsv);
create index if not exists idx_knowledge_client_source on public.knowledge_chunks(client_id, source_id);

-- Se o Postgres tiver pgvector disponível, usamos. Se não, o código cai no
-- caminho jsonb + cosseno em JS automaticamente. Nenhum dos dois é obrigatório.
do $$
begin
  begin
    create extension if not exists vector;
  exception when others then
    raise notice 'pgvector indisponível — usando fallback jsonb (funciona normalmente)';
  end;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'vector') then
    if not exists (
      select 1 from information_schema.columns
      where table_schema='public' and table_name='knowledge_chunks' and column_name='embedding_vec'
    ) then
      alter table public.knowledge_chunks add column embedding_vec vector(1536);
    end if;
    -- backfill do que já existe em jsonb
    execute 'update public.knowledge_chunks
                set embedding_vec = (
                  select array_agg(x::float4)::vector
                  from jsonb_array_elements_text(embedding) as t(x)
                )
              where embedding_vec is null and jsonb_array_length(embedding) = 1536';
    begin
      execute 'create index if not exists idx_knowledge_vec on public.knowledge_chunks
               using hnsw (embedding_vec vector_cosine_ops)';
    exception when others then
      execute 'create index if not exists idx_knowledge_vec on public.knowledge_chunks
               using ivfflat (embedding_vec vector_cosine_ops) with (lists = 100)';
    end;
  end if;
end $$;

alter table public.knowledge_sources add column if not exists source_type text default 'file'; -- file | url | text
alter table public.knowledge_sources add column if not exists source_url text;
alter table public.knowledge_sources add column if not exists char_count integer;
alter table public.knowledge_sources add column if not exists updated_at timestamptz default now();

-- -----------------------------------------------------------------------------
-- 4. Fila de entrada com debounce e deduplicação
-- -----------------------------------------------------------------------------
-- Substitui o node Wait do n8n. A Evolution posta na fila e responde 200 na hora;
-- um worker (cron a cada minuto, ou o próprio request) processa o que venceu.
-- Vantagem: nada fica "aberto", e se o processo cair a mensagem continua na fila.

create table if not exists public.inbound_queue (
  id            bigserial primary key,
  client_id     text not null references public.clients(client_id) on delete cascade,
  phone         text not null,
  contact_name  text,
  process_after timestamptz not null,       -- agora + debounce
  status        text not null default 'pending', -- pending | processing | done | error
  attempts      integer default 0,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Uma linha de fila por conversa pendente: mensagens novas só empurram o relógio.
create unique index if not exists uq_inbound_queue_open
  on public.inbound_queue(client_id, phone) where status in ('pending', 'processing');
create index if not exists idx_inbound_queue_due
  on public.inbound_queue(process_after) where status = 'pending';

-- -----------------------------------------------------------------------------
-- 5. Estado da conversa (memória de trabalho do vendedor)
-- -----------------------------------------------------------------------------

-- updated_at nasce no create-table do v2. Num banco onde conversation_state já
-- existia (criada à mão para o workflow antigo), aquele create foi ignorado e a
-- coluna não existe — o que só apareceria em runtime, na primeira pausa.
alter table public.conversation_state add column if not exists updated_at timestamptz default now();

alter table public.conversation_state add column if not exists stage text default 'abertura';
  -- abertura | descoberta | apresentacao | objecao | fechamento | pos_venda | humano
alter table public.conversation_state add column if not exists summary text;
alter table public.conversation_state add column if not exists collected jsonb default '{}'::jsonb;
alter table public.conversation_state add column if not exists objections jsonb default '[]'::jsonb;
alter table public.conversation_state add column if not exists agent_turns integer default 0;
alter table public.conversation_state add column if not exists last_agent_run timestamptz;
alter table public.conversation_state add column if not exists paused_by text;
alter table public.conversation_state add column if not exists paused_until timestamptz;

-- Timeline auditável do lead: tudo que aconteceu, para o painel e para o CRM.
create table if not exists public.lead_events (
  id          bigserial primary key,
  client_id   text not null references public.clients(client_id) on delete cascade,
  phone       text not null,
  type        text not null,   -- lead.created | stage.changed | asset.sent | handoff.requested
                               -- | lead.qualified | lead.won | lead.lost | crm.synced | note.added
  payload     jsonb default '{}'::jsonb,
  actor       text default 'agent',
  created_at  timestamptz default now()
);
create index if not exists idx_lead_events_lookup on public.lead_events(client_id, phone, created_at desc);
create index if not exists idx_lead_events_type on public.lead_events(client_id, type, created_at desc);

-- -----------------------------------------------------------------------------
-- 6. Integrações com CRM
-- -----------------------------------------------------------------------------

create table if not exists public.integrations (
  id            bigserial primary key,
  client_id     text not null references public.clients(client_id) on delete cascade,
  provider      text not null,      -- hubspot | pipedrive | rdstation | kommo | webhook | sheets
  label         text,
  credentials   jsonb not null default '{}'::jsonb, -- token/api_key/base_url (criptografado em repouso pelo app)
  config        jsonb not null default '{}'::jsonb, -- pipeline_id, stage mapping, owner, custom fields
  field_map     jsonb not null default '{}'::jsonb, -- { "nome": "firstname", "email": "email", ... }
  events        text[] not null default array['lead.created','lead.qualified','lead.won','handoff.requested'],
  direction     text not null default 'outbound',   -- outbound | inbound | both
  active        boolean default true,
  last_sync_at  timestamptz,
  last_error    text,
  created_at    timestamptz default now()
);
create index if not exists idx_integrations_client on public.integrations(client_id) where active;

create table if not exists public.integration_log (
  id              bigserial primary key,
  client_id       text not null,
  integration_id  bigint references public.integrations(id) on delete cascade,
  event           text not null,
  phone           text,
  direction       text default 'outbound',
  status          text not null,      -- ok | error | retrying
  http_status     integer,
  request_body    jsonb,
  response_body   jsonb,
  attempts        integer default 1,
  next_retry_at   timestamptz,
  created_at      timestamptz default now()
);
create index if not exists idx_integration_log_client on public.integration_log(client_id, created_at desc);
create index if not exists idx_integration_log_retry on public.integration_log(next_retry_at)
  where status = 'retrying';

-- Chaves de API para sistemas externos falarem COM a plataforma
create table if not exists public.api_keys (
  id            bigserial primary key,
  client_id     text not null references public.clients(client_id) on delete cascade,
  name          text not null,
  key_prefix    text not null,          -- 8 primeiros chars, mostrados no painel
  key_hash      text not null,          -- sha256 da chave completa
  scopes        text[] not null default array['leads:read','leads:write','messages:send','conversations:read'],
  last_used_at  timestamptz,
  revoked       boolean default false,
  created_at    timestamptz default now()
);
create unique index if not exists uq_api_keys_hash on public.api_keys(key_hash);
create index if not exists idx_api_keys_client on public.api_keys(client_id) where not revoked;

-- Webhooks de saída (a plataforma avisa o sistema do cliente)
create table if not exists public.webhook_endpoints (
  id            bigserial primary key,
  client_id     text not null references public.clients(client_id) on delete cascade,
  url           text not null,
  secret        text not null,          -- usado no HMAC-SHA256 da assinatura
  events        text[] not null default array['lead.created','lead.qualified','lead.won','handoff.requested','message.received'],
  active        boolean default true,
  failure_count integer default 0,
  created_at    timestamptz default now()
);
create index if not exists idx_webhook_endpoints_client on public.webhook_endpoints(client_id) where active;

-- -----------------------------------------------------------------------------
-- 7. Custo real (não estimativa por caractere)
-- -----------------------------------------------------------------------------

alter table public.usage_log add column if not exists tokens_in integer;
alter table public.usage_log add column if not exists tokens_out integer;
alter table public.usage_log add column if not exists model text;
alter table public.usage_log add column if not exists cost_usd numeric(12,6);
alter table public.usage_log add column if not exists kind text default 'chat'; -- chat | embedding | transcription | vision
alter table public.usage_log add column if not exists latency_ms integer;
create index if not exists idx_usage_client_created on public.usage_log(client_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 8. Auditoria
-- -----------------------------------------------------------------------------

create table if not exists public.audit_log (
  id          bigserial primary key,
  client_id   text,
  actor       text,          -- email do usuário, 'admin', 'api:<prefix>', 'system'
  action      text not null,
  target      text,
  detail      jsonb,
  ip          text,
  created_at  timestamptz default now()
);
create index if not exists idx_audit_client on public.audit_log(client_id, created_at desc);

-- -----------------------------------------------------------------------------
-- 9. Templates de playbook por nicho (semente)
-- -----------------------------------------------------------------------------

create table if not exists public.playbook_templates (
  slug        text primary key,
  nome        text not null,
  nicho       text not null,
  playbook    jsonb not null,
  created_at  timestamptz default now()
);

insert into public.playbook_templates (slug, nome, nicho, playbook) values
('servicos-b2b', 'Serviços B2B / Consultoria', 'servicos', '{
  "objetivo": "Qualificar a empresa e agendar uma conversa com o time comercial",
  "tom": "consultivo, direto, caloroso",
  "perguntas_qualificacao": [
    {"campo": "nome", "pergunta": "Com quem eu falo?", "obrigatorio": true},
    {"campo": "empresa", "pergunta": "De qual empresa?", "obrigatorio": true},
    {"campo": "necessidade", "pergunta": "O que fez você procurar a gente agora?", "obrigatorio": true},
    {"campo": "tamanho", "pergunta": "Quantas pessoas tem o time?", "obrigatorio": false},
    {"campo": "prazo", "pergunta": "É algo pra resolver com urgência ou está avaliando?", "obrigatorio": true},
    {"campo": "email", "pergunta": "Qual o melhor e-mail para eu registrar?", "obrigatorio": true}
  ],
  "criterio_qualificado": "necessidade e prazo e (email ou empresa)",
  "nunca_falar": ["valores e condições comerciais", "prazos de entrega específicos"],
  "handoff_quando": ["lead qualificado", "pediu falar com humano", "pergunta fora do escopo", "reclamação"]
}'::jsonb),
('ecommerce', 'Loja / E-commerce', 'varejo', '{
  "objetivo": "Tirar dúvida de produto e levar o cliente até a compra",
  "tom": "ágil, simpático, prestativo",
  "perguntas_qualificacao": [
    {"campo": "produto", "pergunta": "Qual produto te interessou?", "obrigatorio": true},
    {"campo": "cidade", "pergunta": "Pra qual cidade seria a entrega?", "obrigatorio": true},
    {"campo": "nome", "pergunta": "Como é seu nome?", "obrigatorio": true}
  ],
  "criterio_qualificado": "produto e cidade",
  "nunca_falar": ["preço que não esteja na base de conhecimento", "prazo de entrega sem confirmar"],
  "handoff_quando": ["problema com pedido já feito", "pediu desconto fora da tabela", "reclamação"]
}'::jsonb),
('clinica', 'Clínica / Consultório', 'saude', '{
  "objetivo": "Entender a necessidade e agendar avaliação",
  "tom": "acolhedor, calmo, profissional",
  "perguntas_qualificacao": [
    {"campo": "nome", "pergunta": "Qual seu nome completo?", "obrigatorio": true},
    {"campo": "procedimento", "pergunta": "Qual atendimento você procura?", "obrigatorio": true},
    {"campo": "convenio", "pergunta": "Vai usar convênio ou particular?", "obrigatorio": true},
    {"campo": "preferencia_horario", "pergunta": "Prefere manhã ou tarde?", "obrigatorio": false}
  ],
  "criterio_qualificado": "nome e procedimento e convenio",
  "nunca_falar": ["diagnóstico", "orientação médica", "resultado de exame"],
  "handoff_quando": ["sintoma agudo ou emergência", "remarcação", "pergunta clínica"]
}'::jsonb),
('imobiliaria', 'Imobiliária', 'imobiliario', '{
  "objetivo": "Levantar o perfil de busca e agendar visita",
  "tom": "consultivo, atento a detalhe",
  "perguntas_qualificacao": [
    {"campo": "objetivo", "pergunta": "Você procura comprar ou alugar?", "obrigatorio": true},
    {"campo": "regiao", "pergunta": "Que região você tem em mente?", "obrigatorio": true},
    {"campo": "faixa_valor", "pergunta": "Qual faixa de valor faz sentido pra você?", "obrigatorio": true},
    {"campo": "prazo", "pergunta": "Pra quando você precisa se mudar?", "obrigatorio": false},
    {"campo": "nome", "pergunta": "Como é seu nome?", "obrigatorio": true}
  ],
  "criterio_qualificado": "objetivo e regiao e faixa_valor",
  "nunca_falar": ["condição de financiamento sem confirmar", "disponibilidade de imóvel sem checar"],
  "handoff_quando": ["quer agendar visita", "quer negociar valor", "documentação"]
}'::jsonb),
('recrutamento', 'RH / Recrutamento e Seleção', 'servicos_rh', '{
  "objetivo": "Separar candidato de empresa; candidato vai pro ATS, empresa é qualificada",
  "tom": "gentil, atencioso, seguro",
  "perguntas_qualificacao": [
    {"campo": "tipo_contato", "pergunta": "Você busca uma vaga ou representa uma empresa?", "obrigatorio": true},
    {"campo": "nome", "pergunta": "Com quem eu falo?", "obrigatorio": true},
    {"campo": "empresa", "pergunta": "Qual empresa?", "obrigatorio": false},
    {"campo": "servico", "pergunta": "Qual serviço te interessa?", "obrigatorio": false},
    {"campo": "necessidade", "pergunta": "Me conta o que está acontecendo hoje aí?", "obrigatorio": false},
    {"campo": "email", "pergunta": "Qual o melhor e-mail de contato?", "obrigatorio": false}
  ],
  "criterio_qualificado": "tipo_contato e nome and (servico or necessidade)",
  "nunca_falar": ["valores", "contratos", "condições comerciais"],
  "handoff_quando": ["empresa qualificada", "urgência real", "fora do escopo"]
}'::jsonb)
on conflict (slug) do nothing;

-- -----------------------------------------------------------------------------
-- 10. Função de busca híbrida (chamada por lib/agent/rag.js)
-- -----------------------------------------------------------------------------
-- Retorna os candidatos por relevância full-text. O reranking por embedding
-- acontece no Node (ou direto no Postgres se pgvector estiver presente).
--
-- IMPORTANTE — por que OR e não websearch_to_tsquery:
-- websearch_to_tsquery/plainto_tsquery unem os termos com AND. Numa pergunta de
-- WhatsApp ("quanto custa o plano?") isso exige que o documento contenha TODOS os
-- radicais — inclusive 'quant' — e um trecho que diz literalmente "O plano
-- Essencial custa R$ 497" não retorna nada. Aqui os termos são unidos com OR e o
-- ts_rank ordena: quem casa mais termos sobe. Recall alto, precisão pelo rank.

create or replace function public.search_knowledge_text(
  p_client_id text,
  p_query     text,
  p_limit     integer default 40
) returns table (id bigint, content text, title text, rank real)
language plpgsql stable as $$
declare
  v_lexemes text[];
  v_query   tsquery;
begin
  -- to_tsvector já remove stop words ("o", "de", "que") e faz o stemming
  select array_agg(lexeme) into v_lexemes
    from unnest(to_tsvector('portuguese', coalesce(p_query, ''))) as t(lexeme);

  if v_lexemes is null or array_length(v_lexemes, 1) = 0 then
    return;  -- pergunta só com stop words: nada a buscar
  end if;

  v_query := to_tsquery('portuguese', array_to_string(v_lexemes, ' | '));

  return query
    select k.id, k.content, k.title, ts_rank(k.content_tsv, v_query) as rank
      from public.knowledge_chunks k
     where k.client_id = p_client_id
       and k.content_tsv @@ v_query
     order by rank desc
     limit p_limit;
end;
$$;

commit;

-- =============================================================================
-- Verificação: rode isso depois e confira que não sobrou nada faltando.
-- =============================================================================
-- select table_name from information_schema.tables
--  where table_schema = 'public'
--    and table_name in ('assets','integrations','api_keys','webhook_endpoints',
--                       'inbound_queue','lead_events','playbook_templates','audit_log')
--  order by 1;
