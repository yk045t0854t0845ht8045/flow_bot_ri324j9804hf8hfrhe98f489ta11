alter table public.auth_users enable row level security;
alter table public.auth_sessions enable row level security;

drop policy if exists "service_role_all_auth_users" on public.auth_users;
create policy "service_role_all_auth_users"
on public.auth_users
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_sessions" on public.auth_sessions;
create policy "service_role_all_auth_sessions"
on public.auth_sessions
for all
to service_role
using (true)
with check (true);
