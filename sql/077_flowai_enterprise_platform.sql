create extension if not exists pgcrypto;

create table if not exists public.auth_user_api_keys (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  token_prefix text,
  last_four text not null,
  scopes text[] not null default array['flowai:invoke', 'flowai:jobs:read', 'flowai:jobs:write', 'flowai:health'],
  allowed_tasks text[] not null default array['*'],
  rate_limit_per_minute integer not null default 60,
  monthly_quota integer,
  metadata jsonb not null default '{}'::jsonb,
  last_used_at timestamptz,
  last_used_ip text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_user_api_keys
  add column if not exists token_prefix text,
  add column if not exists scopes text[] not null default array['flowai:invoke', 'flowai:jobs:read', 'flowai:jobs:write', 'flowai:health'],
  add column if not exists allowed_tasks text[] not null default array['*'],
  add column if not exists rate_limit_per_minute integer not null default 60,
  add column if not exists monthly_quota integer,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists last_used_at timestamptz,
  add column if not exists last_used_ip text,
  add column if not exists expires_at timestamptz,
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create index if not exists idx_auth_user_api_keys_user_id
on public.auth_user_api_keys (user_id, created_at desc);

create index if not exists idx_auth_user_api_keys_revoked_at
on public.auth_user_api_keys (revoked_at, created_at desc);

create index if not exists idx_auth_user_api_keys_active
on public.auth_user_api_keys (user_id, revoked_at)
where revoked_at is null;

drop trigger if exists tr_auth_user_api_keys_updated_at on public.auth_user_api_keys;
create trigger tr_auth_user_api_keys_updated_at
before update on public.auth_user_api_keys
for each row
execute function public.set_updated_at();

do $$ begin
  create type public.flowai_job_status as enum (
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.flowai_job_queue (
  id uuid primary key default gen_random_uuid(),
  api_key_id bigint references public.auth_user_api_keys(id) on delete set null,
  auth_user_id bigint references public.auth_users(id) on delete set null,
  mode text not null check (mode in ('chat', 'json')),
  task_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.flowai_job_status not null default 'pending',
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  idempotency_key text,
  result jsonb,
  error text,
  request_ip text,
  available_at timestamptz not null default timezone('utc', now()),
  locked_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowai_job_queue_status_available
on public.flowai_job_queue (status, available_at, priority, created_at);

create index if not exists idx_flowai_job_queue_api_key
on public.flowai_job_queue (api_key_id, created_at desc);

create unique index if not exists idx_flowai_job_queue_idempotency
on public.flowai_job_queue (api_key_id, idempotency_key)
where api_key_id is not null and idempotency_key is not null;

drop trigger if exists tr_flowai_job_queue_updated_at on public.flowai_job_queue;
create trigger tr_flowai_job_queue_updated_at
before update on public.flowai_job_queue
for each row
execute function public.set_updated_at();

create table if not exists public.flowai_api_request_events (
  id uuid primary key default gen_random_uuid(),
  api_key_id bigint references public.auth_user_api_keys(id) on delete set null,
  auth_user_id bigint references public.auth_users(id) on delete set null,
  job_id uuid references public.flowai_job_queue(id) on delete set null,
  request_id text,
  trace_id text,
  mode text not null,
  task_key text not null,
  provider text,
  model text,
  response_status integer not null,
  latency_ms integer,
  queue_wait_ms integer,
  cache_hit boolean not null default false,
  request_ip text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_flowai_api_request_events_api_key_created
on public.flowai_api_request_events (api_key_id, created_at desc);

create index if not exists idx_flowai_api_request_events_task_created
on public.flowai_api_request_events (task_key, created_at desc);

create table if not exists public.flowai_provider_circuit_breakers (
  provider_key text primary key,
  state text not null default 'closed' check (state in ('closed', 'open', 'half_open')),
  consecutive_failures integer not null default 0,
  consecutive_successes integer not null default 0,
  opened_at timestamptz,
  next_attempt_at timestamptz,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.auth_user_api_keys enable row level security;
alter table public.flowai_job_queue enable row level security;
alter table public.flowai_api_request_events enable row level security;
alter table public.flowai_provider_circuit_breakers enable row level security;

do $$ begin
  create policy "service_role_all_auth_user_api_keys"
  on public.auth_user_api_keys
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_all_flowai_job_queue"
  on public.flowai_job_queue
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_all_flowai_api_request_events"
  on public.flowai_api_request_events
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "service_role_all_flowai_provider_circuit_breakers"
  on public.flowai_provider_circuit_breakers
  for all
  to service_role
  using (true)
  with check (true);
exception when duplicate_object then null; end $$;
