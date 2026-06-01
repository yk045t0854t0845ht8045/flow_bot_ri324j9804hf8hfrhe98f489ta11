begin;

create table if not exists public.hosting_vps_flow_ai_daily_usage (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  usage_date date not null default (timezone('utc', now())::date),
  tokens_used integer not null default 0,
  request_count integer not null default 0,
  blocked_until timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, usage_date)
);

create index if not exists idx_hosting_vps_flow_ai_daily_usage_user_date
on public.hosting_vps_flow_ai_daily_usage (user_id, usage_date desc);

drop trigger if exists tr_hosting_vps_flow_ai_daily_usage_updated_at on public.hosting_vps_flow_ai_daily_usage;
create trigger tr_hosting_vps_flow_ai_daily_usage_updated_at
before update on public.hosting_vps_flow_ai_daily_usage
for each row execute function public.set_updated_at();

alter table public.hosting_vps_flow_ai_daily_usage enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_vps_flow_ai_daily_usage_service_role_all on public.hosting_vps_flow_ai_daily_usage;
    create policy hosting_vps_flow_ai_daily_usage_service_role_all
      on public.hosting_vps_flow_ai_daily_usage for all to service_role
      using (true) with check (true);
  end if;
end
$$;

commit;
