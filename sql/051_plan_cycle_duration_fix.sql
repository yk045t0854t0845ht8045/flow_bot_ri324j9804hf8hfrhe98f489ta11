begin;

alter table public.payment_orders
  alter column plan_billing_cycle_days drop default;

alter table public.auth_user_plan_state
  alter column billing_cycle_days drop default;

with resolved_cycles as (
  select
    po.id,
    greatest(
      coalesce(
        case
          when coalesce(po.provider_payload -> 'plan' ->> 'billingCycleDays', '') ~ '^\d+$'
            then (po.provider_payload -> 'plan' ->> 'billingCycleDays')::integer
          else null
        end,
        case
          when lower(coalesce(po.plan_code, '')) = 'basic' then 7
          else null
        end,
        nullif(po.plan_billing_cycle_days, 0),
        case lower(coalesce(po.plan_code, ''))
          when 'pro' then 30
          when 'ultra' then 30
          when 'master' then 30
          else 30
        end
      ),
      1
    ) as resolved_billing_cycle_days
  from public.payment_orders po
)
update public.payment_orders as po
set plan_billing_cycle_days = rc.resolved_billing_cycle_days
from resolved_cycles rc
where po.id = rc.id
  and po.plan_billing_cycle_days is distinct from rc.resolved_billing_cycle_days;

with approved_orders as (
  select
    po.id,
    coalesce(po.paid_at, po.created_at) as base_timestamp,
    greatest(coalesce(po.plan_billing_cycle_days, 1), 1) as billing_cycle_days
  from public.payment_orders po
  where po.status = 'approved'
),
resolved_expiration as (
  select
    ao.id,
    case
      when ao.billing_cycle_days = 30 then ao.base_timestamp + interval '1 month'
      when ao.billing_cycle_days = 90 then ao.base_timestamp + interval '3 months'
      when ao.billing_cycle_days = 180 then ao.base_timestamp + interval '6 months'
      when ao.billing_cycle_days = 365 then ao.base_timestamp + interval '1 year'
      else ao.base_timestamp + make_interval(days => ao.billing_cycle_days)
    end as resolved_expires_at
  from approved_orders ao
)
update public.payment_orders as po
set expires_at = re.resolved_expires_at
from resolved_expiration re
where po.id = re.id
  and po.expires_at is distinct from re.resolved_expires_at;

with ranked_orders as (
  select
    po.user_id,
    po.plan_code,
    greatest(coalesce(po.plan_billing_cycle_days, 1), 1) as billing_cycle_days,
    coalesce(po.paid_at, po.created_at) as activated_at,
    po.expires_at,
    row_number() over (
      partition by po.user_id
      order by coalesce(po.paid_at, po.created_at) desc, po.created_at desc, po.id desc
    ) as row_number
  from public.payment_orders po
  where po.status = 'approved'
),
latest_orders as (
  select
    ro.user_id,
    ro.plan_code,
    ro.billing_cycle_days,
    ro.activated_at,
    ro.expires_at
  from ranked_orders ro
  where ro.row_number = 1
)
update public.auth_user_plan_state as ups
set billing_cycle_days = lo.billing_cycle_days,
    activated_at = lo.activated_at,
    expires_at = lo.expires_at,
    status = case
      when lo.expires_at is not null and lo.expires_at < now() then 'expired'
      when lower(coalesce(lo.plan_code, '')) = 'basic' then 'trial'
      else 'active'
    end,
    metadata = jsonb_set(
      coalesce(ups.metadata, '{}'::jsonb),
      '{plan,billingCycleDays}',
      to_jsonb(lo.billing_cycle_days),
      true
    )
from latest_orders lo
where ups.user_id = lo.user_id
  and (
    ups.billing_cycle_days is distinct from lo.billing_cycle_days or
    ups.activated_at is distinct from lo.activated_at or
    ups.expires_at is distinct from lo.expires_at or
    ups.status is distinct from case
      when lo.expires_at is not null and lo.expires_at < now() then 'expired'
      when lower(coalesce(lo.plan_code, '')) = 'basic' then 'trial'
      else 'active'
    end
  );

commit;
