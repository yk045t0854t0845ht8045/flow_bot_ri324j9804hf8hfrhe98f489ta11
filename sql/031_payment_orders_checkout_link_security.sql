alter table public.payment_orders
add column if not exists checkout_link_nonce text,
add column if not exists checkout_link_expires_at timestamptz,
add column if not exists checkout_link_invalidated_at timestamptz;

create index if not exists idx_payment_orders_checkout_link_expires_at
on public.payment_orders (checkout_link_expires_at)
where checkout_link_expires_at is not null;

create index if not exists idx_payment_orders_checkout_link_invalidated_at
on public.payment_orders (checkout_link_invalidated_at)
where checkout_link_invalidated_at is not null;

create index if not exists idx_payment_orders_user_guild_checkout_link
on public.payment_orders (user_id, guild_id, updated_at desc);
