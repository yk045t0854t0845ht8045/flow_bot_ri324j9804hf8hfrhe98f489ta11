alter table public.ticket_ai_suggestion_sessions enable row level security;

drop policy if exists "service_role_all_ticket_ai_suggestion_sessions" on public.ticket_ai_suggestion_sessions;
create policy "service_role_all_ticket_ai_suggestion_sessions"
on public.ticket_ai_suggestion_sessions
for all
to service_role
using (true)
with check (true);
