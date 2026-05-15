-- Coupons, gift cards and promotions for Discord sales checkout.
-- Safe to run more than once.

alter table public.guild_sales_carts
add column if not exists discount_id uuid null,
add column if not exists discount_code text not null default '',
add column if not exists discount_kind text not null default '',
add column if not exists discount_amount numeric(12,2) not null default 0,
add column if not exists discount_snapshot jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'guild_sales_carts_discount_amount_check'
  ) then
    alter table public.guild_sales_carts
      add constraint guild_sales_carts_discount_amount_check
      check (discount_amount >= 0 and total_amount >= 0 and subtotal_amount >= 0);
  end if;
end
$$;

create table if not exists public.guild_sales_discounts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  kind text not null default 'coupon',
  code text not null,
  title text not null,
  description text not null default '',
  status text not null default 'active',
  discount_type text not null default 'percent',
  discount_value numeric(12,2) not null default 0,
  initial_amount numeric(12,2) not null default 0,
  remaining_amount numeric(12,2) not null default 0,
  minimum_order_amount numeric(12,2) not null default 0,
  applies_to_all_products boolean not null default true,
  product_ids uuid[] not null default '{}',
  max_redemptions integer null,
  one_per_customer boolean not null default true,
  starts_at timestamptz null,
  expires_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_discounts_unique_code unique (guild_id, code),
  constraint guild_sales_discounts_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_discounts_kind_check
    check (kind in ('coupon', 'gift_card', 'promotion')),
  constraint guild_sales_discounts_code_check
    check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,63}$'),
  constraint guild_sales_discounts_status_check
    check (status in ('draft', 'active', 'paused', 'expired')),
  constraint guild_sales_discounts_type_check
    check (discount_type in ('fixed', 'percent')),
  constraint guild_sales_discounts_value_check
    check (
      discount_value >= 0
      and initial_amount >= 0
      and remaining_amount >= 0
      and minimum_order_amount >= 0
      and (max_redemptions is null or max_redemptions > 0)
    )
);

create index if not exists idx_guild_sales_discounts_guild_status
on public.guild_sales_discounts (guild_id, status, kind, created_at desc);

create index if not exists idx_guild_sales_discounts_product_ids
on public.guild_sales_discounts using gin (product_ids);

drop trigger if exists tr_guild_sales_discounts_updated_at on public.guild_sales_discounts;
create trigger tr_guild_sales_discounts_updated_at
before update on public.guild_sales_discounts
for each row
execute function public.set_updated_at();

alter table public.guild_sales_discounts enable row level security;

drop policy if exists "service_role_all_guild_sales_discounts" on public.guild_sales_discounts;
create policy "service_role_all_guild_sales_discounts"
on public.guild_sales_discounts
for all
to service_role
using (true)
with check (true);

create table if not exists public.guild_sales_discount_redemptions (
  id uuid primary key default gen_random_uuid(),
  discount_id uuid not null references public.guild_sales_discounts(id) on delete cascade,
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  discord_user_id text not null,
  discount_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_discount_redemptions_unique_cart unique (discount_id, cart_id),
  constraint guild_sales_discount_redemptions_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_discount_redemptions_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_discount_redemptions_amount_check
    check (discount_amount >= 0)
);

create index if not exists idx_guild_sales_discount_redemptions_discount
on public.guild_sales_discount_redemptions (discount_id, created_at desc);

create index if not exists idx_guild_sales_discount_redemptions_user
on public.guild_sales_discount_redemptions (guild_id, auth_user_id, discount_id)
where auth_user_id is not null;

alter table public.guild_sales_discount_redemptions enable row level security;

drop policy if exists "service_role_all_guild_sales_discount_redemptions" on public.guild_sales_discount_redemptions;
create policy "service_role_all_guild_sales_discount_redemptions"
on public.guild_sales_discount_redemptions
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_discounts is 'Cupons, gift cards e promocoes aplicaveis ao checkout de vendas Discord por servidor.';
comment on table public.guild_sales_discount_redemptions is 'Resgates efetivados apos pagamento aprovado para auditar uso e consumir saldo de gift cards.';
