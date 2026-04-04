create table if not exists public.auth_user_teams (
  id bigint generated always as identity primary key,
  owner_user_id bigint not null references public.auth_users(id) on delete cascade,
  name text not null,
  icon_key text not null default 'aurora',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_user_teams_owner_user_id
on public.auth_user_teams (owner_user_id);

drop trigger if exists tr_auth_user_teams_updated_at on public.auth_user_teams;
create trigger tr_auth_user_teams_updated_at
before update on public.auth_user_teams
for each row
execute function public.set_updated_at();

create table if not exists public.auth_user_team_servers (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.auth_user_teams(id) on delete cascade,
  guild_id text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (team_id, guild_id)
);

create index if not exists idx_auth_user_team_servers_team_id
on public.auth_user_team_servers (team_id);

create index if not exists idx_auth_user_team_servers_guild_id
on public.auth_user_team_servers (guild_id);

drop trigger if exists tr_auth_user_team_servers_updated_at on public.auth_user_team_servers;
create trigger tr_auth_user_team_servers_updated_at
before update on public.auth_user_team_servers
for each row
execute function public.set_updated_at();

create table if not exists public.auth_user_team_members (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.auth_user_teams(id) on delete cascade,
  invited_discord_user_id text not null,
  invited_auth_user_id bigint references public.auth_users(id) on delete set null,
  invited_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  accepted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (team_id, invited_discord_user_id)
);

create index if not exists idx_auth_user_team_members_team_id
on public.auth_user_team_members (team_id);

create index if not exists idx_auth_user_team_members_invited_discord_user_id
on public.auth_user_team_members (invited_discord_user_id);

create index if not exists idx_auth_user_team_members_invited_auth_user_id
on public.auth_user_team_members (invited_auth_user_id);

create index if not exists idx_auth_user_team_members_status
on public.auth_user_team_members (status);

drop trigger if exists tr_auth_user_team_members_updated_at on public.auth_user_team_members;
create trigger tr_auth_user_team_members_updated_at
before update on public.auth_user_team_members
for each row
execute function public.set_updated_at();
