begin;

create table if not exists public.hosting_github_connections (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  github_login text,
  github_account_type text,
  github_avatar_url text,
  encrypted_token text not null,
  token_status text not null default 'active'
    check (token_status in ('active', 'invalid', 'revoked')),
  last_validated_at timestamptz,
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

alter table public.hosting_github_connections
  add column if not exists encrypted_refresh_token text,
  add column if not exists access_token_expires_at timestamptz,
  add column if not exists refresh_token_expires_at timestamptz,
  add column if not exists scopes text,
  add column if not exists token_type text,
  add column if not exists refreshed_at timestamptz;

create index if not exists idx_hosting_github_connections_token_expiry
on public.hosting_github_connections (user_id, token_status, access_token_expires_at);

drop trigger if exists tr_hosting_github_connections_updated_at on public.hosting_github_connections;
create trigger tr_hosting_github_connections_updated_at
before update on public.hosting_github_connections
for each row execute function public.set_updated_at();

alter table public.hosting_github_connections enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_github_connections_service_role_all on public.hosting_github_connections;
    create policy hosting_github_connections_service_role_all
      on public.hosting_github_connections for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;
