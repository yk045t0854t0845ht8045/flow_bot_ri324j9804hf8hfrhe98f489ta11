alter table public.auth_user_credentials enable row level security;

drop policy if exists "service_role_all_auth_user_credentials" on public.auth_user_credentials;
create policy "service_role_all_auth_user_credentials"
on public.auth_user_credentials
for all
to service_role
using (true)
with check (true);

alter table public.auth_email_otp_challenges enable row level security;

drop policy if exists "service_role_all_auth_email_otp_challenges" on public.auth_email_otp_challenges;
create policy "service_role_all_auth_email_otp_challenges"
on public.auth_email_otp_challenges
for all
to service_role
using (true)
with check (true);
