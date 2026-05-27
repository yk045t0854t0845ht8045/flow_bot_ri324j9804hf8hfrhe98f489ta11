begin;

create table if not exists public.hosting_projects (
  id bigint generated always as identity primary key,
  vps_code uuid not null default gen_random_uuid(),
  user_id bigint not null references public.auth_users(id) on delete restrict,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  hosting_kind text not null check (hosting_kind in ('site', 'bot', 'cdn')),
  hosting_plan_id text not null,
  hosting_region_id text not null,
  github_owner text not null,
  github_repo text not null,
  github_repo_id text,
  github_branch text not null default 'main',
  status text not null default 'pending_provision'
    check (status in ('pending_payment', 'pending_provision', 'provisioning', 'active', 'failed', 'suspended', 'cancelled')),
  windows_runtime text not null default 'windows-vps',
  provisioning_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_hosting_projects_vps_code_unique
on public.hosting_projects (vps_code);

create unique index if not exists idx_hosting_projects_payment_order_unique
on public.hosting_projects (payment_order_id)
where payment_order_id is not null;

create index if not exists idx_hosting_projects_user_created_at
on public.hosting_projects (user_id, created_at desc);

create index if not exists idx_hosting_projects_status_created_at
on public.hosting_projects (status, created_at desc);

drop trigger if exists tr_hosting_projects_updated_at on public.hosting_projects;
create trigger tr_hosting_projects_updated_at
before update on public.hosting_projects
for each row execute function public.set_updated_at();

alter table public.hosting_projects enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    drop policy if exists hosting_projects_service_role_all on public.hosting_projects;
    create policy hosting_projects_service_role_all
      on public.hosting_projects
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end
$$;

commit;
