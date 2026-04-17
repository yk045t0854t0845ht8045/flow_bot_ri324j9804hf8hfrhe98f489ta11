-- Baseline consolidado do dominio de pagamentos/planos.
-- Use este arquivo em bootstrap limpo de PostgreSQL.
-- Nao combine este baseline com a sequencia historica 015..087 no mesmo banco novo.
-- Pre-requisito: a tabela public.auth_users precisa existir.

begin;

do $$
begin
  if to_regclass('public.auth_users') is null then
    raise exception 'Pre-requisito ausente: public.auth_users.';
  end if;
end
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.base36_encode_bigint(p_value bigint)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_value bigint := abs(p_value);
  v_remainder integer;
  v_encoded text := '';
begin
  if p_value = 0 then
    return '0';
  end if;

  while v_value > 0 loop
    v_remainder := (v_value % 36)::integer;
    v_encoded := substr(v_alphabet, v_remainder + 1, 1) || v_encoded;
    v_value := v_value / 36;
  end loop;

  if p_value < 0 then
    return '-' || v_encoded;
  end if;

  return v_encoded;
end;
$$;

create or replace function public.payment_parse_numeric(
  p_value text,
  p_default numeric default 0
)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return p_default;
  end if;

  if btrim(p_value) ~ '^-?[0-9]+(\.[0-9]+)?$' then
    return p_value::numeric;
  end if;

  return p_default;
end;
$$;

create or replace function public.payment_parse_boolean(
  p_value text,
  p_default boolean default false
)
returns boolean
language plpgsql
immutable
as $$
declare
  v_normalized text;
begin
  if p_value is null or btrim(p_value) = '' then
    return p_default;
  end if;

  v_normalized := lower(btrim(p_value));

  if v_normalized in ('1', 'true', 't', 'yes', 'y', 'on') then
    return true;
  end if;

  if v_normalized in ('0', 'false', 'f', 'no', 'n', 'off') then
    return false;
  end if;

  return p_default;
end;
$$;

create or replace function public.ensure_service_role_all_policy(
  p_table regclass,
  p_policy_name text
)
returns void
language plpgsql
as $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'service_role'
  ) then
    execute format('drop policy if exists %I on %s', p_policy_name, p_table);
    execute format(
      'create policy %I on %s for all to service_role using (true) with check (true)',
      p_policy_name,
      p_table
    );
  end if;
end;
$$;

create table if not exists public.payment_orders (
  id bigint generated always as identity primary key,
  order_number bigint generated always as identity (start with 90000 increment by 1) unique,
  order_public_id text,
  cart_public_id text,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null default 'guild'
    check (scope_type in ('account', 'guild')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  amount numeric(10,2) not null
    check (amount >= 0),
  currency text not null default 'BRL',
  payer_name text,
  payer_document text,
  payer_document_type text
    check (payer_document_type in ('CPF', 'CNPJ')),
  provider text not null default 'mercado_pago',
  provider_payment_id text,
  provider_external_reference text,
  provider_qr_code text,
  provider_qr_base64 text,
  provider_ticket_url text,
  provider_status text,
  provider_status_detail text,
  provider_payload jsonb not null default '{}'::jsonb,
  checkout_link_nonce text,
  checkout_link_expires_at timestamptz,
  checkout_link_invalidated_at timestamptz,
  plan_code text not null default 'pro'
    check (plan_code in ('basic', 'pro', 'ultra', 'master')),
  plan_name text not null default 'Flow Pro',
  plan_billing_cycle_days integer not null default 30
    check (plan_billing_cycle_days > 0),
  plan_max_licensed_servers integer not null default 1
    check (plan_max_licensed_servers > 0),
  plan_max_active_tickets integer not null default 0
    check (plan_max_active_tickets >= 0),
  plan_max_automations integer not null default 0
    check (plan_max_automations >= 0),
  plan_max_monthly_actions integer not null default 0
    check (plan_max_monthly_actions >= 0),
  checkout_surface text not null default 'payment',
  checkout_origin text not null default 'flowdesk_checkout',
  paid_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_payment_orders_order_public_id_unique
on public.payment_orders (order_public_id)
where order_public_id is not null;

create unique index if not exists idx_payment_orders_cart_public_id_unique
on public.payment_orders (cart_public_id)
where cart_public_id is not null;

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

create index if not exists idx_payment_orders_checkout_link_expires_at
on public.payment_orders (checkout_link_expires_at)
where checkout_link_expires_at is not null;

create index if not exists idx_payment_orders_checkout_link_invalidated_at
on public.payment_orders (checkout_link_invalidated_at)
where checkout_link_invalidated_at is not null;

create index if not exists idx_payment_orders_user_guild_checkout_link
on public.payment_orders (user_id, guild_id, updated_at desc);

create index if not exists idx_payment_orders_provider_payment_id
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create index if not exists idx_payment_orders_reconcile_status_updated_at
on public.payment_orders (status, updated_at desc)
where provider_payment_id is not null;

create index if not exists idx_payment_orders_unpaid_setup_user_status_created_at
on public.payment_orders (user_id, status, created_at desc)
where status in ('pending', 'failed', 'expired');

create index if not exists idx_payment_orders_unpaid_setup_guild_status_created_at
on public.payment_orders (guild_id, status, created_at desc)
where guild_id is not null
  and status in ('pending', 'failed', 'expired');

create index if not exists idx_payment_orders_guild_status_paid_at
on public.payment_orders (guild_id, status, paid_at desc);

create index if not exists idx_payment_orders_guild_status_created_at
on public.payment_orders (guild_id, status, created_at desc);

create index if not exists idx_payment_orders_user_id_status_v2
on public.payment_orders (user_id, status);

create index if not exists idx_payment_orders_user_id_approved_guild_id_v2
on public.payment_orders (user_id, guild_id)
where status = 'approved';

create index if not exists idx_payment_orders_user_id_created_at_desc
on public.payment_orders (user_id, created_at desc);

create index if not exists idx_payment_orders_user_id_summary
on public.payment_orders (user_id);

create index if not exists idx_payment_orders_user_scope_status_created_at
on public.payment_orders (user_id, scope_type, status, created_at desc);

create index if not exists idx_payment_orders_public_lookup
on public.payment_orders (order_public_id, cart_public_id);

create unique index if not exists idx_payment_orders_single_pending_draft_per_scope
on public.payment_orders (user_id, coalesce(guild_id, '__global__'), payment_method)
where status = 'pending'
  and provider_payment_id is null
  and payment_method in ('pix', 'card');

drop trigger if exists tr_payment_orders_updated_at on public.payment_orders;
create trigger tr_payment_orders_updated_at
before update on public.payment_orders
for each row
execute function public.set_updated_at();

create or replace function public.payment_orders_assign_public_identifiers()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is not null and (new.order_public_id is null or btrim(new.order_public_id) = '') then
    new.order_public_id := 'flw_' || public.base36_encode_bigint(new.order_number);
  end if;

  if new.id is not null and (new.cart_public_id is null or btrim(new.cart_public_id) = '') then
    new.cart_public_id := 'crt_' || public.base36_encode_bigint(new.id);
  end if;

  new.scope_type := case when new.guild_id is null then 'account' else 'guild' end;
  new.checkout_surface := coalesce(nullif(new.checkout_surface, ''), 'payment');
  new.checkout_origin := coalesce(
    nullif(new.checkout_origin, ''),
    nullif(new.provider_payload ->> 'source', ''),
    'flowdesk_checkout'
  );

  return new;
end;
$$;

drop trigger if exists tr_payment_orders_public_identifiers on public.payment_orders;
create trigger tr_payment_orders_public_identifiers
before insert or update on public.payment_orders
for each row
execute function public.payment_orders_assign_public_identifiers();

alter table public.payment_orders enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_orders'::regclass,
  'service_role_all_payment_orders'
);

create table if not exists public.payment_order_events (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  event_type text not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_order_events_order_created_at
on public.payment_order_events (payment_order_id, created_at desc);

create index if not exists idx_payment_order_events_order_id
on public.payment_order_events (payment_order_id);

alter table public.payment_order_events enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_order_events'::regclass,
  'service_role_all_payment_order_events'
);

create table if not exists public.payment_coupons (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  description text,
  status text not null default 'active'
    check (status in ('draft', 'active', 'inactive', 'expired')),
  discount_type text not null
    check (discount_type in ('fixed', 'percent')),
  discount_value numeric(10,2) not null
    check (discount_value > 0),
  max_redemptions integer
    check (max_redemptions is null or max_redemptions > 0),
  starts_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_coupons_code
on public.payment_coupons (code);

create index if not exists idx_payment_coupons_status
on public.payment_coupons (status, expires_at);

drop trigger if exists tr_payment_coupons_updated_at on public.payment_coupons;
create trigger tr_payment_coupons_updated_at
before update on public.payment_coupons
for each row
execute function public.set_updated_at();

alter table public.payment_coupons enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_coupons'::regclass,
  'service_role_all_payment_coupons'
);

create table if not exists public.payment_coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id bigint not null references public.payment_coupons(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  guild_id text,
  user_id bigint references public.auth_users(id) on delete set null,
  discount_amount numeric(10,2) not null default 0
    check (discount_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_coupon_redemptions_coupon
on public.payment_coupon_redemptions (coupon_id, created_at desc);

create unique index if not exists idx_payment_coupon_redemptions_coupon_order_unique
on public.payment_coupon_redemptions (coupon_id, payment_order_id)
where payment_order_id is not null;

alter table public.payment_coupon_redemptions enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_coupon_redemptions'::regclass,
  'service_role_all_payment_coupon_redemptions'
);

create table if not exists public.payment_gift_cards (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  description text,
  status text not null default 'active'
    check (status in ('draft', 'active', 'inactive', 'exhausted', 'expired')),
  initial_amount numeric(10,2) not null
    check (initial_amount >= 0),
  remaining_amount numeric(10,2) not null
    check (remaining_amount >= 0),
  currency text not null default 'BRL',
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_gift_cards_code
on public.payment_gift_cards (code);

create index if not exists idx_payment_gift_cards_status
on public.payment_gift_cards (status, expires_at);

drop trigger if exists tr_payment_gift_cards_updated_at on public.payment_gift_cards;
create trigger tr_payment_gift_cards_updated_at
before update on public.payment_gift_cards
for each row
execute function public.set_updated_at();

alter table public.payment_gift_cards enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_gift_cards'::regclass,
  'service_role_all_payment_gift_cards'
);

create table if not exists public.payment_gift_card_redemptions (
  id bigint generated always as identity primary key,
  gift_card_id bigint not null references public.payment_gift_cards(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  guild_id text,
  user_id bigint references public.auth_users(id) on delete set null,
  redeemed_amount numeric(10,2) not null default 0
    check (redeemed_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_gift_card_redemptions_card
on public.payment_gift_card_redemptions (gift_card_id, created_at desc);

create unique index if not exists idx_payment_gift_card_redemptions_gift_card_order_unique
on public.payment_gift_card_redemptions (gift_card_id, payment_order_id)
where payment_order_id is not null;

alter table public.payment_gift_card_redemptions enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_gift_card_redemptions'::regclass,
  'service_role_all_payment_gift_card_redemptions'
);

create table if not exists public.guild_plan_settings (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  plan_code text not null default 'pro'
    check (plan_code in ('basic', 'pro', 'ultra', 'master')),
  monthly_amount numeric(10,2) not null default 9.99
    check (monthly_amount >= 0),
  currency text not null default 'BRL',
  recurring_enabled boolean not null default false,
  recurring_method_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_plan_settings_unique_user_guild unique (user_id, guild_id)
);

create index if not exists idx_guild_plan_settings_user_guild
on public.guild_plan_settings (user_id, guild_id);

create index if not exists idx_guild_plan_settings_recurring_enabled
on public.guild_plan_settings (recurring_enabled);

drop trigger if exists tr_guild_plan_settings_updated_at on public.guild_plan_settings;
create trigger tr_guild_plan_settings_updated_at
before update on public.guild_plan_settings
for each row
execute function public.set_updated_at();

alter table public.guild_plan_settings enable row level security;
select public.ensure_service_role_all_policy(
  'public.guild_plan_settings'::regclass,
  'service_role_all_guild_plan_settings'
);

create table if not exists public.auth_user_hidden_payment_methods (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  method_id text not null,
  deleted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_hidden_payment_methods_unique unique (user_id, method_id)
);

create index if not exists idx_auth_user_hidden_payment_methods_user_id
on public.auth_user_hidden_payment_methods (user_id);

create index if not exists idx_auth_user_hidden_payment_methods_method_id
on public.auth_user_hidden_payment_methods (method_id);

drop trigger if exists tr_auth_user_hidden_payment_methods_updated_at on public.auth_user_hidden_payment_methods;
create trigger tr_auth_user_hidden_payment_methods_updated_at
before update on public.auth_user_hidden_payment_methods
for each row
execute function public.set_updated_at();

alter table public.auth_user_hidden_payment_methods enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_hidden_payment_methods'::regclass,
  'service_role_all_auth_user_hidden_payment_methods'
);

create table if not exists public.auth_user_payment_methods (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  method_id text not null,
  nickname text,
  brand text,
  first_six text not null
    check (first_six ~ '^[0-9]{6}$'),
  last_four text not null
    check (last_four ~ '^[0-9]{4}$'),
  exp_month smallint
    check (exp_month is null or exp_month between 1 and 12),
  exp_year smallint
    check (exp_year is null or exp_year between 0 and 9999),
  provider text not null default 'mercado_pago',
  provider_customer_id text,
  provider_card_id text,
  verification_status text not null default 'verified'
    check (verification_status in ('verified', 'pending', 'failed', 'cancelled')),
  verification_status_detail text,
  verification_amount numeric(10,2),
  verification_provider_payment_id text,
  verified_at timestamptz,
  last_context_guild_id text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_payment_methods_unique unique (user_id, method_id)
);

create index if not exists idx_auth_user_payment_methods_user_id
on public.auth_user_payment_methods (user_id);

create index if not exists idx_auth_user_payment_methods_is_active
on public.auth_user_payment_methods (is_active);

create index if not exists idx_auth_user_payment_methods_user_active
on public.auth_user_payment_methods (user_id, is_active);

create index if not exists idx_auth_user_payment_methods_method_id
on public.auth_user_payment_methods (method_id);

create index if not exists idx_auth_user_payment_methods_user_verification_status
on public.auth_user_payment_methods (user_id, verification_status);

create index if not exists idx_auth_user_payment_methods_last_context_guild_id
on public.auth_user_payment_methods (last_context_guild_id);

create index if not exists idx_auth_user_payment_methods_provider_customer_id
on public.auth_user_payment_methods (provider_customer_id)
where provider_customer_id is not null;

create unique index if not exists idx_auth_user_payment_methods_provider_card_id
on public.auth_user_payment_methods (provider_card_id)
where provider_card_id is not null;

create unique index if not exists idx_auth_user_payment_methods_verification_provider_payment_id
on public.auth_user_payment_methods (verification_provider_payment_id)
where verification_provider_payment_id is not null;

drop trigger if exists tr_auth_user_payment_methods_updated_at on public.auth_user_payment_methods;
create trigger tr_auth_user_payment_methods_updated_at
before update on public.auth_user_payment_methods
for each row
execute function public.set_updated_at();

alter table public.auth_user_payment_methods enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_payment_methods'::regclass,
  'service_role_all_auth_user_payment_methods'
);

create table if not exists public.auth_user_payment_method_verifications (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  method_id text not null,
  amount numeric(10,2) not null
    check (amount > 0),
  currency text not null default 'BRL',
  provider text not null default 'mercado_pago',
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'failed', 'cancelled')),
  payer_name text,
  payer_document text,
  payer_document_type text
    check (payer_document_type in ('CPF', 'CNPJ')),
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

alter table public.auth_user_payment_method_verifications enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_payment_method_verifications'::regclass,
  'service_role_all_auth_user_payment_method_verifications'
);

create table if not exists public.auth_user_plan_state (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  plan_code text not null default 'pro'
    check (plan_code in ('basic', 'pro', 'ultra', 'master')),
  plan_name text not null default 'Flow Pro',
  status text not null default 'inactive'
    check (status in ('inactive', 'trial', 'active', 'expired')),
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  compare_amount numeric(10,2) not null default 0
    check (compare_amount >= 0),
  currency text not null default 'BRL',
  billing_cycle_days integer not null default 30
    check (billing_cycle_days > 0),
  max_licensed_servers integer not null default 1
    check (max_licensed_servers > 0),
  max_active_tickets integer not null default 0
    check (max_active_tickets >= 0),
  max_automations integer not null default 0
    check (max_automations >= 0),
  max_monthly_actions integer not null default 0
    check (max_monthly_actions >= 0),
  last_payment_order_id bigint references public.payment_orders(id) on delete set null,
  last_payment_guild_id text,
  activated_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_auth_user_plan_state_status
on public.auth_user_plan_state (status, expires_at);

drop trigger if exists tr_auth_user_plan_state_updated_at on public.auth_user_plan_state;
create trigger tr_auth_user_plan_state_updated_at
before update on public.auth_user_plan_state
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_state enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_plan_state'::regclass,
  'service_role_all_auth_user_plan_state'
);

create table if not exists public.auth_user_plan_guilds (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  is_active boolean not null default true,
  deactivated_reason text,
  deactivated_at timestamptz,
  reactivated_at timestamptz,
  activated_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_guilds_unique_user_guild unique (user_id, guild_id),
  constraint auth_user_plan_guilds_unique_guild unique (guild_id)
);

create index if not exists idx_auth_user_plan_guilds_user_activated
on public.auth_user_plan_guilds (user_id, activated_at desc);

create index if not exists idx_auth_user_plan_guilds_guild
on public.auth_user_plan_guilds (guild_id);

create index if not exists idx_auth_user_plan_guilds_user_active
on public.auth_user_plan_guilds (user_id, is_active, activated_at desc);

drop trigger if exists tr_auth_user_plan_guilds_updated_at on public.auth_user_plan_guilds;
create trigger tr_auth_user_plan_guilds_updated_at
before update on public.auth_user_plan_guilds
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_guilds enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_plan_guilds'::regclass,
  'service_role_all_auth_user_plan_guilds'
);

create table if not exists public.auth_user_plan_flow_points (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  currency text not null default 'BRL',
  balance_amount numeric(12,2) not null default 0
    check (balance_amount >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_plan_flow_points_updated_at on public.auth_user_plan_flow_points;
create trigger tr_auth_user_plan_flow_points_updated_at
before update on public.auth_user_plan_flow_points
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_flow_points enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_plan_flow_points'::regclass,
  'service_role_all_auth_user_plan_flow_points'
);

create table if not exists public.auth_user_plan_flow_point_events (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  event_type text not null,
  amount numeric(12,2) not null,
  currency text not null default 'BRL',
  balance_after numeric(12,2) not null
    check (balance_after >= 0),
  reference_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_flow_point_events_reference_key
on public.auth_user_plan_flow_point_events (reference_key)
where reference_key is not null;

create index if not exists idx_auth_user_plan_flow_point_events_user_created_at
on public.auth_user_plan_flow_point_events (user_id, created_at desc);

create index if not exists idx_auth_user_plan_flow_point_events_payment_order_id
on public.auth_user_plan_flow_point_events (payment_order_id)
where payment_order_id is not null;

alter table public.auth_user_plan_flow_point_events enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_plan_flow_point_events'::regclass,
  'service_role_all_auth_user_plan_flow_point_events'
);

create or replace function public.apply_user_plan_flow_points_event(
  p_user_id bigint,
  p_event_type text,
  p_amount numeric,
  p_currency text default 'BRL',
  p_reference_key text default null,
  p_payment_order_id bigint default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(balance_amount numeric, applied_amount numeric, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_currency text;
  v_current_balance numeric(12,2);
  v_next_balance numeric(12,2);
  v_applied_amount numeric(12,2);
  v_existing_balance numeric(12,2);
begin
  v_currency := coalesce(nullif(trim(coalesce(p_currency, '')), ''), 'BRL');

  if p_reference_key is not null then
    select e.balance_after
      into v_existing_balance
      from public.auth_user_plan_flow_point_events e
     where e.reference_key = p_reference_key
     limit 1;

    if found then
      balance_amount := coalesce(v_existing_balance, 0);
      applied_amount := 0;
      applied := false;
      return next;
      return;
    end if;
  end if;

  insert into public.auth_user_plan_flow_points (
    user_id,
    currency,
    balance_amount
  )
  values (
    p_user_id,
    v_currency,
    0
  )
  on conflict (user_id) do nothing;

  select fp.balance_amount
    into v_current_balance
    from public.auth_user_plan_flow_points fp
   where fp.user_id = p_user_id
   for update;

  v_current_balance := coalesce(v_current_balance, 0);
  v_next_balance := round(greatest(0, v_current_balance + coalesce(p_amount, 0))::numeric, 2);
  v_applied_amount := round((v_next_balance - v_current_balance)::numeric, 2);

  update public.auth_user_plan_flow_points
     set currency = v_currency,
         balance_amount = v_next_balance
   where user_id = p_user_id;

  insert into public.auth_user_plan_flow_point_events (
    user_id,
    payment_order_id,
    event_type,
    amount,
    currency,
    balance_after,
    reference_key,
    metadata
  )
  values (
    p_user_id,
    p_payment_order_id,
    coalesce(nullif(trim(coalesce(p_event_type, '')), ''), 'flow_points_adjustment'),
    v_applied_amount,
    v_currency,
    v_next_balance,
    p_reference_key,
    coalesce(p_metadata, '{}'::jsonb)
  );

  balance_amount := v_next_balance;
  applied_amount := v_applied_amount;
  applied := true;
  return next;
end;
$$;

create table if not exists public.auth_user_plan_scheduled_changes (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text,
  current_plan_code text not null
    check (current_plan_code in ('basic', 'pro', 'ultra', 'master')),
  current_billing_cycle_days integer not null
    check (current_billing_cycle_days > 0),
  target_plan_code text not null
    check (target_plan_code in ('basic', 'pro', 'ultra', 'master')),
  target_billing_period_code text not null
    check (target_billing_period_code in ('monthly', 'quarterly', 'semiannual', 'annual')),
  target_billing_cycle_days integer not null
    check (target_billing_cycle_days > 0),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'applied', 'cancelled')),
  effective_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_scheduled_changes_active_user
on public.auth_user_plan_scheduled_changes (user_id)
where status = 'scheduled';

create index if not exists idx_auth_user_plan_scheduled_changes_user_status_effective_at
on public.auth_user_plan_scheduled_changes (user_id, status, effective_at);

drop trigger if exists tr_auth_user_plan_scheduled_changes_updated_at on public.auth_user_plan_scheduled_changes;
create trigger tr_auth_user_plan_scheduled_changes_updated_at
before update on public.auth_user_plan_scheduled_changes
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_scheduled_changes enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_plan_scheduled_changes'::regclass,
  'service_role_all_auth_user_plan_scheduled_changes'
);

create table if not exists public.auth_user_plan_downgrade_enforcements (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  scheduled_change_id bigint references public.auth_user_plan_scheduled_changes(id) on delete set null,
  target_plan_code text not null
    check (target_plan_code in ('basic', 'pro', 'ultra', 'master')),
  target_billing_period_code text not null
    check (target_billing_period_code in ('monthly', 'quarterly', 'semiannual', 'annual')),
  target_billing_cycle_days integer not null
    check (target_billing_cycle_days > 0),
  target_max_licensed_servers integer not null
    check (target_max_licensed_servers > 0),
  status text not null default 'selection_required'
    check (status in ('selection_required', 'awaiting_payment', 'resolved', 'cancelled')),
  effective_at timestamptz not null,
  selected_guild_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(selected_guild_ids) = 'array'),
  resolved_payment_order_id bigint references public.payment_orders(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_downgrade_enforcements_active_user
on public.auth_user_plan_downgrade_enforcements (user_id)
where status in ('selection_required', 'awaiting_payment');

create index if not exists idx_auth_user_plan_downgrade_enforcements_user_status
on public.auth_user_plan_downgrade_enforcements (user_id, status, effective_at desc);

drop trigger if exists tr_auth_user_plan_downgrade_enforcements_updated_at on public.auth_user_plan_downgrade_enforcements;
create trigger tr_auth_user_plan_downgrade_enforcements_updated_at
before update on public.auth_user_plan_downgrade_enforcements
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_downgrade_enforcements enable row level security;
select public.ensure_service_role_all_policy(
  'public.auth_user_plan_downgrade_enforcements'::regclass,
  'service_role_all_auth_user_plan_downgrade_enforcements'
);

create table if not exists public.payment_provider_event_inbox (
  id bigint generated always as identity primary key,
  provider text not null,
  event_key text not null,
  resource_type text,
  resource_id text,
  event_action text,
  status text not null default 'processing'
    check (status in ('processing', 'failed', 'completed', 'dead_letter')),
  attempt_count integer not null default 1
    check (attempt_count >= 0),
  max_attempts integer not null default 6
    check (max_attempts between 1 and 20),
  signature_verified boolean not null default false,
  request_id text,
  request_path text,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  last_error text,
  received_at timestamptz not null default timezone('utc', now()),
  last_received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_provider_event_inbox_provider_event_key_key unique (provider, event_key)
);

create index if not exists idx_payment_provider_event_inbox_status_retry
on public.payment_provider_event_inbox (status, next_retry_at, last_received_at desc);

create index if not exists idx_payment_provider_event_inbox_provider_resource
on public.payment_provider_event_inbox (provider, resource_type, resource_id, created_at desc)
where resource_id is not null;

drop trigger if exists tr_payment_provider_event_inbox_updated_at on public.payment_provider_event_inbox;
create trigger tr_payment_provider_event_inbox_updated_at
before update on public.payment_provider_event_inbox
for each row
execute function public.set_updated_at();

alter table public.payment_provider_event_inbox enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_provider_event_inbox'::regclass,
  'service_role_all_payment_provider_event_inbox'
);

create table if not exists public.payment_checkout_carts (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  order_number bigint not null,
  order_public_id text not null,
  cart_public_id text not null,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null
    check (scope_type in ('account', 'guild')),
  source text not null default 'flowdesk_checkout',
  checkout_surface text not null default 'payment',
  checkout_step integer
    check (checkout_step is null or checkout_step between 0 and 99),
  cart_status text not null default 'draft'
    check (cart_status in ('draft', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  plan_code text not null,
  plan_name text not null,
  billing_cycle_days integer not null
    check (billing_cycle_days > 0),
  currency text not null default 'BRL',
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  subtotal_amount numeric(10,2) not null default 0
    check (subtotal_amount >= 0),
  coupon_amount numeric(10,2) not null default 0
    check (coupon_amount >= 0),
  gift_card_amount numeric(10,2) not null default 0
    check (gift_card_amount >= 0),
  flow_points_amount numeric(10,2) not null default 0
    check (flow_points_amount >= 0),
  total_amount numeric(10,2) not null default 0
    check (total_amount >= 0),
  coupon_code text,
  gift_card_code text,
  payer_name text,
  payer_document_last4 text,
  payer_document_type text
    check (payer_document_type in ('CPF', 'CNPJ')),
  plan_snapshot jsonb not null default '{}'::jsonb,
  pricing_snapshot jsonb not null default '{}'::jsonb,
  transition_snapshot jsonb not null default '{}'::jsonb,
  provider_snapshot jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb not null default '{}'::jsonb,
  checkout_context jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  finalized_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_checkout_carts_payment_order_id_key unique (payment_order_id),
  constraint payment_checkout_carts_order_public_id_cart_public_id_key unique (order_public_id, cart_public_id)
);

create index if not exists idx_payment_checkout_carts_user_status_updated_at
on public.payment_checkout_carts (user_id, cart_status, updated_at desc);

create index if not exists idx_payment_checkout_carts_scope_status_updated_at
on public.payment_checkout_carts (scope_type, guild_id, cart_status, updated_at desc);

create index if not exists idx_payment_checkout_carts_public_lookup
on public.payment_checkout_carts (order_public_id, cart_public_id);

drop trigger if exists tr_payment_checkout_carts_updated_at on public.payment_checkout_carts;
create trigger tr_payment_checkout_carts_updated_at
before update on public.payment_checkout_carts
for each row
execute function public.set_updated_at();

alter table public.payment_checkout_carts enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_checkout_carts'::regclass,
  'service_role_all_payment_checkout_carts'
);

create table if not exists public.payment_order_state_history (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  order_number bigint not null,
  order_public_id text,
  cart_public_id text,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null
    check (scope_type in ('account', 'guild')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  status text not null
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  provider_status text,
  provider_status_detail text,
  provider_payment_id text,
  provider_external_reference text,
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  currency text not null default 'BRL',
  plan_code text,
  plan_name text,
  billing_cycle_days integer,
  snapshot_kind text not null
    check (snapshot_kind in ('insert', 'update', 'backfill')),
  snapshot_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_order_state_history_order_created_at
on public.payment_order_state_history (payment_order_id, created_at desc);

create index if not exists idx_payment_order_state_history_user_created_at
on public.payment_order_state_history (user_id, created_at desc);

create unique index if not exists idx_payment_order_state_history_backfill_unique
on public.payment_order_state_history (payment_order_id, snapshot_kind)
where snapshot_kind = 'backfill';

alter table public.payment_order_state_history enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_order_state_history'::regclass,
  'service_role_all_payment_order_state_history'
);

create or replace function public.refresh_payment_checkout_projection(
  p_order public.payment_orders,
  p_snapshot_kind text default 'update'
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_provider_payload jsonb := coalesce(p_order.provider_payload, '{}'::jsonb);
  v_pricing jsonb := case
    when jsonb_typeof(v_provider_payload -> 'pricing') = 'object'
      then v_provider_payload -> 'pricing'
    else '{}'::jsonb
  end;
  v_coupon jsonb := case
    when jsonb_typeof(v_pricing -> 'coupon') = 'object'
      then v_pricing -> 'coupon'
    else '{}'::jsonb
  end;
  v_gift_card jsonb := case
    when jsonb_typeof(v_pricing -> 'giftCard') = 'object'
      then v_pricing -> 'giftCard'
    else '{}'::jsonb
  end;
  v_flow_points jsonb := case
    when jsonb_typeof(v_pricing -> 'flowPoints') = 'object'
      then v_pricing -> 'flowPoints'
    else '{}'::jsonb
  end;
  v_transition jsonb := case
    when jsonb_typeof(v_provider_payload -> 'transition') = 'object'
      then v_provider_payload -> 'transition'
    else '{}'::jsonb
  end;
  v_plan jsonb := case
    when jsonb_typeof(v_provider_payload -> 'plan') = 'object'
      then v_provider_payload -> 'plan'
    else '{}'::jsonb
  end;
  v_scope_type text := case when p_order.guild_id is null then 'account' else 'guild' end;
  v_order_public_id text := coalesce(
    nullif(btrim(coalesce(p_order.order_public_id, '')), ''),
    'flw_' || public.base36_encode_bigint(p_order.order_number)
  );
  v_cart_public_id text := coalesce(
    nullif(btrim(coalesce(p_order.cart_public_id, '')), ''),
    'crt_' || public.base36_encode_bigint(p_order.id)
  );
  v_source text := coalesce(
    nullif(btrim(coalesce(v_provider_payload ->> 'source', '')), ''),
    nullif(btrim(coalesce(p_order.checkout_origin, '')), ''),
    'flowdesk_checkout'
  );
  v_checkout_surface text := coalesce(
    nullif(btrim(coalesce(p_order.checkout_surface, '')), ''),
    'payment'
  );
  v_checkout_step integer := case
    when coalesce(v_provider_payload ->> 'step', '') ~ '^\d+$'
      then (v_provider_payload ->> 'step')::integer
    else null
  end;
  v_plan_code text := coalesce(
    nullif(btrim(coalesce(v_plan ->> 'code', p_order.plan_code, '')), ''),
    'pro'
  );
  v_plan_name text := coalesce(
    nullif(btrim(coalesce(v_plan ->> 'name', p_order.plan_name, '')), ''),
    'Flow Pro'
  );
  v_billing_cycle_days integer := greatest(
    coalesce(
      public.payment_parse_numeric(v_plan ->> 'billingCycleDays', null)::integer,
      p_order.plan_billing_cycle_days,
      30
    ),
    1
  );
  v_coupon_amount numeric(10,2) := round(
    greatest(public.payment_parse_numeric(v_coupon ->> 'amount', 0), 0)::numeric,
    2
  );
  v_gift_card_amount numeric(10,2) := round(
    greatest(public.payment_parse_numeric(v_gift_card ->> 'amount', 0), 0)::numeric,
    2
  );
  v_flow_points_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_flow_points ->> 'appliedAmount', null),
        public.payment_parse_numeric(v_transition ->> 'flowPointsApplied', 0)
      ),
      0
    )::numeric,
    2
  );
  v_subtotal_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_pricing ->> 'subtotalAmount', null),
        public.payment_parse_numeric(v_pricing ->> 'baseAmount', null),
        p_order.amount,
        0
      ),
      0
    )::numeric,
    2
  );
  v_total_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_pricing ->> 'totalAmount', null),
        p_order.amount,
        0
      ),
      0
    )::numeric,
    2
  );
  v_cart_status text := case
    when p_order.status = 'pending'
      and p_order.provider_payment_id is null
      and public.payment_parse_boolean(v_provider_payload ->> 'precreated', false)
      then 'draft'
    else p_order.status
  end;
  v_payer_document_digits text := regexp_replace(coalesce(p_order.payer_document, ''), '\D', '', 'g');
  v_payer_document_last4 text := case
    when v_payer_document_digits <> '' then right(v_payer_document_digits, 4)
    else null
  end;
  v_plan_snapshot jsonb := case
    when v_plan <> '{}'::jsonb then v_plan
    else jsonb_strip_nulls(
      jsonb_build_object(
        'code', v_plan_code,
        'name', v_plan_name,
        'billingCycleDays', v_billing_cycle_days,
        'entitlements', jsonb_strip_nulls(
          jsonb_build_object(
            'maxLicensedServers', p_order.plan_max_licensed_servers,
            'maxActiveTickets', p_order.plan_max_active_tickets,
            'maxAutomations', p_order.plan_max_automations,
            'maxMonthlyActions', p_order.plan_max_monthly_actions
          )
        )
      )
    )
  end;
  v_provider_snapshot jsonb := jsonb_strip_nulls(
    jsonb_build_object(
      'provider', p_order.provider,
      'providerPaymentId', p_order.provider_payment_id,
      'externalReference', p_order.provider_external_reference,
      'status', p_order.provider_status,
      'statusDetail', p_order.provider_status_detail,
      'ticketUrl', p_order.provider_ticket_url,
      'mercadoPago', case
        when jsonb_typeof(v_provider_payload -> 'mercado_pago') = 'object'
          then v_provider_payload -> 'mercado_pago'
        else null
      end
    )
  );
  v_customer_snapshot jsonb := jsonb_strip_nulls(
    jsonb_build_object(
      'payerName', p_order.payer_name,
      'payerDocumentType', p_order.payer_document_type,
      'payerDocumentLast4', v_payer_document_last4
    )
  );
  v_now timestamptz := timezone('utc', now());
begin
  insert into public.payment_checkout_carts (
    payment_order_id,
    order_number,
    order_public_id,
    cart_public_id,
    user_id,
    guild_id,
    scope_type,
    source,
    checkout_surface,
    checkout_step,
    cart_status,
    payment_method,
    plan_code,
    plan_name,
    billing_cycle_days,
    currency,
    amount,
    subtotal_amount,
    coupon_amount,
    gift_card_amount,
    flow_points_amount,
    total_amount,
    coupon_code,
    gift_card_code,
    payer_name,
    payer_document_last4,
    payer_document_type,
    plan_snapshot,
    pricing_snapshot,
    transition_snapshot,
    provider_snapshot,
    customer_snapshot,
    checkout_context,
    opened_at,
    last_seen_at,
    finalized_at
  )
  values (
    p_order.id,
    p_order.order_number,
    v_order_public_id,
    v_cart_public_id,
    p_order.user_id,
    p_order.guild_id,
    v_scope_type,
    v_source,
    v_checkout_surface,
    v_checkout_step,
    v_cart_status,
    p_order.payment_method,
    v_plan_code,
    v_plan_name,
    v_billing_cycle_days,
    coalesce(nullif(btrim(coalesce(p_order.currency, '')), ''), 'BRL'),
    round(greatest(coalesce(p_order.amount, 0), 0)::numeric, 2),
    v_subtotal_amount,
    v_coupon_amount,
    v_gift_card_amount,
    v_flow_points_amount,
    v_total_amount,
    nullif(btrim(coalesce(v_coupon ->> 'code', '')), ''),
    nullif(btrim(coalesce(v_gift_card ->> 'code', '')), ''),
    p_order.payer_name,
    v_payer_document_last4,
    p_order.payer_document_type,
    coalesce(v_plan_snapshot, '{}'::jsonb),
    coalesce(v_pricing, '{}'::jsonb),
    coalesce(v_transition, '{}'::jsonb),
    coalesce(v_provider_snapshot, '{}'::jsonb),
    coalesce(v_customer_snapshot, '{}'::jsonb),
    coalesce(v_provider_payload, '{}'::jsonb),
    coalesce(p_order.created_at, v_now),
    v_now,
    case
      when v_cart_status in ('approved', 'rejected', 'cancelled', 'expired', 'failed')
        then coalesce(p_order.paid_at, p_order.updated_at, v_now)
      else null
    end
  )
  on conflict (payment_order_id) do update
  set
    order_number = excluded.order_number,
    order_public_id = excluded.order_public_id,
    cart_public_id = excluded.cart_public_id,
    user_id = excluded.user_id,
    guild_id = excluded.guild_id,
    scope_type = excluded.scope_type,
    source = excluded.source,
    checkout_surface = excluded.checkout_surface,
    checkout_step = excluded.checkout_step,
    cart_status = excluded.cart_status,
    payment_method = excluded.payment_method,
    plan_code = excluded.plan_code,
    plan_name = excluded.plan_name,
    billing_cycle_days = excluded.billing_cycle_days,
    currency = excluded.currency,
    amount = excluded.amount,
    subtotal_amount = excluded.subtotal_amount,
    coupon_amount = excluded.coupon_amount,
    gift_card_amount = excluded.gift_card_amount,
    flow_points_amount = excluded.flow_points_amount,
    total_amount = excluded.total_amount,
    coupon_code = excluded.coupon_code,
    gift_card_code = excluded.gift_card_code,
    payer_name = excluded.payer_name,
    payer_document_last4 = excluded.payer_document_last4,
    payer_document_type = excluded.payer_document_type,
    plan_snapshot = excluded.plan_snapshot,
    pricing_snapshot = excluded.pricing_snapshot,
    transition_snapshot = excluded.transition_snapshot,
    provider_snapshot = excluded.provider_snapshot,
    customer_snapshot = excluded.customer_snapshot,
    checkout_context = excluded.checkout_context,
    last_seen_at = excluded.last_seen_at,
    finalized_at = case
      when excluded.cart_status in ('approved', 'rejected', 'cancelled', 'expired', 'failed')
        then coalesce(public.payment_checkout_carts.finalized_at, excluded.finalized_at)
      else null
    end;

  if p_snapshot_kind is not null then
    if p_snapshot_kind <> 'backfill'
       or not exists (
         select 1
         from public.payment_order_state_history h
         where h.payment_order_id = p_order.id
           and h.snapshot_kind = 'backfill'
       ) then
      insert into public.payment_order_state_history (
        payment_order_id,
        order_number,
        order_public_id,
        cart_public_id,
        user_id,
        guild_id,
        scope_type,
        payment_method,
        status,
        provider_status,
        provider_status_detail,
        provider_payment_id,
        provider_external_reference,
        amount,
        currency,
        plan_code,
        plan_name,
        billing_cycle_days,
        snapshot_kind,
        snapshot_payload
      )
      values (
        p_order.id,
        p_order.order_number,
        v_order_public_id,
        v_cart_public_id,
        p_order.user_id,
        p_order.guild_id,
        v_scope_type,
        p_order.payment_method,
        p_order.status,
        p_order.provider_status,
        p_order.provider_status_detail,
        p_order.provider_payment_id,
        p_order.provider_external_reference,
        round(greatest(coalesce(p_order.amount, 0), 0)::numeric, 2),
        coalesce(nullif(btrim(coalesce(p_order.currency, '')), ''), 'BRL'),
        v_plan_code,
        v_plan_name,
        v_billing_cycle_days,
        p_snapshot_kind,
        jsonb_strip_nulls(
          jsonb_build_object(
            'checkoutSurface', v_checkout_surface,
            'checkoutOrigin', v_source,
            'plan', v_plan_snapshot,
            'pricing', v_pricing,
            'transition', v_transition,
            'customer', v_customer_snapshot,
            'provider', v_provider_snapshot,
            'providerPayload', v_provider_payload,
            'paidAt', p_order.paid_at,
            'expiresAt', p_order.expires_at
          )
        )
      );
    end if;
  end if;
end;
$$;

create or replace function public.tr_payment_orders_checkout_projection()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.guild_id is not distinct from old.guild_id
       and new.payment_method is not distinct from old.payment_method
       and new.status is not distinct from old.status
       and new.amount is not distinct from old.amount
       and new.currency is not distinct from old.currency
       and new.payer_name is not distinct from old.payer_name
       and new.payer_document is not distinct from old.payer_document
       and new.payer_document_type is not distinct from old.payer_document_type
       and new.provider is not distinct from old.provider
       and new.provider_payment_id is not distinct from old.provider_payment_id
       and new.provider_external_reference is not distinct from old.provider_external_reference
       and new.provider_qr_code is not distinct from old.provider_qr_code
       and new.provider_qr_base64 is not distinct from old.provider_qr_base64
       and new.provider_ticket_url is not distinct from old.provider_ticket_url
       and new.provider_status is not distinct from old.provider_status
       and new.provider_status_detail is not distinct from old.provider_status_detail
       and new.provider_payload is not distinct from old.provider_payload
       and new.plan_code is not distinct from old.plan_code
       and new.plan_name is not distinct from old.plan_name
       and new.plan_billing_cycle_days is not distinct from old.plan_billing_cycle_days
       and new.plan_max_licensed_servers is not distinct from old.plan_max_licensed_servers
       and new.plan_max_active_tickets is not distinct from old.plan_max_active_tickets
       and new.plan_max_automations is not distinct from old.plan_max_automations
       and new.plan_max_monthly_actions is not distinct from old.plan_max_monthly_actions
       and new.order_public_id is not distinct from old.order_public_id
       and new.cart_public_id is not distinct from old.cart_public_id
       and new.scope_type is not distinct from old.scope_type
       and new.checkout_surface is not distinct from old.checkout_surface
       and new.checkout_origin is not distinct from old.checkout_origin
       and new.paid_at is not distinct from old.paid_at
       and new.expires_at is not distinct from old.expires_at then
      return new;
    end if;
  end if;

  perform public.refresh_payment_checkout_projection(new, lower(tg_op));
  return new;
end;
$$;

drop trigger if exists tr_payment_orders_checkout_projection on public.payment_orders;
create trigger tr_payment_orders_checkout_projection
after insert or update on public.payment_orders
for each row
execute function public.tr_payment_orders_checkout_projection();

create or replace view public.payment_checkout_portable_orders_v1 as
select
  po.id as payment_order_id,
  po.order_number,
  po.order_public_id,
  po.cart_public_id,
  po.user_id,
  po.guild_id,
  po.scope_type,
  po.checkout_surface,
  po.checkout_origin,
  po.payment_method,
  po.status,
  po.amount,
  po.currency,
  po.plan_code,
  po.plan_name,
  po.plan_billing_cycle_days,
  po.provider,
  po.provider_payment_id,
  po.provider_external_reference,
  po.provider_status,
  po.provider_status_detail,
  po.paid_at,
  po.expires_at,
  po.created_at,
  po.updated_at,
  pc.cart_status,
  pc.subtotal_amount,
  pc.coupon_amount,
  pc.gift_card_amount,
  pc.flow_points_amount,
  (pc.coupon_amount + pc.gift_card_amount + pc.flow_points_amount) as discount_total_amount,
  pc.total_amount,
  pc.coupon_code,
  pc.gift_card_code,
  pc.plan_snapshot,
  pc.pricing_snapshot,
  pc.transition_snapshot,
  pc.provider_snapshot,
  pc.customer_snapshot,
  pc.checkout_context,
  pc.finalized_at
from public.payment_orders po
left join public.payment_checkout_carts pc
  on pc.payment_order_id = po.id;

with ranked_pending_drafts as (
  select
    id,
    row_number() over (
      partition by user_id, coalesce(guild_id, '__global__'), payment_method
      order by created_at desc, id desc
    ) as rn
  from public.payment_orders
  where status = 'pending'
    and provider_payment_id is null
    and payment_method in ('pix', 'card')
)
update public.payment_orders po
set
  status = 'cancelled',
  provider_status = coalesce(po.provider_status, 'cancelled'),
  provider_status_detail = 'superseded_pending_draft_guard',
  provider_payload = coalesce(po.provider_payload, '{}'::jsonb) || jsonb_build_object(
    'duplicate_guard',
    jsonb_build_object(
      'reason', 'superseded_pending_draft_guard',
      'cancelled_at', timezone('utc', now())
    )
  ),
  updated_at = timezone('utc', now())
from ranked_pending_drafts ranked
where po.id = ranked.id
  and ranked.rn > 1;

select public.refresh_payment_checkout_projection(po, 'backfill')
from public.payment_orders po;

commit;
