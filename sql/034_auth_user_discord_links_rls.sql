alter table public.auth_user_discord_links enable row level security;

drop policy if exists "service_role_all_auth_user_discord_links" on public.auth_user_discord_links;
create policy "service_role_all_auth_user_discord_links"
on public.auth_user_discord_links
for all
to service_role
using (true)
with check (true);
