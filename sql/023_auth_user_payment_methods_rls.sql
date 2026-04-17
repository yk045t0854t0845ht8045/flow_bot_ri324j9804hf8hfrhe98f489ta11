alter table public.auth_user_payment_methods enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_payment_methods" on public.auth_user_payment_methods';
    execute 'create policy "service_role_all_auth_user_payment_methods" on public.auth_user_payment_methods for all to service_role using (true) with check (true)';
  end if;
end
$$;
