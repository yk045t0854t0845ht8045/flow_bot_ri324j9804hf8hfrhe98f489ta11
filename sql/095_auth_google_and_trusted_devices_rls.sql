alter table public.auth_user_trusted_devices enable row level security;

drop policy if exists "service_role_all_auth_user_trusted_devices" on public.auth_user_trusted_devices;
create policy "service_role_all_auth_user_trusted_devices"
on public.auth_user_trusted_devices
for all
to service_role
using (true)
with check (true);
