alter table public.payment_orders enable row level security;
alter table public.payment_order_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_payment_orders" on public.payment_orders';
    execute 'create policy "service_role_all_payment_orders" on public.payment_orders for all to service_role using (true) with check (true)';
    execute 'drop policy if exists "service_role_all_payment_order_events" on public.payment_order_events';
    execute 'create policy "service_role_all_payment_order_events" on public.payment_order_events for all to service_role using (true) with check (true)';
  end if;
end
$$;
