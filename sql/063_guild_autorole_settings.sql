create table if not exists public.guild_autorole_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  role_ids jsonb not null default '[]'::jsonb,
  assignment_delay_minutes integer not null default 0,
  existing_members_sync_requested_at timestamptz null,
  existing_members_sync_started_at timestamptz null,
  existing_members_sync_completed_at timestamptz null,
  existing_members_sync_status text not null default 'idle',
  existing_members_sync_error text null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_autorole_settings_role_ids_array_check
    check (jsonb_typeof(role_ids) = 'array'),
  constraint guild_autorole_settings_assignment_delay_check
    check (assignment_delay_minutes in (0, 10, 20, 30)),
  constraint guild_autorole_settings_existing_members_sync_status_check
    check (existing_members_sync_status in ('idle', 'pending', 'processing', 'completed', 'failed'))
);

drop trigger if exists tr_guild_autorole_settings_updated_at on public.guild_autorole_settings;
create trigger tr_guild_autorole_settings_updated_at
before update on public.guild_autorole_settings
for each row
execute function public.set_updated_at();

create table if not exists public.guild_autorole_queue (
  id bigint generated always as identity primary key,
  guild_id text not null,
  member_id text not null,
  due_at timestamptz not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  requested_source text not null default 'member_join',
  last_error text null,
  processed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_autorole_queue_status_check
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  constraint guild_autorole_queue_attempt_count_check
    check (attempt_count >= 0),
  constraint guild_autorole_queue_requested_source_check
    check (requested_source in ('member_join', 'existing_members_sync'))
);

create index if not exists idx_guild_autorole_queue_status_due_at
on public.guild_autorole_queue (status, due_at asc, created_at asc);

create index if not exists idx_guild_autorole_queue_guild_member
on public.guild_autorole_queue (guild_id, member_id, created_at desc);

drop trigger if exists tr_guild_autorole_queue_updated_at on public.guild_autorole_queue;
create trigger tr_guild_autorole_queue_updated_at
before update on public.guild_autorole_queue
for each row
execute function public.set_updated_at();

alter table public.guild_autorole_settings enable row level security;
alter table public.guild_autorole_queue enable row level security;

drop policy if exists "service_role_all_guild_autorole_settings" on public.guild_autorole_settings;
create policy "service_role_all_guild_autorole_settings"
on public.guild_autorole_settings
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_guild_autorole_queue" on public.guild_autorole_queue;
create policy "service_role_all_guild_autorole_queue"
on public.guild_autorole_queue
for all
to service_role
using (true)
with check (true);
