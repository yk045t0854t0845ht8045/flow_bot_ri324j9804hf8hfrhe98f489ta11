create table if not exists public.payment_provider_event_inbox (
  id bigint generated always as identity primary key,
  provider text not null,
  event_key text not null,
  resource_type text,
  resource_id text,
  event_action text,
  status text not null default 'processing'
    check (status in ('processing', 'failed', 'completed', 'dead_letter')),
  attempt_count integer not null default 1 check (attempt_count >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  signature_verified boolean not null default false,
  request_id text,
  request_path text,
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  last_error text,
  received_at timestamptz not null default timezone('utc', now()),
  last_received_at timestamptz not null default timezone('utc', now()),
  processed_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_provider_event_inbox_provider_event_key_key unique (provider, event_key)
);

create index if not exists idx_payment_provider_event_inbox_status_retry
on public.payment_provider_event_inbox (status, next_retry_at, last_received_at desc);

create index if not exists idx_payment_provider_event_inbox_provider_resource
on public.payment_provider_event_inbox (provider, resource_type, resource_id, created_at desc)
where resource_id is not null;

drop trigger if exists tr_payment_provider_event_inbox_updated_at on public.payment_provider_event_inbox;
create trigger tr_payment_provider_event_inbox_updated_at
before update on public.payment_provider_event_inbox
for each row
execute function public.set_updated_at();

alter table public.payment_provider_event_inbox enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'drop policy if exists "service_role_all_payment_provider_event_inbox" on public.payment_provider_event_inbox';
    execute 'create policy "service_role_all_payment_provider_event_inbox" on public.payment_provider_event_inbox for all to service_role using (true) with check (true)';
  end if;
end
$$;

with ranked_pending_drafts as (
  select
    id,
    row_number() over (
      partition by user_id, coalesce(guild_id, '__global__'), payment_method
      order by created_at desc, id desc
    ) as rn
  from public.payment_orders
  where status = 'pending'
    and provider_payment_id is null
    and payment_method in ('pix', 'card')
)
update public.payment_orders po
set
  status = 'cancelled',
  provider_status = coalesce(po.provider_status, 'cancelled'),
  provider_status_detail = 'superseded_pending_draft_guard',
  provider_payload = coalesce(po.provider_payload, '{}'::jsonb) || jsonb_build_object(
    'duplicate_guard',
    jsonb_build_object(
      'reason', 'superseded_pending_draft_guard',
      'cancelled_at', timezone('utc', now())
    )
  ),
  updated_at = timezone('utc', now())
from ranked_pending_drafts ranked
where po.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists idx_payment_orders_single_pending_draft_per_scope
on public.payment_orders (user_id, coalesce(guild_id, '__global__'), payment_method)
where status = 'pending'
  and provider_payment_id is null
  and payment_method in ('pix', 'card');
