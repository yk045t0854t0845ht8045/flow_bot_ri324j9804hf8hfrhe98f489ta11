-- Status System Upgrade
-- Execute after 064_system_status.sql

alter table public.system_components
  add column if not exists slug text,
  add column if not exists category text,
  add column if not exists status_source text,
  add column if not exists status_message text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_incident_at timestamptz,
  add column if not exists is_public boolean not null default true,
  add column if not exists is_core boolean not null default false;

alter table public.system_incidents
  add column if not exists started_at timestamptz not null default timezone('utc', now()),
  add column if not exists resolved_at timestamptz,
  add column if not exists incident_day date,
  add column if not exists public_summary text,
  add column if not exists ai_summary text,
  add column if not exists component_summary text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.system_incident_components (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.system_incidents(id) on delete cascade,
  component_id uuid not null references public.system_components(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  unique (incident_id, component_id)
);

create index if not exists idx_system_components_slug
on public.system_components (slug);

create unique index if not exists idx_system_components_slug_unique
on public.system_components (slug)
where slug is not null;

create index if not exists idx_system_components_category
on public.system_components (category);

create index if not exists idx_system_components_status_source
on public.system_components (status_source);

create index if not exists idx_system_incidents_incident_day
on public.system_incidents (incident_day desc);

create index if not exists idx_system_incidents_status_updated_at
on public.system_incidents (status, updated_at desc);

create index if not exists idx_system_incident_components_incident
on public.system_incident_components (incident_id);

create index if not exists idx_system_incident_components_component
on public.system_incident_components (component_id);

create unique index if not exists idx_system_status_subscriptions_type_target_unique
on public.system_status_subscriptions (type, target);

update public.system_incidents
set incident_day = timezone('utc', coalesce(created_at, started_at, timezone('utc', now())))::date
where incident_day is null;

create or replace function public.sync_system_incident_dates()
returns trigger
language plpgsql
as $$
begin
  if new.started_at is null then
    new.started_at := coalesce(new.created_at, timezone('utc', now()));
  end if;

  if new.incident_day is null then
    new.incident_day := timezone('utc', coalesce(new.created_at, new.started_at, timezone('utc', now())))::date;
  end if;

  if new.status = 'resolved' and new.resolved_at is null then
    new.resolved_at := timezone('utc', now());
  end if;

  if new.status <> 'resolved' then
    new.resolved_at := null;
  end if;

  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_incidents_sync_dates on public.system_incidents;
create trigger tr_system_incidents_sync_dates
before insert or update on public.system_incidents
for each row
execute function public.sync_system_incident_dates();

create or replace function public.touch_system_component_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_components_touch_updated_at on public.system_components;
create trigger tr_system_components_touch_updated_at
before update on public.system_components
for each row
execute function public.touch_system_component_updated_at();

alter table public.system_incident_components enable row level security;

do $$ begin
  create policy "Public can view system incident components"
  on public.system_incident_components
  for select
  using (true);
exception when duplicate_object then null; end $$;

update public.system_components
set
  slug = case name
    when 'Flow AI' then 'flow-ai'
    when 'API' then 'api'
    when 'Tarefas agendadas' then 'scheduled-tasks'
    when 'DISCORD BOT' then 'discord-bot'
    when 'Notificações' then 'notifications'
    when 'Painel de controle' then 'control-panel'
    when 'DNS' then 'dns'
    when 'CDN' then 'cdn'
    when 'Registro de domínio' then 'domain-registry'
    when 'Rede' then 'network'
    when 'Firewall DNS' then 'dns-firewall'
    when 'Geolocalização de IP' then 'ip-geolocation'
    when 'Otimização' then 'optimization'
    when 'Registros de auditoria' then 'audit-logs'
    when 'Pagamentos e transações' then 'payments'
    when 'Cache' then 'cache'
    when 'Velocidade do sistema' then 'performance'
    when 'Certificado SSL' then 'ssl'
    when 'Armazenamento DB' then 'database-storage'
    when 'Analises da Web' then 'web-analytics'
    else coalesce(slug, lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')))
  end,
  category = case name
    when 'Flow AI' then 'ai'
    when 'API' then 'core'
    when 'Tarefas agendadas' then 'automation'
    when 'DISCORD BOT' then 'discord'
    when 'Notificações' then 'communication'
    when 'Painel de controle' then 'core'
    when 'DNS' then 'domains'
    when 'CDN' then 'delivery'
    when 'Registro de domínio' then 'domains'
    when 'Rede' then 'infrastructure'
    when 'Firewall DNS' then 'security'
    when 'Geolocalização de IP' then 'security'
    when 'Otimização' then 'performance'
    when 'Registros de auditoria' then 'compliance'
    when 'Pagamentos e transações' then 'billing'
    when 'Cache' then 'performance'
    when 'Velocidade do sistema' then 'performance'
    when 'Certificado SSL' then 'security'
    when 'Armazenamento DB' then 'database'
    when 'Analises da Web' then 'analytics'
    else coalesce(category, 'general')
  end,
  status_source = case name
    when 'Flow AI' then 'flowai'
    when 'API' then 'api'
    when 'Tarefas agendadas' then 'scheduled_tasks'
    when 'Registro de domínio' then 'domains'
    when 'DNS' then 'domains'
    when 'Certificado SSL' then 'domains'
    when 'Firewall DNS' then 'domains'
    when 'Geolocalização de IP' then 'domains'
    when 'Pagamentos e transações' then 'payments'
    when 'DISCORD BOT' then 'discord'
    when 'Notificações' then 'discord'
    when 'Registros de auditoria' then 'audit'
    when 'Analises da Web' then 'audit'
    else coalesce(status_source, 'api')
  end,
  is_core = case
    when name in ('Flow AI', 'API', 'Tarefas agendadas', 'Painel de controle', 'Pagamentos e transações') then true
    else coalesce(is_core, false)
  end;

insert into public.system_components (
  name,
  description,
  display_order,
  slug,
  category,
  status_source,
  is_core,
  metadata
) values
  ('Flow AI', 'Monitoramento do motor principal de IA, prompts e respostas automatizadas.', 1, 'flow-ai', 'ai', 'flowai', true, '{"owner":"status-system"}'::jsonb),
  ('API', 'Disponibilidade da API principal, autenticação, banco e regras centrais.', 2, 'api', 'core', 'api', true, '{"owner":"status-system"}'::jsonb),
  ('Tarefas agendadas', 'Fila de expiracao de planos, retries, backups e automacoes agendadas.', 3, 'scheduled-tasks', 'automation', 'scheduled_tasks', true, '{"owner":"status-system"}'::jsonb),
  ('DISCORD BOT', 'Integracao do bot, vinculos de contas e operacoes relacionadas ao Discord.', 4, 'discord-bot', 'discord', 'discord', false, '{"owner":"status-system"}'::jsonb),
  ('Notificações', 'Entrega de alertas, avisos operacionais e eventos automatizados.', 5, 'notifications', 'communication', 'discord', false, '{"owner":"status-system"}'::jsonb),
  ('Painel de controle', 'Dashboard, area autenticada e operacoes do produto principal.', 6, 'control-panel', 'core', 'api', true, '{"owner":"status-system"}'::jsonb),
  ('DNS', 'Resolucao DNS, propagacao e disponibilidade dos registros.', 7, 'dns', 'domains', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('CDN', 'Entrega de imagens, assets estaticos e distribuicao de conteudo.', 8, 'cdn', 'delivery', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Registro de domínio', 'Registro, consulta e operacoes com dominios e subdominios.', 9, 'domain-registry', 'domains', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('Rede', 'Conectividade, latencia e estabilidade da infraestrutura.', 10, 'network', 'infrastructure', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Firewall DNS', 'Camada de protecao, filtragem e seguranca de rede.', 11, 'dns-firewall', 'security', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('Geolocalização de IP', 'Consultas de IP, localizacao e inteligencia de origem.', 12, 'ip-geolocation', 'security', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('Otimização', 'Rotinas e recursos de performance, cache e ajustes do sistema.', 13, 'optimization', 'performance', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Registros de auditoria', 'Logs, trilhas de auditoria, historicos e registros de seguranca.', 14, 'audit-logs', 'compliance', 'audit', false, '{"owner":"status-system"}'::jsonb),
  ('Pagamentos e transações', 'Criacao, confirmacao, webhook e conciliacao de pagamentos.', 15, 'payments', 'billing', 'payments', true, '{"owner":"status-system"}'::jsonb),
  ('Cache', 'Camada de cache de aplicacao, assets e respostas internas.', 16, 'cache', 'performance', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Velocidade do sistema', 'Tempo de resposta geral, renderizacao e desempenho percebido.', 17, 'performance', 'performance', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Certificado SSL', 'Emissao e disponibilidade de certificados SSL e HTTPS.', 18, 'ssl', 'security', 'domains', false, '{"owner":"status-system"}'::jsonb),
  ('Armazenamento DB', 'Persistencia de dados, integridade e disponibilidade do banco.', 19, 'database-storage', 'database', 'api', false, '{"owner":"status-system"}'::jsonb),
  ('Analises da Web', 'Analiticos, telemetria e sinais de operacao do produto.', 20, 'web-analytics', 'analytics', 'audit', false, '{"owner":"status-system"}'::jsonb)
on conflict (name) do update
set
  description = excluded.description,
  display_order = excluded.display_order,
  slug = excluded.slug,
  category = excluded.category,
  status_source = excluded.status_source,
  is_core = excluded.is_core,
  metadata = coalesce(public.system_components.metadata, '{}'::jsonb) || excluded.metadata;

create or replace view public.system_incident_feed as
select
  si.id,
  si.title,
  si.impact,
  si.status,
  si.created_at,
  si.updated_at,
  si.started_at,
  si.resolved_at,
  si.incident_day,
  coalesce(
    si.public_summary,
    si.ai_summary,
    si.component_summary,
    last_update.message,
    'Ocorrencia registrada e monitorada pela equipe.'
  ) as summary,
  coalesce(component_names.names, array[]::text[]) as affected_components
from public.system_incidents si
left join lateral (
  select siu.message
  from public.system_incident_updates siu
  where siu.incident_id = si.id
  order by siu.created_at desc
  limit 1
) as last_update on true
left join lateral (
  select array_agg(sc.name order by sc.display_order, sc.name) as names
  from public.system_incident_components sic
  join public.system_components sc on sc.id = sic.component_id
  where sic.incident_id = si.id
) as component_names on true;
