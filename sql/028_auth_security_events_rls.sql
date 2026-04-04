alter table public.auth_security_events enable row level security;

drop policy if exists "service_role_all_auth_security_events" on public.auth_security_events;
create policy "service_role_all_auth_security_events"
on public.auth_security_events
for all
to service_role
using (true)
with check (true);
