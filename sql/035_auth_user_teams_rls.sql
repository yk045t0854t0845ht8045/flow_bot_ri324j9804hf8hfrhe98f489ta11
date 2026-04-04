alter table public.auth_user_teams enable row level security;
alter table public.auth_user_team_servers enable row level security;
alter table public.auth_user_team_members enable row level security;

drop policy if exists "service_role_all_auth_user_teams" on public.auth_user_teams;
create policy "service_role_all_auth_user_teams"
on public.auth_user_teams
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_team_servers" on public.auth_user_team_servers;
create policy "service_role_all_auth_user_team_servers"
on public.auth_user_team_servers
for all
to service_role
using (true)
with check (true);

drop policy if exists "service_role_all_auth_user_team_members" on public.auth_user_team_members;
create policy "service_role_all_auth_user_team_members"
on public.auth_user_team_members
for all
to service_role
using (true)
with check (true);
