create extension if not exists pgcrypto;

alter table if exists public.auth_users
  alter column discord_user_id drop not null;

alter table if exists public.auth_users
  add column if not exists email_normalized text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists google_user_id text,
  add column if not exists microsoft_user_id text,
  add column if not exists last_login_at timestamptz,
  add column if not exists last_auth_method text;

update public.auth_users
set
  email = nullif(lower(trim(email)), ''),
  email_normalized = nullif(lower(trim(email)), '')
where email is not null
  and (
    email is distinct from nullif(lower(trim(email)), '')
    or email_normalized is distinct from nullif(lower(trim(email)), '')
  );

do $$
declare
  duplicate_record record;
  base_username text;
  candidate_username text;
  suffix_number integer;
begin
  for duplicate_record in
    select id, username
    from (
      select
        id,
        username,
        row_number() over (
          partition by username
          order by id
        ) as duplicate_rank
      from public.auth_users
      where username is not null
    ) duplicated
    where duplicate_rank > 1
    order by id
  loop
    base_username := lower(trim(coalesce(duplicate_record.username, 'flowdesk-user')));
    base_username := regexp_replace(base_username, '[^a-z0-9._-]+', '-', 'g');
    base_username := regexp_replace(base_username, '-{2,}', '-', 'g');
    base_username := regexp_replace(base_username, '^[-._]+|[-._]+$', '', 'g');
    base_username := left(nullif(base_username, ''), 32);

    if base_username is null then
      base_username := 'flowdesk-user';
    end if;

    candidate_username := base_username;
    suffix_number := 2;

    while exists (
      select 1
      from public.auth_users
      where username = candidate_username
        and id <> duplicate_record.id
    ) loop
      candidate_username :=
        left(
          base_username,
          greatest(1, 32 - char_length('-' || suffix_number::text))
        ) || '-' || suffix_number::text;
      suffix_number := suffix_number + 1;
    end loop;

    update public.auth_users
    set username = candidate_username
    where id = duplicate_record.id;
  end loop;
end
$$;

create unique index if not exists idx_auth_users_username_unique
on public.auth_users (username);

create unique index if not exists idx_auth_users_email_normalized_unique
on public.auth_users (email_normalized)
where email_normalized is not null;

create index if not exists idx_auth_users_discord_user_id_not_null
on public.auth_users (discord_user_id)
where discord_user_id is not null;

create unique index if not exists idx_auth_users_google_user_id_unique
on public.auth_users (google_user_id)
where google_user_id is not null;

create unique index if not exists idx_auth_users_microsoft_user_id_unique
on public.auth_users (microsoft_user_id)
where microsoft_user_id is not null;

create table if not exists public.auth_user_credentials (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  password_hash text not null,
  password_version integer not null default 1,
  password_set_at timestamptz not null default timezone('utc', now()),
  last_password_login_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_credentials_password_hash_length_check
    check (char_length(password_hash) >= 32)
);

drop trigger if exists tr_auth_user_credentials_updated_at on public.auth_user_credentials;
create trigger tr_auth_user_credentials_updated_at
before update on public.auth_user_credentials
for each row
execute function public.set_updated_at();

create table if not exists public.auth_email_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email text not null,
  email_normalized text not null,
  purpose text not null default 'login',
  code_hash text not null,
  ip_address text,
  user_agent text,
  attempts integer not null default 0,
  max_attempts integer not null default 6,
  resend_count integer not null default 0,
  last_sent_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_email_otp_challenges_purpose_check
    check (purpose in ('login')),
  constraint auth_email_otp_challenges_attempts_check
    check (attempts >= 0 and attempts <= 50),
  constraint auth_email_otp_challenges_resend_count_check
    check (resend_count >= 0 and resend_count <= 20)
);

alter table public.auth_email_otp_challenges
  add column if not exists metadata jsonb not null default '{}'::jsonb;

drop trigger if exists tr_auth_email_otp_challenges_updated_at on public.auth_email_otp_challenges;
create trigger tr_auth_email_otp_challenges_updated_at
before update on public.auth_email_otp_challenges
for each row
execute function public.set_updated_at();

create index if not exists idx_auth_email_otp_challenges_user_created_at
on public.auth_email_otp_challenges (user_id, created_at desc);

create index if not exists idx_auth_email_otp_challenges_email_created_at
on public.auth_email_otp_challenges (email_normalized, created_at desc);

create index if not exists idx_auth_email_otp_challenges_expires_at
on public.auth_email_otp_challenges (expires_at);

create index if not exists idx_auth_email_otp_challenges_active
on public.auth_email_otp_challenges (email_normalized, expires_at desc)
where consumed_at is null;

create index if not exists idx_auth_email_otp_challenges_active_user_purpose
on public.auth_email_otp_challenges (user_id, purpose, expires_at desc)
where consumed_at is null;

create table if not exists public.auth_user_trusted_devices (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  token_hash text not null unique,
  user_agent_hash text,
  last_used_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_trusted_devices_token_hash_length_check
    check (char_length(token_hash) >= 32)
);

alter table public.auth_user_trusted_devices
  add column if not exists user_agent_hash text,
  add column if not exists last_used_at timestamptz,
  add column if not exists revoked_at timestamptz;

drop trigger if exists tr_auth_user_trusted_devices_updated_at on public.auth_user_trusted_devices;
create trigger tr_auth_user_trusted_devices_updated_at
before update on public.auth_user_trusted_devices
for each row
execute function public.set_updated_at();

create index if not exists idx_auth_user_trusted_devices_user_expires_at
on public.auth_user_trusted_devices (user_id, expires_at desc);

create index if not exists idx_auth_user_trusted_devices_active
on public.auth_user_trusted_devices (user_id, expires_at desc)
where revoked_at is null;

alter table if exists public.auth_sessions
  add column if not exists discord_access_token text,
  add column if not exists discord_refresh_token text,
  add column if not exists discord_token_expires_at timestamptz,
  add column if not exists auth_method text,
  add column if not exists otp_verified_at timestamptz,
  add column if not exists remembered_until timestamptz;

update public.auth_sessions s
set auth_method = coalesce(
  s.auth_method,
  case
    when s.discord_access_token is not null then 'discord'
    when u.google_user_id is not null and u.discord_user_id is null then 'google'
    when u.microsoft_user_id is not null and u.discord_user_id is null then 'microsoft'
    else 'email'
  end
)
from public.auth_users u
where u.id = s.user_id
  and s.auth_method is null;

update public.auth_sessions
set auth_method = 'email'
where auth_method is null;

alter table public.auth_sessions
  alter column auth_method set default 'email';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_sessions_auth_method_check'
      and conrelid = 'public.auth_sessions'::regclass
  ) then
    alter table public.auth_sessions
      add constraint auth_sessions_auth_method_check
      check (auth_method in ('email', 'discord', 'google', 'microsoft'));
  end if;
end
$$;

create index if not exists idx_auth_sessions_auth_method_expires_at
on public.auth_sessions (auth_method, expires_at desc);

create index if not exists idx_auth_sessions_remembered_until
on public.auth_sessions (remembered_until)
where remembered_until is not null;

alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.auth_user_credentials enable row level security;
alter table public.auth_email_otp_challenges enable row level security;
alter table public.auth_user_trusted_devices enable row level security;

drop policy if exists "service_role_all_auth_users" on public.auth_users;
create policy "service_role_all_auth_users"
on public.auth_users
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_sessions" on public.auth_sessions;
create policy "service_role_all_auth_sessions"
on public.auth_sessions
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_credentials" on public.auth_user_credentials;
create policy "service_role_all_auth_user_credentials"
on public.auth_user_credentials
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_email_otp_challenges" on public.auth_email_otp_challenges;
create policy "service_role_all_auth_email_otp_challenges"
on public.auth_email_otp_challenges
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_trusted_devices" on public.auth_user_trusted_devices;
create policy "service_role_all_auth_user_trusted_devices"
on public.auth_user_trusted_devices
for all
to service_role
using (true)
with check (true);
