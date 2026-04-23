create table if not exists public.guild_settings_secure_snapshots (
  id bigint generated always as identity primary key,
  guild_id text not null,
  module_key text not null,
  payload_encrypted text not null,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_settings_secure_snapshots_unique_module unique (guild_id, module_key)
);

create index if not exists idx_guild_settings_secure_snapshots_guild_module_updated_at
on public.guild_settings_secure_snapshots (guild_id, module_key, updated_at desc);

create index if not exists idx_guild_settings_secure_snapshots_configured_by_user_updated_at
on public.guild_settings_secure_snapshots (configured_by_user_id, updated_at desc);

drop trigger if exists tr_guild_settings_secure_snapshots_updated_at on public.guild_settings_secure_snapshots;
create trigger tr_guild_settings_secure_snapshots_updated_at
before update on public.guild_settings_secure_snapshots
for each row
execute function public.set_updated_at();

alter table public.guild_settings_secure_snapshots enable row level security;

drop policy if exists "service_role_all_guild_settings_secure_snapshots" on public.guild_settings_secure_snapshots;
create policy "service_role_all_guild_settings_secure_snapshots"
on public.guild_settings_secure_snapshots
for all
to service_role
using (true)
with check (true);
