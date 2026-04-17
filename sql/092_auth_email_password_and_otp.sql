alter table public.auth_users
  alter column discord_user_id drop not null;

alter table public.auth_users
  add column if not exists email_normalized text,
  add column if not exists email_verified_at timestamptz,
  add column if not exists last_login_at timestamptz,
  add column if not exists last_auth_method text;

update public.auth_users
set
  email = lower(trim(email)),
  email_normalized = lower(trim(email))
where email is not null
  and (
    email <> lower(trim(email))
    or email_normalized is distinct from lower(trim(email))
  );

create unique index if not exists idx_auth_users_email_normalized_unique
on public.auth_users (email_normalized)
where email_normalized is not null;

create index if not exists idx_auth_users_discord_user_id_not_null
on public.auth_users (discord_user_id)
where discord_user_id is not null;

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
