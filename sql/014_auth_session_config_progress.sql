alter table public.auth_sessions
add column if not exists config_current_step smallint not null default 1,
add column if not exists config_draft jsonb not null default '{}'::jsonb,
add column if not exists config_context_updated_at timestamptz not null default timezone('utc', now());

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'auth_sessions_config_current_step_check'
      and conrelid = 'public.auth_sessions'::regclass
  ) then
    alter table public.auth_sessions
    add constraint auth_sessions_config_current_step_check
    check (config_current_step between 1 and 4);
  end if;
end $$;

create index if not exists idx_auth_sessions_config_current_step
on public.auth_sessions (config_current_step);

create index if not exists idx_auth_sessions_config_context_updated_at
on public.auth_sessions (config_context_updated_at);
