alter table public.guild_security_logs_settings enable row level security;

drop policy if exists "service_role_all_guild_security_logs_settings" on public.guild_security_logs_settings;
create policy "service_role_all_guild_security_logs_settings"
on public.guild_security_logs_settings
for all
to service_role
using (true)
with check (true);
