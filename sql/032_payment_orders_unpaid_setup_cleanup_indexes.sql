create index if not exists idx_payment_orders_unpaid_setup_user_status_created_at
on public.payment_orders (user_id, status, created_at desc)
where status in ('pending', 'failed', 'rejected', 'cancelled', 'expired');

create index if not exists idx_payment_orders_unpaid_setup_guild_status_created_at
on public.payment_orders (guild_id, status, created_at desc)
where status in ('pending', 'failed', 'rejected', 'cancelled', 'expired');
