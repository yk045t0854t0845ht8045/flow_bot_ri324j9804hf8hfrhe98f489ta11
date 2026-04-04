create table if not exists public.auth_user_favorite_guilds (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, guild_id)
);

create index if not exists idx_auth_user_favorite_guilds_user_sort
on public.auth_user_favorite_guilds (user_id, sort_order);

drop trigger if exists tr_auth_user_favorite_guilds_updated_at on public.auth_user_favorite_guilds;
create trigger tr_auth_user_favorite_guilds_updated_at
before update on public.auth_user_favorite_guilds
for each row
execute function public.set_updated_at();
