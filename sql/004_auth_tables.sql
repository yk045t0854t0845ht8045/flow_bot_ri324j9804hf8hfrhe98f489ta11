create extension if not exists pgcrypto;

create table if not exists public.auth_users (
  id bigint generated always as identity primary key,
  discord_user_id text not null unique,
  username text not null,
  global_name text,
  display_name text not null,
  avatar text,
  email text,
  locale text,
  raw_user jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_users_updated_at on public.auth_users;
create trigger tr_auth_users_updated_at
before update on public.auth_users
for each row
execute function public.set_updated_at();

create table if not exists public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  session_token_hash text not null unique,
  ip_address text,
  user_agent text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_sessions_user_id
on public.auth_sessions (user_id);

create index if not exists idx_auth_sessions_expires_at
on public.auth_sessions (expires_at);

create index if not exists idx_auth_sessions_revoked_at
on public.auth_sessions (revoked_at);
