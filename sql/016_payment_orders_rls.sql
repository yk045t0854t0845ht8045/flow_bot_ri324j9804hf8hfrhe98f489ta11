alter table public.payment_orders enable row level security;
alter table public.payment_order_events enable row level security;

drop policy if exists "service_role_all_payment_orders" on public.payment_orders;
create policy "service_role_all_payment_orders"
on public.payment_orders
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_payment_order_events" on public.payment_order_events;
create policy "service_role_all_payment_order_events"
on public.payment_order_events
for all
to service_role
using (true)
with check (true);
