create table if not exists public.auth_user_plan_guilds (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  activated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_guilds_unique_user_guild unique (user_id, guild_id),
  constraint auth_user_plan_guilds_unique_guild unique (guild_id)
);

create index if not exists idx_auth_user_plan_guilds_user_activated
on public.auth_user_plan_guilds (user_id, activated_at desc);

create index if not exists idx_auth_user_plan_guilds_guild
on public.auth_user_plan_guilds (guild_id);

drop trigger if exists tr_auth_user_plan_guilds_updated_at on public.auth_user_plan_guilds;
create trigger tr_auth_user_plan_guilds_updated_at
before update on public.auth_user_plan_guilds
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_guilds enable row level security;

drop policy if exists "service_role_all_auth_user_plan_guilds" on public.auth_user_plan_guilds;
create policy "service_role_all_auth_user_plan_guilds"
on public.auth_user_plan_guilds
for all
to service_role
using (true)
with check (true);

