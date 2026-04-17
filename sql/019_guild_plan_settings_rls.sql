alter table public.guild_plan_settings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_guild_plan_settings" on public.guild_plan_settings';
    execute 'create policy "service_role_all_guild_plan_settings" on public.guild_plan_settings for all to service_role using (true) with check (true)';
  end if;
end
$$;
