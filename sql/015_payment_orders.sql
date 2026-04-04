create table if not exists public.payment_orders (
  id bigint generated always as identity primary key,
  order_number bigint generated always as identity (start with 90000 increment by 1) unique,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text not null,
  payment_method text not null check (payment_method in ('pix', 'card')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'BRL',
  payer_name text,
  payer_document text,
  payer_document_type text check (payer_document_type in ('CPF', 'CNPJ')),
  provider text not null default 'mercado_pago',
  provider_payment_id text,
  provider_external_reference text,
  provider_qr_code text,
  provider_qr_base64 text,
  provider_ticket_url text,
  provider_status text,
  provider_status_detail text,
  provider_payload jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_orders_user_created_at
on public.payment_orders (user_id, created_at desc);

create index if not exists idx_payment_orders_guild_status
on public.payment_orders (guild_id, status);

create index if not exists idx_payment_orders_status_created_at
on public.payment_orders (status, created_at desc);

create unique index if not exists idx_payment_orders_provider_payment_id_unique
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create unique index if not exists idx_payment_orders_provider_external_reference_unique
on public.payment_orders (provider_external_reference)
where provider_external_reference is not null;

drop trigger if exists tr_payment_orders_updated_at on public.payment_orders;
create trigger tr_payment_orders_updated_at
before update on public.payment_orders
for each row
execute function public.set_updated_at();

create table if not exists public.payment_order_events (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  event_type text not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_order_events_order_created_at
on public.payment_order_events (payment_order_id, created_at desc);
