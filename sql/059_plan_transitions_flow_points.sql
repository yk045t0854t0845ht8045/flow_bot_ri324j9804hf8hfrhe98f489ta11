create table if not exists public.auth_user_plan_flow_points (
  user_id bigint primary key references public.auth_users(id) on delete cascade,
  currency text not null default 'BRL',
  balance_amount numeric(12,2) not null default 0 check (balance_amount >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists tr_auth_user_plan_flow_points_updated_at on public.auth_user_plan_flow_points;
create trigger tr_auth_user_plan_flow_points_updated_at
before update on public.auth_user_plan_flow_points
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_flow_points enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_flow_points" on public.auth_user_plan_flow_points';
    execute 'create policy "service_role_all_auth_user_plan_flow_points" on public.auth_user_plan_flow_points for all to service_role using (true) with check (true)';
  end if;
end
$$;

create table if not exists public.auth_user_plan_flow_point_events (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  event_type text not null,
  amount numeric(12,2) not null,
  currency text not null default 'BRL',
  balance_after numeric(12,2) not null check (balance_after >= 0),
  reference_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_flow_point_events_reference_key
on public.auth_user_plan_flow_point_events (reference_key)
where reference_key is not null;

create index if not exists idx_auth_user_plan_flow_point_events_user_created_at
on public.auth_user_plan_flow_point_events (user_id, created_at desc);

create index if not exists idx_auth_user_plan_flow_point_events_payment_order_id
on public.auth_user_plan_flow_point_events (payment_order_id)
where payment_order_id is not null;

alter table public.auth_user_plan_flow_point_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_flow_point_events" on public.auth_user_plan_flow_point_events';
    execute 'create policy "service_role_all_auth_user_plan_flow_point_events" on public.auth_user_plan_flow_point_events for all to service_role using (true) with check (true)';
  end if;
end
$$;

create table if not exists public.auth_user_plan_scheduled_changes (
  id bigserial primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text,
  current_plan_code text not null check (current_plan_code in ('basic', 'pro', 'ultra', 'master')),
  current_billing_cycle_days integer not null check (current_billing_cycle_days > 0),
  target_plan_code text not null check (target_plan_code in ('basic', 'pro', 'ultra', 'master')),
  target_billing_period_code text not null check (target_billing_period_code in ('monthly', 'quarterly', 'semiannual', 'annual')),
  target_billing_cycle_days integer not null check (target_billing_cycle_days > 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'applied', 'cancelled')),
  effective_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists idx_auth_user_plan_scheduled_changes_active_user
on public.auth_user_plan_scheduled_changes (user_id)
where status = 'scheduled';

create index if not exists idx_auth_user_plan_scheduled_changes_user_status_effective_at
on public.auth_user_plan_scheduled_changes (user_id, status, effective_at);

drop trigger if exists tr_auth_user_plan_scheduled_changes_updated_at on public.auth_user_plan_scheduled_changes;
create trigger tr_auth_user_plan_scheduled_changes_updated_at
before update on public.auth_user_plan_scheduled_changes
for each row
execute function public.set_updated_at();

alter table public.auth_user_plan_scheduled_changes enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_auth_user_plan_scheduled_changes" on public.auth_user_plan_scheduled_changes';
    execute 'create policy "service_role_all_auth_user_plan_scheduled_changes" on public.auth_user_plan_scheduled_changes for all to service_role using (true) with check (true)';
  end if;
end
$$;

create or replace function public.apply_user_plan_flow_points_event(
  p_user_id bigint,
  p_event_type text,
  p_amount numeric,
  p_currency text default 'BRL',
  p_reference_key text default null,
  p_payment_order_id bigint default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table(balance_amount numeric, applied_amount numeric, applied boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_currency text;
  v_current_balance numeric(12,2);
  v_next_balance numeric(12,2);
  v_applied_amount numeric(12,2);
  v_existing_balance numeric(12,2);
begin
  v_currency := coalesce(nullif(trim(coalesce(p_currency, '')), ''), 'BRL');

  if p_reference_key is not null then
    select e.balance_after
      into v_existing_balance
      from public.auth_user_plan_flow_point_events e
     where e.reference_key = p_reference_key
     limit 1;

    if found then
      balance_amount := coalesce(v_existing_balance, 0);
      applied_amount := 0;
      applied := false;
      return next;
      return;
    end if;
  end if;

  insert into public.auth_user_plan_flow_points (
    user_id,
    currency,
    balance_amount
  )
  values (
    p_user_id,
    v_currency,
    0
  )
  on conflict (user_id) do nothing;

  select fp.balance_amount
    into v_current_balance
    from public.auth_user_plan_flow_points fp
   where fp.user_id = p_user_id
   for update;

  v_current_balance := coalesce(v_current_balance, 0);
  v_next_balance := round(greatest(0, v_current_balance + coalesce(p_amount, 0))::numeric, 2);
  v_applied_amount := round((v_next_balance - v_current_balance)::numeric, 2);

  update public.auth_user_plan_flow_points
     set currency = v_currency,
         balance_amount = v_next_balance
   where user_id = p_user_id;

  insert into public.auth_user_plan_flow_point_events (
    user_id,
    payment_order_id,
    event_type,
    amount,
    currency,
    balance_after,
    reference_key,
    metadata
  )
  values (
    p_user_id,
    p_payment_order_id,
    coalesce(nullif(trim(coalesce(p_event_type, '')), ''), 'flow_points_adjustment'),
    v_applied_amount,
    v_currency,
    v_next_balance,
    p_reference_key,
    coalesce(p_metadata, '{}'::jsonb)
  );

  balance_amount := v_next_balance;
  applied_amount := v_applied_amount;
  applied := true;
  return next;
end;
$$;
