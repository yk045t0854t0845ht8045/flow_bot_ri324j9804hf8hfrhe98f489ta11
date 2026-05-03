-- Runtime compatibility fixes for admin dashboard.
-- Safe to run more than once.

do $$
begin
  if to_regclass('public.tickets') is not null then
    alter table public.tickets
      add column if not exists opened_reason text not null default '';
  else
    raise notice 'Skipping missing table: public.tickets';
  end if;

  if to_regclass('public.admin_sessions') is not null then
    create unique index if not exists admin_sessions_auth_session_id_key
      on public.admin_sessions (auth_session_id);
  else
    raise notice 'Skipping missing table: public.admin_sessions';
  end if;
end
$$;
