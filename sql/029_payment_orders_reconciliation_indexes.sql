create index if not exists idx_payment_orders_provider_payment_id
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create index if not exists idx_payment_orders_reconcile_status_updated_at
on public.payment_orders (status, updated_at desc)
where provider_payment_id is not null
  and status in ('pending', 'failed', 'expired', 'rejected');
