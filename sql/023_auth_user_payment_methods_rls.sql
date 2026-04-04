alter table public.auth_user_payment_methods enable row level security;

drop policy if exists "service_role_all_auth_user_payment_methods" on public.auth_user_payment_methods;
create policy "service_role_all_auth_user_payment_methods"
on public.auth_user_payment_methods
for all
to service_role
using (true)
with check (true);

