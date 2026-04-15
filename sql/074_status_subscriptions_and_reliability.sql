-- Status subscriptions and reliability upgrade
-- Execute after 072_status_system_upgrade.sql

alter table public.system_incidents
  add column if not exists team_note_title text,
  add column if not exists team_note_body text,
  add column if not exists team_note_source text,
  add column if not exists team_note_generated_at timestamptz,
  add column if not exists false_alarm_score numeric(5,2) not null default 0,
  add column if not exists signal_snapshot jsonb not null default '{}'::jsonb;

alter table public.system_status_subscriptions
  add column if not exists user_id bigint references public.auth_users(id) on delete set null,
  add column if not exists label text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists is_active boolean not null default true,
  add column if not exists verified_at timestamptz,
  add column if not exists last_tested_at timestamptz,
  add column if not exists last_delivery_at timestamptz,
  add column if not exists last_delivery_status integer,
  add column if not exists last_delivery_error text,
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

create table if not exists public.system_status_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.system_status_subscriptions(id) on delete cascade,
  event_type text not null,
  request_url text not null,
  request_headers jsonb not null default '{}'::jsonb,
  request_body jsonb not null default '{}'::jsonb,
  response_status integer,
  response_body text,
  delivered boolean not null default false,
  latency_ms integer,
  created_at timestamptz not null default timezone('utc', now())
);

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

create index if not exists idx_system_status_subscriptions_user_type
on public.system_status_subscriptions (user_id, type)
where user_id is not null;

create index if not exists idx_system_status_subscriptions_active
on public.system_status_subscriptions (is_active, type, created_at desc);

create unique index if not exists idx_system_status_subscriptions_user_type_unique
on public.system_status_subscriptions (user_id, type)
where user_id is not null and type in ('email', 'discord_dm', 'webhook');

create index if not exists idx_system_status_webhook_deliveries_subscription
on public.system_status_webhook_deliveries (subscription_id, created_at desc);

create index if not exists idx_system_status_monitor_snapshots_source
on public.system_status_monitor_snapshots (source_key, observed_at desc);

create or replace function public.touch_system_status_subscription_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists tr_system_status_subscriptions_touch_updated_at on public.system_status_subscriptions;
create trigger tr_system_status_subscriptions_touch_updated_at
before update on public.system_status_subscriptions
for each row
execute function public.touch_system_status_subscription_updated_at();

alter table public.system_status_webhook_deliveries enable row level security;
alter table public.system_status_monitor_snapshots enable row level security;

do $$ begin
  create policy "Public can view status monitor snapshots"
  on public.system_status_monitor_snapshots
  for select
  using (true);
exception when duplicate_object then null; end $$;

update public.system_status_subscriptions
set
  label = case
    when type = 'email' then coalesce(label, 'Atualizacoes por email')
    when type = 'discord_dm' then coalesce(label, 'Alertas por Discord DM')
    when type = 'webhook' then coalesce(label, 'Webhook de status')
    when type = 'discord_channel' then coalesce(label, 'Canal oficial do Discord')
    else label
  end,
  verified_at = coalesce(verified_at, created_at),
  updated_at = timezone('utc', now())
where true;

create or replace view public.system_status_active_subscriptions as
select
  id,
  user_id,
  type,
  target,
  label,
  metadata,
  verified_at,
  last_tested_at,
  last_delivery_at,
  last_delivery_status,
  last_delivery_error,
  created_at,
  updated_at
from public.system_status_subscriptions
where is_active = true;
