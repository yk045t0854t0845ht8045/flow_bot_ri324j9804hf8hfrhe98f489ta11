alter table public.auth_user_favorite_guilds enable row level security;

drop policy if exists "service_role_all_auth_user_favorite_guilds" on public.auth_user_favorite_guilds;
create policy "service_role_all_auth_user_favorite_guilds"
on public.auth_user_favorite_guilds
for all
to service_role
using (true)
with check (true);
