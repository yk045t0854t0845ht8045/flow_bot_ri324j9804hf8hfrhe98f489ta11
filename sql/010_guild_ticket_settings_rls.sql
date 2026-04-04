alter table public.guild_ticket_settings enable row level security;

drop policy if exists "service_role_all_guild_ticket_settings" on public.guild_ticket_settings;
create policy "service_role_all_guild_ticket_settings"
on public.guild_ticket_settings
for all
to service_role
using (true)
with check (true);
