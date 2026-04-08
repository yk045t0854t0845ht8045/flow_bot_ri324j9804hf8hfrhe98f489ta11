alter table public.guild_antilink_settings enable row level security;

drop policy if exists "service_role_all_guild_antilink_settings" on public.guild_antilink_settings;
create policy "service_role_all_guild_antilink_settings"
on public.guild_antilink_settings
for all
to service_role
using (true)
with check (true);
