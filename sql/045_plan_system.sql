alter table public.guild_plan_settings
drop constraint if exists guild_plan_settings_plan_code_check;

alter table public.guild_plan_settings
drop constraint if exists guild_plan_settings_monthly_amount_check;

alter table public.guild_plan_settings
add constraint guild_plan_settings_plan_code_check
check (plan_code in ('basic', 'pro', 'ultra', 'master'));

alter table public.guild_plan_settings
add constraint guild_plan_settings_monthly_amount_check
check (monthly_amount >= 0);

alter table public.payment_orders
drop constraint if exists payment_orders_payment_method_check;

alter table public.payment_orders
drop constraint if exists payment_orders_amount_check;

alter table public.payment_orders
add constraint payment_orders_payment_method_check
check (payment_method in ('pix', 'card', 'trial'));

alter table public.payment_orders
add constraint payment_orders_amount_check
check (amount >= 0);

alter table public.payment_orders
add column if not exists plan_code text not null default 'pro';

alter table public.payment_orders
add column if not exists plan_name text not null default 'Flow Pro';

alter table public.payment_orders
add column if not exists plan_billing_cycle_days integer not null default 30;

alter table public.payment_orders
add column if not exists plan_max_licensed_servers integer not null default 1;

alter table public.payment_orders
add column if not exists plan_max_active_tickets integer not null default 50;

alter table public.payment_orders
add column if not exists plan_max_automations integer not null default 2;

alter table public.payment_orders
add column if not exists plan_max_monthly_actions integer not null default 1000;

update public.payment_orders
set
  plan_code = coalesce(nullif(plan_code, ''), 'pro'),
  plan_name = coalesce(nullif(plan_name, ''), 'Flow Pro'),
  plan_billing_cycle_days = greatest(coalesce(plan_billing_cycle_days, 30), 1),
  plan_max_licensed_servers = greatest(coalesce(plan_max_licensed_servers, 1), 1),
  plan_max_active_tickets = greatest(coalesce(plan_max_active_tickets, 50), 0),
  plan_max_automations = greatest(coalesce(plan_max_automations, 2), 0),
  plan_max_monthly_actions = greatest(coalesce(plan_max_monthly_actions, 1000), 0);

create table if not exists public.auth_user_plan_state (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  plan_code text not null default 'pro',
  plan_name text not null default 'Flow Pro',
  status text not null default 'inactive' check (status in ('inactive', 'trial', 'active', 'expired')),
  amount numeric(10,2) not null default 0 check (amount >= 0),
  compare_amount numeric(10,2) not null default 0 check (compare_amount >= 0),
  currency text not null default 'BRL',
  billing_cycle_days integer not null default 30 check (billing_cycle_days > 0),
  max_licensed_servers integer not null default 1 check (max_licensed_servers > 0),
  max_active_tickets integer not null default 0 check (max_active_tickets >= 0),
  max_automations integer not null default 0 check (max_automations >= 0),
  max_monthly_actions integer not null default 0 check (max_monthly_actions >= 0),
  last_payment_order_id bigint references public.payment_orders(id) on delete set null,
  last_payment_guild_id text,
  activated_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_plan_state_plan_code_check check (plan_code in ('basic', 'pro', 'ultra', 'master'))
);

create index if not exists idx_auth_user_plan_state_status
on public.auth_user_plan_state (status, expires_at);

drop trigger if exists tr_auth_user_plan_state_updated_at on public.auth_user_plan_state;
create trigger tr_auth_user_plan_state_updated_at
before update on public.auth_user_plan_state
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_state enable row level security;

drop policy if exists "service_role_all_auth_user_plan_state" on public.auth_user_plan_state;
create policy "service_role_all_auth_user_plan_state"
on public.auth_user_plan_state
for all
to service_role
using (true)
with check (true);
