create table if not exists public.auth_user_discord_links (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  discord_user_id text not null,
  guild_id text not null,
  channel_id text,
  role_id text not null,
  status text not null default 'pending',
  linked_at timestamptz,
  role_granted_at timestamptz,
  last_role_sync_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_discord_links_user_guild_unique unique (user_id, guild_id),
  constraint auth_user_discord_links_discord_guild_unique unique (discord_user_id, guild_id),
  constraint auth_user_discord_links_status_check check (
    status in ('pending', 'pending_member', 'linked', 'failed')
  )
);

create index if not exists idx_auth_user_discord_links_user_id
on public.auth_user_discord_links (user_id);

create index if not exists idx_auth_user_discord_links_guild_id
on public.auth_user_discord_links (guild_id);

create index if not exists idx_auth_user_discord_links_status
on public.auth_user_discord_links (status);

create index if not exists idx_auth_user_discord_links_discord_user_id
on public.auth_user_discord_links (discord_user_id);

drop trigger if exists tr_auth_user_discord_links_updated_at on public.auth_user_discord_links;
create trigger tr_auth_user_discord_links_updated_at
before update on public.auth_user_discord_links
for each row
execute function public.set_updated_at();
