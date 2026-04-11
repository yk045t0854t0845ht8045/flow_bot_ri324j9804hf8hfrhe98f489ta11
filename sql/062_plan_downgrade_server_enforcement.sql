alter table public.auth_user_plan_guilds
add column if not exists is_active boolean not null default true,
add column if not exists deactivated_reason text null,
add column if not exists deactivated_at timestamptz null,
add column if not exists reactivated_at timestamptz null;

create index if not exists idx_auth_user_plan_guilds_user_active
on public.auth_user_plan_guilds (user_id, is_active, activated_at desc);

create table if not exists public.auth_user_plan_downgrade_enforcements (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  scheduled_change_id bigint references public.auth_user_plan_scheduled_changes(id) on delete set null,
  target_plan_code text not null check (target_plan_code in ('basic', 'pro', 'ultra', 'master')),
  target_billing_period_code text not null check (target_billing_period_code in ('monthly', 'quarterly', 'semiannual', 'annual')),
  target_billing_cycle_days integer not null check (target_billing_cycle_days > 0),
  target_max_licensed_servers integer not null check (target_max_licensed_servers > 0),
  status text not null default 'selection_required' check (status in ('selection_required', 'awaiting_payment', 'resolved', 'cancelled')),
  effective_at timestamptz not null,
  selected_guild_ids jsonb not null default '[]'::jsonb,
  resolved_payment_order_id bigint references public.payment_orders(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_downgrade_enforcements_selected_guild_ids_array
    check (jsonb_typeof(selected_guild_ids) = 'array')
);

create unique index if not exists idx_auth_user_plan_downgrade_enforcements_active_user
on public.auth_user_plan_downgrade_enforcements (user_id)
where status in ('selection_required', 'awaiting_payment');

create index if not exists idx_auth_user_plan_downgrade_enforcements_user_status
on public.auth_user_plan_downgrade_enforcements (user_id, status, effective_at desc);

drop trigger if exists tr_auth_user_plan_downgrade_enforcements_updated_at on public.auth_user_plan_downgrade_enforcements;
create trigger tr_auth_user_plan_downgrade_enforcements_updated_at
before update on public.auth_user_plan_downgrade_enforcements
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_downgrade_enforcements enable row level security;

drop policy if exists "service_role_all_auth_user_plan_downgrade_enforcements" on public.auth_user_plan_downgrade_enforcements;
create policy "service_role_all_auth_user_plan_downgrade_enforcements"
on public.auth_user_plan_downgrade_enforcements
for all
to service_role
using (true)
with check (true);
