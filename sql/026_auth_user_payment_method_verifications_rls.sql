alter table public.auth_user_payment_method_verifications enable row level security;

drop policy if exists "service_role_all_auth_user_payment_method_verifications" on public.auth_user_payment_method_verifications;
create policy "service_role_all_auth_user_payment_method_verifications"
on public.auth_user_payment_method_verifications
for all
to service_role
using (true)
with check (true);
