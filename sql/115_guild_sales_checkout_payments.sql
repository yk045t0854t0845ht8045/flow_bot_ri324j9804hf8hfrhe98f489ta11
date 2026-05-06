-- Sales payment methods, Discord carts, checkout links and delivery records.
-- Safe to run more than once.

create table if not exists public.guild_sales_payment_methods (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  method_key text not null,
  provider text not null default '',
  payment_rail text not null default '',
  display_name text not null,
  status text not null default 'disabled',
  credentials_configured boolean not null default false,
  environment text not null default 'production',
  public_key_fingerprint text not null default '',
  access_token_fingerprint text not null default '',
  last_health_status text not null default 'unchecked',
  last_health_error text not null default '',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_payment_methods_unique_method unique (guild_id, method_key),
  constraint guild_sales_payment_methods_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_payment_methods_method_key_check
    check (method_key in ('mercado_pago', 'flowpay', 'card', 'boleto', 'paypal', 'nupay')),
  constraint guild_sales_payment_methods_provider_check
    check (provider in ('', 'mercado_pago', 'flowpay', 'stripe', 'paypal', 'nupay')),
  constraint guild_sales_payment_methods_payment_rail_check
    check (payment_rail in ('', 'pix', 'card', 'boleto', 'wallet')),
  constraint guild_sales_payment_methods_status_check
    check (status in ('active', 'disabled')),
  constraint guild_sales_payment_methods_environment_check
    check (environment in ('production', 'test')),
  constraint guild_sales_payment_methods_health_check
    check (last_health_status in ('unchecked', 'ok', 'failed'))
);

create index if not exists idx_guild_sales_payment_methods_guild_status
on public.guild_sales_payment_methods (guild_id, status, method_key);

drop trigger if exists tr_guild_sales_payment_methods_updated_at on public.guild_sales_payment_methods;
create trigger tr_guild_sales_payment_methods_updated_at
before update on public.guild_sales_payment_methods
for each row
execute function public.set_updated_at();

alter table public.guild_sales_payment_methods enable row level security;

drop policy if exists "service_role_all_guild_sales_payment_methods" on public.guild_sales_payment_methods;
create policy "service_role_all_guild_sales_payment_methods"
on public.guild_sales_payment_methods
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_carts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  discord_user_id text not null,
  discord_channel_id text null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  status text not null default 'link_required',
  currency text not null default 'BRL',
  subtotal_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  selected_payment_method_key text null,
  provider text null,
  provider_payment_id text null,
  provider_external_reference text null,
  provider_status text null,
  provider_status_detail text null,
  provider_qr_code text null,
  provider_qr_base64 text null,
  provider_ticket_url text null,
  provider_payload jsonb not null default '{}'::jsonb,
  payment_expires_at timestamptz null,
  paid_at timestamptz null,
  delivered_at timestamptz null,
  cancelled_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_carts_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_carts_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_carts_discord_channel_id_check
    check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_carts_status_check
    check (status in ('link_required', 'open', 'payment_pending', 'paid', 'delivered', 'delivery_failed', 'rejected', 'cancelled', 'expired')),
  constraint guild_sales_carts_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint guild_sales_carts_amount_check
    check (subtotal_amount >= 0 and total_amount >= 0),
  constraint guild_sales_carts_selected_method_check
    check (selected_payment_method_key is null or selected_payment_method_key in ('mercado_pago', 'flowpay', 'card', 'boleto', 'paypal', 'nupay'))
);

create index if not exists idx_guild_sales_carts_guild_user_status
on public.guild_sales_carts (guild_id, discord_user_id, status, created_at desc);

create index if not exists idx_guild_sales_carts_channel
on public.guild_sales_carts (guild_id, discord_channel_id)
where discord_channel_id is not null;

create unique index if not exists idx_guild_sales_carts_provider_payment_unique
on public.guild_sales_carts (provider, provider_payment_id)
where provider_payment_id is not null;

create unique index if not exists idx_guild_sales_carts_provider_external_ref_unique
on public.guild_sales_carts (provider_external_reference)
where provider_external_reference is not null;

drop trigger if exists tr_guild_sales_carts_updated_at on public.guild_sales_carts;
create trigger tr_guild_sales_carts_updated_at
before update on public.guild_sales_carts
for each row
execute function public.set_updated_at();

alter table public.guild_sales_carts enable row level security;

drop policy if exists "service_role_all_guild_sales_carts" on public.guild_sales_carts;
create policy "service_role_all_guild_sales_carts"
on public.guild_sales_carts
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  product_id uuid not null references public.guild_sales_products(id) on delete restrict,
  quantity integer not null default 1,
  unit_price_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  product_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_cart_items_unique_product unique (cart_id, product_id),
  constraint guild_sales_cart_items_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_cart_items_quantity_check
    check (quantity between 1 and 999),
  constraint guild_sales_cart_items_amount_check
    check (unit_price_amount >= 0 and total_amount >= 0)
);

create index if not exists idx_guild_sales_cart_items_cart
on public.guild_sales_cart_items (cart_id, created_at asc);

drop trigger if exists tr_guild_sales_cart_items_updated_at on public.guild_sales_cart_items;
create trigger tr_guild_sales_cart_items_updated_at
before update on public.guild_sales_cart_items
for each row
execute function public.set_updated_at();

alter table public.guild_sales_cart_items enable row level security;

drop policy if exists "service_role_all_guild_sales_cart_items" on public.guild_sales_cart_items;
create policy "service_role_all_guild_sales_cart_items"
on public.guild_sales_cart_items
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_checkout_links (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  discord_user_id text not null,
  token_hash text not null unique,
  status text not null default 'pending',
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  expires_at timestamptz not null,
  confirmed_at timestamptz null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_checkout_links_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_checkout_links_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_checkout_links_status_check
    check (status in ('pending', 'confirmed', 'expired', 'revoked'))
);

create index if not exists idx_guild_sales_checkout_links_cart_status
on public.guild_sales_checkout_links (cart_id, status, created_at desc);

drop trigger if exists tr_guild_sales_checkout_links_updated_at on public.guild_sales_checkout_links;
create trigger tr_guild_sales_checkout_links_updated_at
before update on public.guild_sales_checkout_links
for each row
execute function public.set_updated_at();

alter table public.guild_sales_checkout_links enable row level security;

drop policy if exists "service_role_all_guild_sales_checkout_links" on public.guild_sales_checkout_links;
create policy "service_role_all_guild_sales_checkout_links"
on public.guild_sales_checkout_links
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_order_deliveries (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  auth_user_id bigint not null references public.auth_users(id) on delete cascade,
  discord_user_id text not null,
  product_id uuid not null references public.guild_sales_products(id) on delete restrict,
  stock_item_id uuid null references public.guild_sales_stock_items(id) on delete set null,
  delivery_method text not null,
  status text not null default 'delivered',
  delivery_payload jsonb not null default '{}'::jsonb,
  delivered_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_order_deliveries_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_order_deliveries_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_order_deliveries_delivery_method_check
    check (delivery_method in ('email', 'discord_dm', 'flowdesk_link')),
  constraint guild_sales_order_deliveries_status_check
    check (status in ('delivered', 'failed'))
);

create index if not exists idx_guild_sales_order_deliveries_cart
on public.guild_sales_order_deliveries (cart_id, created_at asc);

create index if not exists idx_guild_sales_order_deliveries_auth_user
on public.guild_sales_order_deliveries (auth_user_id, created_at desc);

alter table public.guild_sales_order_deliveries enable row level security;

drop policy if exists "service_role_all_guild_sales_order_deliveries" on public.guild_sales_order_deliveries;
create policy "service_role_all_guild_sales_order_deliveries"
on public.guild_sales_order_deliveries
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_payment_methods is 'Metodos de pagamento por servidor; segredos ficam no cofre cifrado guild_settings_secure_snapshots.';
comment on table public.guild_sales_carts is 'Carrinhos de vendas criados pelo bot Discord e conciliados pelo site.';
comment on table public.guild_sales_checkout_links is 'Tokens efemeros para confirmar que a compra do Discord pertence a uma conta autenticada Flowdesk.';
comment on table public.guild_sales_order_deliveries is 'Entregas liberadas apos pagamento aprovado, visiveis ao comprador autenticado.';
