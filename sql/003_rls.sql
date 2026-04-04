alter table public.tickets enable row level security;
alter table public.ticket_events enable row level security;

drop policy if exists "service_role_all_tickets" on public.tickets;
create policy "service_role_all_tickets"
on public.tickets
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_ticket_events" on public.ticket_events;
create policy "service_role_all_ticket_events"
on public.ticket_events
for all
to service_role
using (true)
with check (true);
