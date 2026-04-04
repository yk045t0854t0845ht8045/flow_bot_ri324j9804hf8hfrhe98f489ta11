alter table public.guild_welcome_settings enable row level security;

drop policy if exists "service_role_all_guild_welcome_settings" on public.guild_welcome_settings;
create policy "service_role_all_guild_welcome_settings"
on public.guild_welcome_settings
for all
to service_role
using (true)
with check (true);
