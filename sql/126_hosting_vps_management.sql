begin;

alter table public.hosting_projects
  add column if not exists runtime_status text not null default 'offline'
    check (runtime_status in ('online', 'offline', 'restarting', 'deploying', 'crashed', 'suspended', 'unknown')),
  add column if not exists runtime_status_payload jsonb not null default '{}'::jsonb,
  add column if not exists runtime_last_seen_at timestamptz,
  add column if not exists active_deployment_id bigint,
  add column if not exists billing_status text not null default 'active'
    check (billing_status in ('active', 'past_due', 'refunded', 'charged_back', 'cancelled', 'expired')),
  add column if not exists access_expires_at timestamptz,
  add column if not exists refund_access_until timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspension_reason text;

create index if not exists idx_hosting_projects_user_billing_access
on public.hosting_projects (user_id, billing_status, access_expires_at desc);

create table if not exists public.hosting_github_connections (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  github_login text,
  github_account_type text,
  github_avatar_url text,
  encrypted_token text not null,
  token_status text not null default 'active'
    check (token_status in ('active', 'invalid', 'revoked')),
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

create index if not exists idx_hosting_github_connections_user_status
on public.hosting_github_connections (user_id, token_status);

create table if not exists public.hosting_vps_action_events (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  actor_user_id bigint references public.auth_users(id) on delete set null,
  action text not null check (action in ('start', 'stop', 'restart', 'deploy', 'rollback', 'sync', 'env_update', 'file_write')),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  message text,
  request_payload jsonb not null default '{}'::jsonb,
  response_payload jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_action_events_project_created
on public.hosting_vps_action_events (hosting_project_id, created_at desc);

create table if not exists public.hosting_vps_metrics (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  cpu_percent numeric(6,2) not null default 0,
  ram_percent numeric(6,2) not null default 0,
  disk_percent numeric(6,2) not null default 0,
  network_rx_kbps numeric(12,2) not null default 0,
  network_tx_kbps numeric(12,2) not null default 0,
  process_count integer not null default 0,
  uptime_seconds bigint not null default 0,
  temperature_c numeric(6,2),
  app_cpu_percent numeric(6,2),
  app_ram_mb numeric(12,2),
  payload jsonb not null default '{}'::jsonb,
  sampled_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_metrics_project_sampled
on public.hosting_vps_metrics (hosting_project_id, sampled_at desc);

create table if not exists public.hosting_vps_logs (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error', 'success')),
  source text not null default 'runtime',
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  emitted_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_logs_project_emitted
on public.hosting_vps_logs (hosting_project_id, emitted_at desc);

create table if not exists public.hosting_vps_deployments (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  environment text not null default 'production' check (environment in ('development', 'preview', 'production')),
  status text not null default 'queued'
    check (status in ('pending', 'queued', 'building', 'preparing', 'deploying', 'preview', 'production', 'ready', 'failed', 'cancelled')),
  branch text not null,
  commit_sha text,
  commit_author text,
  commit_message text,
  build_started_at timestamptz,
  build_finished_at timestamptz,
  deployed_at timestamptz,
  duration_ms integer,
  logs jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_hosting_vps_deployments_project_created
on public.hosting_vps_deployments (hosting_project_id, created_at desc);

create table if not exists public.hosting_vps_env_vars (
  id bigint generated always as identity primary key,
  hosting_project_id bigint not null references public.hosting_projects(id) on delete cascade,
  environment text not null check (environment in ('development', 'preview', 'production')),
  key text not null,
  encrypted_value text not null,
  value_preview text,
  visible_value text,
  note text,
  sensitive boolean not null default true,
  version integer not null default 1,
  updated_by_user_id bigint references public.auth_users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (hosting_project_id, environment, key)
);

alter table public.hosting_vps_env_vars
  add column if not exists visible_value text,
  add column if not exists note text,
  add column if not exists sensitive boolean not null default true;

create index if not exists idx_hosting_vps_env_vars_project_env
on public.hosting_vps_env_vars (hosting_project_id, environment, key);

drop trigger if exists tr_hosting_vps_deployments_updated_at on public.hosting_vps_deployments;
create trigger tr_hosting_vps_deployments_updated_at
before update on public.hosting_vps_deployments
for each row execute function public.set_updated_at();

drop trigger if exists tr_hosting_vps_env_vars_updated_at on public.hosting_vps_env_vars;
create trigger tr_hosting_vps_env_vars_updated_at
before update on public.hosting_vps_env_vars
for each row execute function public.set_updated_at();

drop trigger if exists tr_hosting_github_connections_updated_at on public.hosting_github_connections;
create trigger tr_hosting_github_connections_updated_at
before update on public.hosting_github_connections
for each row execute function public.set_updated_at();

alter table public.hosting_github_connections enable row level security;
alter table public.hosting_vps_action_events enable row level security;
alter table public.hosting_vps_metrics enable row level security;
alter table public.hosting_vps_logs enable row level security;
alter table public.hosting_vps_deployments enable row level security;
alter table public.hosting_vps_env_vars enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_github_connections_service_role_all on public.hosting_github_connections;
    create policy hosting_github_connections_service_role_all
      on public.hosting_github_connections for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_action_events_service_role_all on public.hosting_vps_action_events;
    create policy hosting_vps_action_events_service_role_all
      on public.hosting_vps_action_events for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_metrics_service_role_all on public.hosting_vps_metrics;
    create policy hosting_vps_metrics_service_role_all
      on public.hosting_vps_metrics for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_logs_service_role_all on public.hosting_vps_logs;
    create policy hosting_vps_logs_service_role_all
      on public.hosting_vps_logs for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_deployments_service_role_all on public.hosting_vps_deployments;
    create policy hosting_vps_deployments_service_role_all
      on public.hosting_vps_deployments for all to service_role
      using (true) with check (true);

    drop policy if exists hosting_vps_env_vars_service_role_all on public.hosting_vps_env_vars;
    create policy hosting_vps_env_vars_service_role_all
      on public.hosting_vps_env_vars for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;
