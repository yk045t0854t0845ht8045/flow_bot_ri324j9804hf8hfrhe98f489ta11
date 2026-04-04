alter table public.ticket_ai_sessions enable row level security;
alter table public.ticket_ai_messages enable row level security;

drop policy if exists "service_role_all_ticket_ai_sessions" on public.ticket_ai_sessions;
create policy "service_role_all_ticket_ai_sessions"
on public.ticket_ai_sessions
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_ticket_ai_messages" on public.ticket_ai_messages;
create policy "service_role_all_ticket_ai_messages"
on public.ticket_ai_messages
for all
to service_role
using (true)
with check (true);
