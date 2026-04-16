create extension if not exists pgcrypto;

do $$
begin
  alter type public.system_status_type add value 'under_maintenance';
exception
  when duplicate_object then null;
end $$;

begin;

do $$ begin
  create type public.system_maintenance_status_type as enum (
    'scheduled',
    'in_progress',
    'completed',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.system_dependency_type as enum (
    'hard',
    'soft',
    'external'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.system_outbox_status_type as enum (
    'pending',
    'processing',
    'sent',
    'failed',
    'dead_letter'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.system_component_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  description text,
  display_order integer not null default 0,
  is_public boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_component_groups_name_key unique (name),
  constraint system_component_groups_slug_key unique (slug)
);

alter table public.system_components
  add column if not exists group_id uuid references public.system_component_groups(id) on delete set null,
  add column if not exists monitoring_enabled boolean not null default true,
  add column if not exists sla_target numeric(6,3) not null default 99.900,
  add column if not exists last_alerted_at timestamptz,
  add column if not exists public_description text,
  add column if not exists external_reference text;

create table if not exists public.system_component_dependencies (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.system_components(id) on delete cascade,
  depends_on_component_id uuid not null references public.system_components(id) on delete cascade,
  dependency_type public.system_dependency_type not null default 'hard',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_component_dependencies_unique unique (component_id, depends_on_component_id)
);

create table if not exists public.system_status_monitor_policies (
  component_id uuid primary key references public.system_components(id) on delete cascade,
  evaluation_window integer not null default 5,
  failure_quorum integer not null default 2,
  major_quorum integer not null default 2,
  degraded_quorum integer not null default 3,
  recovery_quorum integer not null default 2,
  latency_degraded_ms integer,
  latency_partial_ms integer,
  latency_major_ms integer,
  min_confidence_pct numeric(5,2) not null default 66.67,
  allow_degraded_status boolean not null default true,
  allow_degraded_incident boolean not null default false,
  alert_cooldown_minutes integer not null default 60,
  incident_cooldown_minutes integer not null default 180,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_status_monitor_policies_window_check check (evaluation_window >= 3),
  constraint system_status_monitor_policies_quorum_check check (
    failure_quorum >= 1
    and major_quorum >= 1
    and degraded_quorum >= 1
    and recovery_quorum >= 1
  )
);

alter table public.system_status_monitor_snapshots
  add column if not exists sample_size integer not null default 1,
  add column if not exists success_count integer not null default 0,
  add column if not exists degraded_count integer not null default 0,
  add column if not exists failure_count integer not null default 0,
  add column if not exists checker_key text,
  add column if not exists checker_region text,
  add column if not exists confidence_score numeric(5,2),
  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb;

create table if not exists public.system_status_metric_definitions (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references public.system_components(id) on delete cascade,
  metric_key text not null,
  display_name text not null,
  unit text not null default 'count',
  aggregation text not null default 'last',
  is_public boolean not null default true,
  display_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_status_metric_definitions_unique unique (component_id, metric_key)
);

create table if not exists public.system_status_metric_points (
  id uuid primary key default gen_random_uuid(),
  metric_id uuid not null references public.system_status_metric_definitions(id) on delete cascade,
  bucket_at timestamptz not null,
  numeric_value numeric(20,6) not null,
  sample_size integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_status_metric_points_unique unique (metric_id, bucket_at)
);

create table if not exists public.system_maintenances (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  message text,
  status public.system_maintenance_status_type not null default 'scheduled',
  scheduled_for timestamptz not null,
  scheduled_until timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_maintenance_components (
  id uuid primary key default gen_random_uuid(),
  maintenance_id uuid not null references public.system_maintenances(id) on delete cascade,
  component_id uuid not null references public.system_components(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_maintenance_components_unique unique (maintenance_id, component_id)
);

create table if not exists public.system_incident_postmortems (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.system_incidents(id) on delete cascade,
  title text not null,
  summary text,
  root_cause text,
  resolution text,
  preventive_actions jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_incident_postmortems_incident_unique unique (incident_id)
);

create table if not exists public.system_status_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null default 'system',
  actor_id text,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.system_status_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  event_type text not null,
  component_id uuid references public.system_components(id) on delete set null,
  incident_id uuid references public.system_incidents(id) on delete set null,
  status public.system_outbox_status_type not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  available_at timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint system_status_notification_outbox_dedupe_key unique (dedupe_key)
);

create table if not exists public.system_status_subscription_components (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.system_status_subscriptions(id) on delete cascade,
  component_id uuid not null references public.system_components(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  constraint system_status_subscription_components_unique unique (subscription_id, component_id)
);

create index if not exists idx_system_components_group_id
on public.system_components (group_id, display_order, name);

create index if not exists idx_system_component_dependencies_component
on public.system_component_dependencies (component_id);

create index if not exists idx_system_component_dependencies_depends_on
on public.system_component_dependencies (depends_on_component_id);

create index if not exists idx_system_status_monitor_policies_updated_at
on public.system_status_monitor_policies (updated_at desc);

create index if not exists idx_system_status_monitor_snapshots_checker
on public.system_status_monitor_snapshots (checker_key, checker_region, observed_at desc);

create index if not exists idx_system_status_metric_points_metric_bucket
on public.system_status_metric_points (metric_id, bucket_at desc);

create index if not exists idx_system_maintenances_status_window
on public.system_maintenances (status, scheduled_for desc, scheduled_until desc);

create index if not exists idx_system_maintenance_components_component
on public.system_maintenance_components (component_id);

create index if not exists idx_system_status_activity_log_entity
on public.system_status_activity_log (entity_type, entity_id, created_at desc);

create index if not exists idx_system_status_notification_outbox_status_available
on public.system_status_notification_outbox (status, available_at, created_at);

create index if not exists idx_system_status_subscription_components_subscription
on public.system_status_subscription_components (subscription_id);

alter table public.system_component_groups enable row level security;
alter table public.system_component_dependencies enable row level security;
alter table public.system_status_monitor_policies enable row level security;
alter table public.system_status_metric_definitions enable row level security;
alter table public.system_status_metric_points enable row level security;
alter table public.system_maintenances enable row level security;
alter table public.system_maintenance_components enable row level security;
alter table public.system_incident_postmortems enable row level security;
alter table public.system_status_activity_log enable row level security;
alter table public.system_status_notification_outbox enable row level security;
alter table public.system_status_subscription_components enable row level security;

do $$ begin
  create policy "Public can view component groups"
  on public.system_component_groups
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view component dependencies"
  on public.system_component_dependencies
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view metric definitions"
  on public.system_status_metric_definitions
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view metric points"
  on public.system_status_metric_points
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view maintenances"
  on public.system_maintenances
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view maintenance components"
  on public.system_maintenance_components
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view incident postmortems"
  on public.system_incident_postmortems
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "Public can view component subscriptions"
  on public.system_status_subscription_components
  for select
  using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_monitor_policies"
  on public.system_status_monitor_policies
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_component_groups"
  on public.system_component_groups
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_component_dependencies"
  on public.system_component_dependencies
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_metric_definitions"
  on public.system_status_metric_definitions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_metric_points"
  on public.system_status_metric_points
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_maintenances"
  on public.system_maintenances
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_maintenance_components"
  on public.system_maintenance_components
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_postmortems"
  on public.system_incident_postmortems
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_subscription_components"
  on public.system_status_subscription_components
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_activity_log"
  on public.system_status_activity_log
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_manage_outbox"
  on public.system_status_notification_outbox
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
exception when duplicate_object then null; end $$;

create or replace function public.system_status_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_component_groups_touch_updated_at on public.system_component_groups;
create trigger tr_system_component_groups_touch_updated_at
before update on public.system_component_groups
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_status_monitor_policies_touch_updated_at on public.system_status_monitor_policies;
create trigger tr_system_status_monitor_policies_touch_updated_at
before update on public.system_status_monitor_policies
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_status_metric_definitions_touch_updated_at on public.system_status_metric_definitions;
create trigger tr_system_status_metric_definitions_touch_updated_at
before update on public.system_status_metric_definitions
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_maintenances_touch_updated_at on public.system_maintenances;
create trigger tr_system_maintenances_touch_updated_at
before update on public.system_maintenances
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_incident_postmortems_touch_updated_at on public.system_incident_postmortems;
create trigger tr_system_incident_postmortems_touch_updated_at
before update on public.system_incident_postmortems
for each row
execute function public.system_status_touch_updated_at();

drop trigger if exists tr_system_status_notification_outbox_touch_updated_at on public.system_status_notification_outbox;
create trigger tr_system_status_notification_outbox_touch_updated_at
before update on public.system_status_notification_outbox
for each row
execute function public.system_status_touch_updated_at();

insert into public.system_component_groups (name, slug, description, display_order, metadata)
values
  ('Core Platform', 'core-platform', 'Servicos centrais da plataforma e APIs publicas.', 1, '{"tier":"core"}'::jsonb),
  ('Data and Storage', 'data-storage', 'Persistencia, banco de dados e ativos armazenados.', 2, '{"tier":"data"}'::jsonb),
  ('Edge and Delivery', 'edge-delivery', 'DNS, SSL, CDN e camadas de entrega.', 3, '{"tier":"edge"}'::jsonb),
  ('Automation and Bot', 'automation-bot', 'Jobs, automacoes, notificacoes e bot.', 4, '{"tier":"automation"}'::jsonb),
  ('Billing and Trust', 'billing-trust', 'Pagamentos, auditoria e sinais de confianca.', 5, '{"tier":"business"}'::jsonb)
on conflict (slug) do update
set
  name = excluded.name,
  description = excluded.description,
  display_order = excluded.display_order,
  metadata = public.system_component_groups.metadata || excluded.metadata;

update public.system_components sc
set group_id = cg.id
from public.system_component_groups cg
where sc.group_id is null
  and (
    (cg.slug = 'core-platform' and sc.name in ('API', 'Flow AI', 'Painel de controle'))
    or (cg.slug = 'data-storage' and sc.name in ('Armazenamento DB', 'Cache', 'Registros de auditoria'))
    or (cg.slug = 'edge-delivery' and sc.name in ('DNS', 'CDN', 'Certificado SSL', 'Registro de domínio', 'Rede', 'Firewall DNS'))
    or (cg.slug = 'automation-bot' and sc.name in ('DISCORD BOT', 'Notificações', 'Tarefas agendadas'))
    or (cg.slug = 'billing-trust' and sc.name in ('Pagamentos e transações', 'Analises da Web'))
  );

insert into public.system_component_dependencies (component_id, depends_on_component_id, dependency_type, metadata)
select c.id, d.id, x.dependency_type, x.metadata
from (
  values
    ('Painel de controle', 'API', 'hard'::public.system_dependency_type, '{"reason":"dashboard-requests"}'::jsonb),
    ('Painel de controle', 'Armazenamento DB', 'hard'::public.system_dependency_type, '{"reason":"dashboard-state"}'::jsonb),
    ('Painel de controle', 'CDN', 'soft'::public.system_dependency_type, '{"reason":"assets"}'::jsonb),
    ('Flow AI', 'API', 'soft'::public.system_dependency_type, '{"reason":"internal-routing"}'::jsonb),
    ('Flow AI', 'Armazenamento DB', 'soft'::public.system_dependency_type, '{"reason":"state"}'::jsonb),
    ('Notificações', 'DISCORD BOT', 'hard'::public.system_dependency_type, '{"reason":"delivery"}'::jsonb),
    ('Pagamentos e transações', 'API', 'hard'::public.system_dependency_type, '{"reason":"checkout"}'::jsonb),
    ('Pagamentos e transações', 'Armazenamento DB', 'hard'::public.system_dependency_type, '{"reason":"reconciliation"}'::jsonb),
    ('API', 'Armazenamento DB', 'hard'::public.system_dependency_type, '{"reason":"primary-data-store"}'::jsonb),
    ('API', 'DNS', 'soft'::public.system_dependency_type, '{"reason":"routing"}'::jsonb),
    ('API', 'Certificado SSL', 'soft'::public.system_dependency_type, '{"reason":"tls"}'::jsonb)
) as x(component_name, depends_on_name, dependency_type, metadata)
join public.system_components c on c.name = x.component_name
join public.system_components d on d.name = x.depends_on_name
on conflict (component_id, depends_on_component_id) do update
set
  dependency_type = excluded.dependency_type,
  metadata = excluded.metadata;

insert into public.system_status_monitor_policies (
  component_id,
  evaluation_window,
  failure_quorum,
  major_quorum,
  degraded_quorum,
  recovery_quorum,
  latency_degraded_ms,
  latency_partial_ms,
  latency_major_ms,
  min_confidence_pct,
  allow_degraded_status,
  allow_degraded_incident,
  alert_cooldown_minutes,
  incident_cooldown_minutes,
  metadata
)
select
  sc.id,
  x.evaluation_window,
  x.failure_quorum,
  x.major_quorum,
  x.degraded_quorum,
  x.recovery_quorum,
  x.latency_degraded_ms,
  x.latency_partial_ms,
  x.latency_major_ms,
  x.min_confidence_pct,
  x.allow_degraded_status,
  x.allow_degraded_incident,
  x.alert_cooldown_minutes,
  x.incident_cooldown_minutes,
  x.metadata
from public.system_components sc
join (
  values
    ('Flow AI', 5, 2, 2, 4, 2, 4500, 7000, 12000, 80.00::numeric(5,2), true, false, 90, 240, '{"profile":"ai-strict"}'::jsonb),
    ('API', 5, 2, 2, 3, 2, 1800, 3500, 7000, 75.00::numeric(5,2), true, false, 60, 180, '{"profile":"api-core"}'::jsonb),
    ('CDN', 5, 3, 3, 3, 2, 1500, 2500, 5000, 75.00::numeric(5,2), true, false, 60, 180, '{"profile":"edge"}'::jsonb),
    ('DNS', 5, 3, 3, 3, 2, null, null, null, 75.00::numeric(5,2), false, false, 60, 180, '{"profile":"dns"}'::jsonb),
    ('Certificado SSL', 5, 2, 2, 3, 2, null, null, null, 75.00::numeric(5,2), false, false, 60, 180, '{"profile":"tls"}'::jsonb),
    ('Rede', 5, 3, 3, 4, 2, 2000, 3500, 6000, 80.00::numeric(5,2), true, false, 60, 180, '{"profile":"network"}'::jsonb),
    ('Armazenamento DB', 5, 2, 2, 3, 2, null, null, null, 80.00::numeric(5,2), false, false, 60, 180, '{"profile":"database"}'::jsonb),
    ('DISCORD BOT', 5, 2, 2, 3, 2, 1200, 2500, 5000, 75.00::numeric(5,2), true, false, 60, 180, '{"profile":"bot"}'::jsonb)
) as x(
  component_name,
  evaluation_window,
  failure_quorum,
  major_quorum,
  degraded_quorum,
  recovery_quorum,
  latency_degraded_ms,
  latency_partial_ms,
  latency_major_ms,
  min_confidence_pct,
  allow_degraded_status,
  allow_degraded_incident,
  alert_cooldown_minutes,
  incident_cooldown_minutes,
  metadata
) on x.component_name = sc.name
on conflict (component_id) do update
set
  evaluation_window = excluded.evaluation_window,
  failure_quorum = excluded.failure_quorum,
  major_quorum = excluded.major_quorum,
  degraded_quorum = excluded.degraded_quorum,
  recovery_quorum = excluded.recovery_quorum,
  latency_degraded_ms = excluded.latency_degraded_ms,
  latency_partial_ms = excluded.latency_partial_ms,
  latency_major_ms = excluded.latency_major_ms,
  min_confidence_pct = excluded.min_confidence_pct,
  allow_degraded_status = excluded.allow_degraded_status,
  allow_degraded_incident = excluded.allow_degraded_incident,
  alert_cooldown_minutes = excluded.alert_cooldown_minutes,
  incident_cooldown_minutes = excluded.incident_cooldown_minutes,
  metadata = public.system_status_monitor_policies.metadata || excluded.metadata;

create or replace function public.get_status_severity_weight(s public.system_status_type)
returns integer
language plpgsql
immutable
as $$
begin
  return case s
    when 'operational' then 1
    when 'degraded_performance' then 2
    when 'partial_outage' then 3
    when 'major_outage' then 4
    else 0
  end;
end;
$$;

create or replace function public.system_status_record_metric(
  p_component_name text,
  p_metric_key text,
  p_numeric_value numeric,
  p_unit text default 'count',
  p_bucket_at timestamptz default timezone('utc', now()),
  p_sample_size integer default 1,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_component_id uuid;
  v_metric_id uuid;
begin
  select id
  into v_component_id
  from public.system_components
  where name = p_component_name
  limit 1;

  if v_component_id is null or p_metric_key is null or p_numeric_value is null then
    return null;
  end if;

  insert into public.system_status_metric_definitions (
    component_id,
    metric_key,
    display_name,
    unit,
    aggregation
  )
  values (
    v_component_id,
    p_metric_key,
    initcap(replace(p_metric_key, '_', ' ')),
    coalesce(p_unit, 'count'),
    'last'
  )
  on conflict (component_id, metric_key) do update
  set
    display_name = excluded.display_name,
    unit = excluded.unit,
    updated_at = timezone('utc', now())
  returning id into v_metric_id;

  insert into public.system_status_metric_points (
    metric_id,
    bucket_at,
    numeric_value,
    sample_size,
    metadata
  )
  values (
    v_metric_id,
    date_trunc('minute', coalesce(p_bucket_at, timezone('utc', now()))),
    p_numeric_value,
    greatest(coalesce(p_sample_size, 1), 1),
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (metric_id, bucket_at) do update
  set
    numeric_value = excluded.numeric_value,
    sample_size = excluded.sample_size,
    metadata = public.system_status_metric_points.metadata || excluded.metadata;

  return v_metric_id;
end;
$$;

create or replace function public.system_status_insert_activity(
  p_entity_type text,
  p_entity_id text,
  p_action text,
  p_message text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.system_status_activity_log (
    entity_type,
    entity_id,
    action,
    message,
    metadata
  )
  values (
    coalesce(p_entity_type, 'unknown'),
    coalesce(p_entity_id, 'unknown'),
    coalesce(p_action, 'unknown'),
    p_message,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.system_status_enqueue_outbox(
  p_dedupe_key text,
  p_event_type text,
  p_component_id uuid default null,
  p_incident_id uuid default null,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(trim(p_dedupe_key), '') = '' then
    return null;
  end if;

  insert into public.system_status_notification_outbox (
    dedupe_key,
    event_type,
    component_id,
    incident_id,
    payload
  )
  values (
    trim(p_dedupe_key),
    coalesce(p_event_type, 'status_event'),
    p_component_id,
    p_incident_id,
    coalesce(p_payload, '{}'::jsonb)
  )
  on conflict (dedupe_key) do update
  set
    event_type = excluded.event_type,
    component_id = coalesce(excluded.component_id, public.system_status_notification_outbox.component_id),
    incident_id = coalesce(excluded.incident_id, public.system_status_notification_outbox.incident_id),
    payload = public.system_status_notification_outbox.payload || excluded.payload,
    available_at = timezone('utc', now())
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.system_status_log_component_status_change()
returns trigger
language plpgsql
as $$
begin
  if old.status is distinct from new.status then
    perform public.system_status_insert_activity(
      'component',
      new.id::text,
      'status_changed',
      format('%s mudou de %s para %s.', new.name, old.status, new.status),
      jsonb_build_object(
        'component_name', new.name,
        'old_status', old.status,
        'new_status', new.status,
        'status_message', new.status_message
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_components_activity_log on public.system_components;
create trigger tr_system_components_activity_log
after update on public.system_components
for each row
execute function public.system_status_log_component_status_change();

create or replace function public.system_status_log_incident_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    perform public.system_status_insert_activity(
      'incident',
      new.id::text,
      'incident_created',
      new.title,
      jsonb_build_object(
        'status', new.status,
        'impact', new.impact,
        'incident_day', new.incident_day
      )
    );
  elsif old.status is distinct from new.status or old.impact is distinct from new.impact then
    perform public.system_status_insert_activity(
      'incident',
      new.id::text,
      'incident_updated',
      format('Incidente %s mudou para %s.', new.title, new.status),
      jsonb_build_object(
        'old_status', old.status,
        'new_status', new.status,
        'old_impact', old.impact,
        'new_impact', new.impact
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists tr_system_incidents_activity_log on public.system_incidents;
create trigger tr_system_incidents_activity_log
after insert or update on public.system_incidents
for each row
execute function public.system_status_log_incident_change();

create or replace function public.system_status_log_incident_update_change()
returns trigger
language plpgsql
as $$
begin
  perform public.system_status_insert_activity(
    'incident_update',
    new.id::text,
    'incident_update_created',
    new.message,
    jsonb_build_object(
      'incident_id', new.incident_id,
      'status', new.status
    )
  );
  return new;
end;
$$;

drop trigger if exists tr_system_incident_updates_activity_log on public.system_incident_updates;
create trigger tr_system_incident_updates_activity_log
after insert on public.system_incident_updates
for each row
execute function public.system_status_log_incident_update_change();

create or replace function public.system_status_log_maintenance_change()
returns trigger
language plpgsql
as $$
begin
  perform public.system_status_insert_activity(
    'maintenance',
    new.id::text,
    case when tg_op = 'INSERT' then 'maintenance_created' else 'maintenance_updated' end,
    new.title,
    jsonb_build_object(
      'status', new.status,
      'scheduled_for', new.scheduled_for,
      'scheduled_until', new.scheduled_until
    )
  );
  return new;
end;
$$;

drop trigger if exists tr_system_maintenances_activity_log on public.system_maintenances;
create trigger tr_system_maintenances_activity_log
after insert or update on public.system_maintenances
for each row
execute function public.system_status_log_maintenance_change();

create or replace function public.system_status_ingest_check(
  p_component_name text,
  p_raw_status public.system_status_type,
  p_latency_ms integer default null,
  p_message text default null,
  p_response_code integer default null,
  p_source_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_observed_at timestamptz default timezone('utc', now())
)
returns table (
  component_id uuid,
  stable_status public.system_status_type,
  raw_status public.system_status_type,
  should_alert boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_component public.system_components%rowtype;
  v_policy public.system_status_monitor_policies%rowtype;
  v_snapshot_id uuid;
  v_previous_stable public.system_status_type;
  v_next_stable public.system_status_type;
  v_failures_recent integer := 0;
  v_majors_recent integer := 0;
  v_operational_recent integer := 0;
  v_degraded_recent integer := 0;
  v_today date := timezone('utc', coalesce(p_observed_at, timezone('utc', now())))::date;
  v_sample_size integer := greatest(coalesce(nullif(p_metadata ->> 'sampleSize', '')::integer, 1), 1);
  v_success_count integer := 0;
  v_degraded_count integer := 0;
  v_failure_count integer := 0;
  v_checker_key text := coalesce(nullif(p_metadata ->> 'checkerKey', ''), 'internal-status-monitor');
  v_checker_region text := nullif(p_metadata ->> 'checkerRegion', '');
  v_confidence_score numeric(5,2);
  v_has_active_maintenance boolean := false;
  v_should_alert boolean := false;
  v_success_ratio numeric(5,2);
  v_effective_message text;
begin
  select *
  into v_component
  from public.system_components
  where name = p_component_name
  limit 1;

  if not found then
    raise exception 'Componente de status nao encontrado: %', p_component_name;
  end if;

  select *
  into v_policy
  from public.system_status_monitor_policies p
  where p.component_id = v_component.id;

  if not found then
    insert into public.system_status_monitor_policies (component_id)
    values (v_component.id)
    returning * into v_policy;
  end if;

  v_success_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'successCount', '')::integer,
      case when p_raw_status = 'operational' then v_sample_size else 0 end
    ),
    0
  );
  v_degraded_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'degradedCount', '')::integer,
      case when p_raw_status = 'degraded_performance' then v_sample_size else 0 end
    ),
    0
  );
  v_failure_count := greatest(
    coalesce(
      nullif(p_metadata ->> 'failureCount', '')::integer,
      case when p_raw_status in ('partial_outage', 'major_outage') then v_sample_size else 0 end
    ),
    0
  );

  v_confidence_score := coalesce(
    nullif(p_metadata ->> 'confidenceScore', '')::numeric(5,2),
    round(
      (
        greatest(v_success_count, v_degraded_count, v_failure_count)::numeric
        / greatest(v_sample_size, 1)::numeric
      ) * 100,
      2
    )::numeric(5,2)
  );

  v_success_ratio := round(
    (
      greatest(v_success_count, 0)::numeric
      / greatest(v_sample_size, 1)::numeric
    ) * 100,
    2
  )::numeric(5,2);

  select exists (
    select 1
    from public.system_maintenances sm
    join public.system_maintenance_components smc on smc.maintenance_id = sm.id
    where smc.component_id = v_component.id
      and sm.status in ('scheduled', 'in_progress')
      and coalesce(p_observed_at, timezone('utc', now())) between sm.scheduled_for and sm.scheduled_until
  )
  into v_has_active_maintenance;

  v_previous_stable := coalesce(v_component.status, 'operational');

  insert into public.system_status_monitor_snapshots (
    source_key,
    component_slug,
    component_id,
    component_name,
    status,
    stable_status,
    latency_ms,
    response_code,
    message,
    metadata,
    observed_at,
    sample_size,
    success_count,
    degraded_count,
    failure_count,
    checker_key,
    checker_region,
    confidence_score,
    policy_snapshot
  )
  values (
    coalesce(p_source_key, v_component.source_key, v_component.slug, lower(regexp_replace(v_component.name, '[^a-zA-Z0-9]+', '-', 'g'))),
    v_component.slug,
    v_component.id,
    v_component.name,
    p_raw_status,
    null,
    p_latency_ms,
    p_response_code,
    p_message,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    v_success_count,
    v_degraded_count,
    v_failure_count,
    v_checker_key,
    v_checker_region,
    v_confidence_score,
    to_jsonb(v_policy)
  )
  returning id into v_snapshot_id;

  with recent as (
    select
      s.status,
      row_number() over (order by s.observed_at desc, s.id desc) as rn
    from public.system_status_monitor_snapshots s
    where s.component_id = v_component.id
    order by s.observed_at desc, s.id desc
    limit greatest(v_policy.evaluation_window, 5)
  )
  select
    count(*) filter (where rn <= v_policy.evaluation_window and status in ('partial_outage', 'major_outage')),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'major_outage'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'operational'),
    count(*) filter (where rn <= v_policy.evaluation_window and status = 'degraded_performance')
  into
    v_failures_recent,
    v_majors_recent,
    v_operational_recent,
    v_degraded_recent
  from recent;

  v_next_stable := v_previous_stable;

  if not coalesce(v_component.monitoring_enabled, true) then
    v_next_stable := v_previous_stable;
  elsif v_has_active_maintenance then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  elsif p_raw_status = 'major_outage' and (
    v_failure_count >= v_policy.major_quorum
    or v_majors_recent >= v_policy.major_quorum
    or (
      v_policy.latency_major_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_major_ms
      and v_failure_count >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'major_outage';
  elsif p_raw_status in ('partial_outage', 'major_outage') and (
    v_failure_count >= v_policy.failure_quorum
    or v_failures_recent >= v_policy.failure_quorum
    or (
      v_policy.latency_partial_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_partial_ms
      and (v_failure_count + v_degraded_count) >= v_policy.failure_quorum
    )
  ) then
    v_next_stable := 'partial_outage';
  elsif coalesce(v_policy.allow_degraded_status, true) and p_raw_status = 'degraded_performance' and (
    v_degraded_count >= v_policy.degraded_quorum
    or v_degraded_recent >= v_policy.degraded_quorum
    or (
      v_policy.latency_degraded_ms is not null
      and p_latency_ms is not null
      and p_latency_ms >= v_policy.latency_degraded_ms
    )
  ) then
    v_next_stable := 'degraded_performance';
  elsif p_raw_status = 'operational' and (
    v_success_count >= v_policy.recovery_quorum
    or v_operational_recent >= v_policy.recovery_quorum
  ) then
    v_next_stable := 'operational';
  end if;

  if v_component.name = 'Flow AI'
    and v_next_stable = 'degraded_performance'
    and v_confidence_score < greatest(v_policy.min_confidence_pct, 85.00::numeric)
  then
    v_next_stable := coalesce(v_previous_stable, 'operational');
  end if;

  v_effective_message := case
    when v_has_active_maintenance then coalesce(p_message, 'Componente em manutencao programada.')
    else p_message
  end;

  v_should_alert := public.system_status_is_incident_worthy(v_next_stable)
    and not v_has_active_maintenance
    and v_confidence_score >= coalesce(v_policy.min_confidence_pct, 66.67)
    and (
      v_previous_stable is distinct from v_next_stable
      or v_component.last_alerted_at is null
      or v_component.last_alerted_at <= coalesce(p_observed_at, timezone('utc', now())) - make_interval(mins => v_policy.alert_cooldown_minutes)
    );

  update public.system_status_monitor_snapshots
  set stable_status = v_next_stable
  where id = v_snapshot_id;

  update public.system_components
  set
    status = v_next_stable,
    latency_ms = p_latency_ms,
    source_key = coalesce(p_source_key, source_key),
    status_message = v_effective_message,
    last_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    last_raw_status = p_raw_status,
    last_raw_checked_at = coalesce(p_observed_at, timezone('utc', now())),
    status_changed_at = case
      when status is distinct from v_next_stable then coalesce(p_observed_at, timezone('utc', now()))
      else status_changed_at
    end,
    last_failure_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_failure_at
    end,
    last_recovered_at = case
      when v_next_stable = 'operational' and status <> 'operational' then coalesce(p_observed_at, timezone('utc', now()))
      else last_recovered_at
    end,
    last_alerted_at = case
      when v_should_alert then coalesce(p_observed_at, timezone('utc', now()))
      else last_alerted_at
    end,
    last_incident_at = case
      when public.system_status_is_incident_worthy(v_next_stable) then coalesce(p_observed_at, timezone('utc', now()))
      else last_incident_at
    end,
    today_failure_count = case
      when public.system_status_is_incident_worthy(v_next_stable) and status = 'operational' then
        case
          when last_failure_at is not null
            and timezone('utc', last_failure_at)::date = v_today
          then coalesce(today_failure_count, 0) + 1
          else 1
        end
      when last_failure_at is not null
        and timezone('utc', last_failure_at)::date <> v_today
      then 0
      else coalesce(today_failure_count, 0)
    end,
    updated_at = timezone('utc', now()),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_raw_status', p_raw_status,
      'last_stable_status', v_next_stable,
      'last_message', v_effective_message,
      'last_response_code', p_response_code,
      'last_monitor_metadata', coalesce(p_metadata, '{}'::jsonb),
      'sample_size', v_sample_size,
      'success_count', v_success_count,
      'degraded_count', v_degraded_count,
      'failure_count', v_failure_count,
      'checker_key', v_checker_key,
      'checker_region', v_checker_region,
      'confidence_score', v_confidence_score
    )
  where id = v_component.id;

  insert into public.system_status_history (
    component_id,
    status,
    recorded_at
  )
  values (
    v_component.id,
    v_next_stable,
    v_today
  )
  on conflict (component_id, recorded_at) do update
  set status = case
    when public.get_status_severity_weight(excluded.status) > public.get_status_severity_weight(public.system_status_history.status)
    then excluded.status
    else public.system_status_history.status
  end;

  if p_latency_ms is not null then
    perform public.system_status_record_metric(
      v_component.name,
      'latency_ms',
      p_latency_ms,
      'ms',
      coalesce(p_observed_at, timezone('utc', now())),
      v_sample_size,
      jsonb_build_object('status', v_next_stable, 'checker_key', v_checker_key)
    );
  end if;

  perform public.system_status_record_metric(
    v_component.name,
    'confidence_pct',
    v_confidence_score,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('raw_status', p_raw_status)
  );

  perform public.system_status_record_metric(
    v_component.name,
    'success_ratio_pct',
    v_success_ratio,
    'percent',
    coalesce(p_observed_at, timezone('utc', now())),
    v_sample_size,
    jsonb_build_object('stable_status', v_next_stable)
  );

  if v_previous_stable is distinct from v_next_stable then
    perform public.system_status_insert_activity(
      'component',
      v_component.id::text,
      'policy_decision',
      format('%s estabilizou em %s a partir de %s.', v_component.name, v_next_stable, p_raw_status),
      jsonb_build_object(
        'raw_status', p_raw_status,
        'stable_status', v_next_stable,
        'confidence_score', v_confidence_score,
        'sample_size', v_sample_size,
        'failure_count', v_failure_count,
        'degraded_count', v_degraded_count,
        'success_count', v_success_count,
        'maintenance_active', v_has_active_maintenance
      )
    );
  end if;

  if v_should_alert then
    perform public.system_status_enqueue_outbox(
      format(
        'component:%s:%s:%s',
        v_component.id,
        v_next_stable,
        to_char(date_trunc('minute', coalesce(p_observed_at, timezone('utc', now()))), 'YYYYMMDDHH24MI')
      ),
      'component_alert',
      v_component.id,
      null,
      jsonb_build_object(
        'component_name', v_component.name,
        'stable_status', v_next_stable,
        'raw_status', p_raw_status,
        'message', v_effective_message,
        'confidence_score', v_confidence_score
      )
    );
  end if;

  return query
  select
    v_component.id,
    v_next_stable,
    p_raw_status,
    v_should_alert;
end;
$$;

create or replace view public.system_status_active_maintenances as
select
  sm.id,
  sm.title,
  sm.message,
  sm.status,
  sm.scheduled_for,
  sm.scheduled_until,
  sm.started_at,
  sm.completed_at,
  sm.metadata,
  coalesce(array_agg(sc.name order by sc.display_order, sc.name) filter (where sc.id is not null), array[]::text[]) as component_names
from public.system_maintenances sm
left join public.system_maintenance_components smc on smc.maintenance_id = sm.id
left join public.system_components sc on sc.id = smc.component_id
where sm.status in ('scheduled', 'in_progress')
  and timezone('utc', now()) between sm.scheduled_for and sm.scheduled_until
group by sm.id;

create or replace view public.system_status_metric_latest as
select distinct on (md.id)
  md.id as metric_id,
  md.component_id,
  sc.name as component_name,
  md.metric_key,
  md.display_name,
  md.unit,
  mp.bucket_at,
  mp.numeric_value,
  mp.sample_size,
  mp.metadata
from public.system_status_metric_definitions md
join public.system_status_metric_points mp on mp.metric_id = md.id
join public.system_components sc on sc.id = md.component_id
order by md.id, mp.bucket_at desc;

create or replace view public.system_component_slo_30d as
with base as (
  select
    component_id,
    count(*) as total_samples,
    count(*) filter (where stable_status = 'operational') as operational_samples,
    count(*) filter (where stable_status = 'degraded_performance') as degraded_samples,
    count(*) filter (where stable_status in ('partial_outage', 'major_outage')) as outage_samples,
    avg(latency_ms) filter (where latency_ms is not null) as avg_latency_ms,
    percentile_cont(0.95) within group (order by latency_ms) filter (where latency_ms is not null) as p95_latency_ms
  from public.system_status_monitor_snapshots
  where observed_at >= timezone('utc', now()) - interval '30 days'
  group by component_id
)
select
  sc.id as component_id,
  sc.name as component_name,
  sc.sla_target,
  coalesce(base.total_samples, 0) as total_samples,
  coalesce(base.operational_samples, 0) as operational_samples,
  coalesce(base.degraded_samples, 0) as degraded_samples,
  coalesce(base.outage_samples, 0) as outage_samples,
  case
    when coalesce(base.total_samples, 0) = 0 then null
    else round((base.operational_samples::numeric / base.total_samples::numeric) * 100, 4)
  end as availability_pct_30d,
  round(base.avg_latency_ms::numeric, 2) as avg_latency_ms_30d,
  round(base.p95_latency_ms::numeric, 2) as p95_latency_ms_30d
from public.system_components sc
left join base on base.component_id = sc.id;

create or replace view public.system_component_public_status as
with active_maintenance as (
  select
    smc.component_id,
    max(sm.title) as maintenance_title
  from public.system_maintenances sm
  join public.system_maintenance_components smc on smc.maintenance_id = sm.id
  where sm.status in ('scheduled', 'in_progress')
    and timezone('utc', now()) between sm.scheduled_for and sm.scheduled_until
  group by smc.component_id
)
select
  sc.id,
  sc.name,
  sc.slug,
  sc.description,
  sc.public_description,
  cg.name as group_name,
  cg.slug as group_slug,
  case
    when am.component_id is not null then 'under_maintenance'
    else sc.status::text
  end as effective_status,
  sc.status::text as internal_status,
  sc.status_message,
  sc.latency_ms,
  sc.last_checked_at,
  sc.last_failure_at,
  sc.last_recovered_at,
  sc.sla_target,
  am.maintenance_title,
  coalesce(dep.depends_on, array[]::text[]) as depends_on,
  slo.availability_pct_30d,
  slo.avg_latency_ms_30d,
  slo.p95_latency_ms_30d
from public.system_components sc
left join public.system_component_groups cg on cg.id = sc.group_id
left join active_maintenance am on am.component_id = sc.id
left join lateral (
  select array_agg(d.name order by d.display_order, d.name) as depends_on
  from public.system_component_dependencies scd
  join public.system_components d on d.id = scd.depends_on_component_id
  where scd.component_id = sc.id
) dep on true
left join public.system_component_slo_30d slo on slo.component_id = sc.id
where sc.is_public = true;

create or replace view public.system_component_group_rollup as
select
  cg.id,
  cg.name,
  cg.slug,
  cg.description,
  min(sc.display_order) as display_order,
  case
    when count(*) filter (where cps.effective_status = 'major_outage') > 0 then 'major_outage'
    when count(*) filter (where cps.effective_status = 'partial_outage') > 0 then 'partial_outage'
    when count(*) filter (where cps.effective_status = 'degraded_performance') > 0 then 'degraded_performance'
    when count(*) filter (where cps.effective_status = 'under_maintenance') > 0 then 'under_maintenance'
    else 'operational'
  end as group_status,
  count(sc.id) as component_count
from public.system_component_groups cg
left join public.system_component_public_status cps on cps.group_slug = cg.slug
left join public.system_components sc on sc.id = cps.id
group by cg.id, cg.name, cg.slug, cg.description;

create or replace view public.system_status_enterprise_summary as
select
  (select count(*) from public.system_incidents where status <> 'resolved') as open_incidents,
  (select count(*) from public.system_maintenances where status in ('scheduled', 'in_progress') and timezone('utc', now()) <= scheduled_until) as active_or_upcoming_maintenances,
  (select count(*) from public.system_status_notification_outbox where status in ('pending', 'failed')) as pending_notifications,
  (select round(avg(availability_pct_30d)::numeric, 4) from public.system_component_slo_30d where availability_pct_30d is not null) as average_component_availability_pct_30d,
  (select count(*) from public.system_components where status in ('partial_outage', 'major_outage')) as components_in_outage;

commit;
