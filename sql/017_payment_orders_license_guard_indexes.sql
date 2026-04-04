create index if not exists idx_payment_orders_guild_status_paid_at
on public.payment_orders (guild_id, status, paid_at desc);

create index if not exists idx_payment_orders_guild_status_created_at
on public.payment_orders (guild_id, status, created_at desc);
