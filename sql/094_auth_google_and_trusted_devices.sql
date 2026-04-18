alter table public.auth_users
  add column if not exists google_user_id text;

create unique index if not exists idx_auth_users_google_user_id_unique
on public.auth_users (google_user_id)
where google_user_id is not null;

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
