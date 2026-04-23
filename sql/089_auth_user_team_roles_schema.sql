create table if not exists public.auth_user_team_roles (
  id bigint generated always as identity primary key,
  team_id bigint not null references public.auth_user_teams(id) on delete cascade,
  name text not null,
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (team_id, name),
  constraint auth_user_team_roles_permissions_array_check
    check (jsonb_typeof(permissions) = 'array')
);

create index if not exists idx_auth_user_team_roles_team_id
on public.auth_user_team_roles (team_id);

drop trigger if exists tr_auth_user_team_roles_updated_at on public.auth_user_team_roles;
create trigger tr_auth_user_team_roles_updated_at
before update on public.auth_user_team_roles
for each row
execute function public.set_updated_at();

alter table public.auth_user_team_members
  add column if not exists role_id bigint references public.auth_user_team_roles(id) on delete set null;

alter table public.auth_user_team_members
  add column if not exists custom_permissions jsonb not null default '[]'::jsonb;

drop index if exists idx_auth_user_team_members_role_id;
create index if not exists idx_auth_user_team_members_role_id
on public.auth_user_team_members (role_id);

alter table public.auth_user_team_members
  drop constraint if exists auth_user_team_members_custom_permissions_array_check;

alter table public.auth_user_team_members
  add constraint auth_user_team_members_custom_permissions_array_check
  check (jsonb_typeof(custom_permissions) = 'array');

alter table public.auth_user_team_roles enable row level security;

drop policy if exists "service_role_all_auth_user_team_roles" on public.auth_user_team_roles;
create policy "service_role_all_auth_user_team_roles"
on public.auth_user_team_roles
for all
to service_role
using (true)
with check (true);
