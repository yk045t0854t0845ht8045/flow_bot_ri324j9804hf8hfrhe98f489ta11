create table if not exists public.auth_password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete cascade,
  email_normalized text not null,
  token_hash text not null unique,
  ip_address text null,
  user_agent text null,
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_password_reset_tokens_attempts_check
    check (attempts >= 0 and attempts <= 50)
);

create index if not exists idx_auth_password_reset_tokens_user_created_at
on public.auth_password_reset_tokens (user_id, created_at desc);

create index if not exists idx_auth_password_reset_tokens_email_created_at
on public.auth_password_reset_tokens (email_normalized, created_at desc);

create index if not exists idx_auth_password_reset_tokens_active
on public.auth_password_reset_tokens (token_hash, expires_at desc)
where consumed_at is null;

drop trigger if exists tr_auth_password_reset_tokens_updated_at on public.auth_password_reset_tokens;
create trigger tr_auth_password_reset_tokens_updated_at
before update on public.auth_password_reset_tokens
for each row
execute function public.set_updated_at();

alter table public.auth_password_reset_tokens enable row level security;

drop policy if exists "service_role_all_auth_password_reset_tokens" on public.auth_password_reset_tokens;
create policy "service_role_all_auth_password_reset_tokens"
on public.auth_password_reset_tokens
for all
to service_role
using (true)
with check (true);
