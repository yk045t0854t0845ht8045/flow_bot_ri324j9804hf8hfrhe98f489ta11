create table if not exists public.payment_coupons (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  description text,
  status text not null default 'active' check (status in ('draft', 'active', 'inactive', 'expired')),
  discount_type text not null check (discount_type in ('fixed', 'percent')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
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

create table if not exists public.payment_coupon_redemptions (
  id bigint generated always as identity primary key,
  coupon_id bigint not null references public.payment_coupons(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  guild_id text,
  user_id bigint references public.auth_users(id) on delete set null,
  discount_amount numeric(10,2) not null default 0 check (discount_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_coupon_redemptions_coupon
on public.payment_coupon_redemptions (coupon_id, created_at desc);

create table if not exists public.payment_gift_cards (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  description text,
  status text not null default 'active' check (status in ('draft', 'active', 'inactive', 'exhausted', 'expired')),
  initial_amount numeric(10,2) not null check (initial_amount >= 0),
  remaining_amount numeric(10,2) not null check (remaining_amount >= 0),
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

create table if not exists public.payment_gift_card_redemptions (
  id bigint generated always as identity primary key,
  gift_card_id bigint not null references public.payment_gift_cards(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  guild_id text,
  user_id bigint references public.auth_users(id) on delete set null,
  redeemed_amount numeric(10,2) not null default 0 check (redeemed_amount >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_gift_card_redemptions_card
on public.payment_gift_card_redemptions (gift_card_id, created_at desc);

alter table public.payment_coupons enable row level security;
alter table public.payment_coupon_redemptions enable row level security;
alter table public.payment_gift_cards enable row level security;
alter table public.payment_gift_card_redemptions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_payment_coupons" on public.payment_coupons';
    execute 'create policy "service_role_all_payment_coupons" on public.payment_coupons for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_coupon_redemptions" on public.payment_coupon_redemptions';
    execute 'create policy "service_role_all_payment_coupon_redemptions" on public.payment_coupon_redemptions for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_gift_cards" on public.payment_gift_cards';
    execute 'create policy "service_role_all_payment_gift_cards" on public.payment_gift_cards for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_gift_card_redemptions" on public.payment_gift_card_redemptions';
    execute 'create policy "service_role_all_payment_gift_card_redemptions" on public.payment_gift_card_redemptions for all to service_role using (true) with check (true)';
  end if;
end
$$;
