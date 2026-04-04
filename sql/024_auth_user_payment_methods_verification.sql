alter table public.auth_user_payment_methods
add column if not exists verification_status text not null default 'verified',
add column if not exists verification_status_detail text,
add column if not exists verification_amount numeric(10,2),
add column if not exists verification_provider_payment_id text,
add column if not exists verified_at timestamptz,
add column if not exists last_context_guild_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_user_payment_methods_verification_status_check'
      and conrelid = 'public.auth_user_payment_methods'::regclass
  ) then
    alter table public.auth_user_payment_methods
    add constraint auth_user_payment_methods_verification_status_check
    check (verification_status in ('verified', 'pending', 'failed', 'cancelled'));
  end if;
end $$;

update public.auth_user_payment_methods
set verified_at = coalesce(verified_at, created_at)
where verification_status = 'verified'
  and verified_at is null;

create index if not exists idx_auth_user_payment_methods_user_verification_status
on public.auth_user_payment_methods (user_id, verification_status);

create index if not exists idx_auth_user_payment_methods_last_context_guild_id
on public.auth_user_payment_methods (last_context_guild_id);

create unique index if not exists idx_auth_user_payment_methods_verification_provider_payment_id
on public.auth_user_payment_methods (verification_provider_payment_id)
where verification_provider_payment_id is not null;
