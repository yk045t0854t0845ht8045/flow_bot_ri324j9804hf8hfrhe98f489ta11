alter table public.auth_user_payment_method_verifications enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_payment_method_verifications" on public.auth_user_payment_method_verifications';
    execute 'create policy "service_role_all_auth_user_payment_method_verifications" on public.auth_user_payment_method_verifications for all to service_role using (true) with check (true)';
  end if;
end
$$;
