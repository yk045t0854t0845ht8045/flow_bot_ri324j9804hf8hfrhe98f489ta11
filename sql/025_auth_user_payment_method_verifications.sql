create table if not exists public.auth_user_payment_method_verifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  method_id text not null,
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'BRL',
  provider text not null default 'mercado_pago',
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'failed', 'cancelled')),
  payer_name text,
  payer_document text,
  payer_document_type text check (payer_document_type in ('CPF', 'CNPJ')),
  provider_payment_id text,
  provider_external_reference text,
  provider_status text,
  provider_status_detail text,
  provider_payload jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_user_payment_method_verifications_user_created_at
on public.auth_user_payment_method_verifications (user_id, created_at desc);

create index if not exists idx_auth_user_payment_method_verifications_guild_status
on public.auth_user_payment_method_verifications (guild_id, status);

create index if not exists idx_auth_user_payment_method_verifications_method_id
on public.auth_user_payment_method_verifications (method_id);

create unique index if not exists idx_auth_user_payment_method_verifications_provider_payment_id
on public.auth_user_payment_method_verifications (provider_payment_id)
where provider_payment_id is not null;

create unique index if not exists idx_auth_user_payment_method_verifications_provider_external_reference
on public.auth_user_payment_method_verifications (provider_external_reference)
where provider_external_reference is not null;

drop trigger if exists tr_auth_user_payment_method_verifications_updated_at on public.auth_user_payment_method_verifications;
create trigger tr_auth_user_payment_method_verifications_updated_at
before update on public.auth_user_payment_method_verifications
for each row
execute function public.set_updated_at();
