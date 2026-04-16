alter table public.system_components
  add column if not exists status_message text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_raw_status system_status_type,
  add column if not exists last_raw_checked_at timestamptz;

create index if not exists idx_system_components_last_checked_at
on public.system_components (last_checked_at desc nulls last);

create index if not exists idx_system_components_source_key
on public.system_components (source_key);

alter table public.system_incidents
  add column if not exists signal_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists false_alarm_score numeric(5,2) not null default 0;

create table if not exists public.system_status_monitor_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  component_slug text,
  status system_status_type not null,
  latency_ms integer,
  response_code integer,
  message text,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default timezone('utc', now())
);

alter table public.system_status_monitor_snapshots
  add column if not exists component_id uuid references public.system_components(id) on delete set null,
  add column if not exists component_name text,
  add column if not exists stable_status system_status_type;

create index if not exists idx_system_status_monitor_snapshots_source
on public.system_status_monitor_snapshots (source_key, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_component
on public.system_status_monitor_snapshots (component_id, observed_at desc);

create index if not exists idx_system_status_monitor_snapshots_stable_status
on public.system_status_monitor_snapshots (stable_status, observed_at desc);

alter table public.system_status_monitor_snapshots enable row level security;

do $$ begin
  create policy "Public can view status monitor snapshots"
  on public.system_status_monitor_snapshots
  for select
  using (true);
exception when duplicate_object then null; end $$;
