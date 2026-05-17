create table if not exists public.ticket_refund_auth_links (
  id uuid primary key default gen_random_uuid(),
  ticket_id bigint not null references public.tickets(id) on delete cascade,
  guild_id text not null,
  channel_id text not null,
  discord_user_id text not null,
  token_hash text not null unique,
  status text not null default 'pending',
  auth_user_id bigint references public.auth_users(id) on delete set null,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint ticket_refund_auth_links_status_check
    check (status in ('pending', 'confirmed', 'expired', 'revoked')),
  constraint ticket_refund_auth_links_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint ticket_refund_auth_links_channel_id_check
    check (channel_id ~ '^[0-9]{10,25}$'),
  constraint ticket_refund_auth_links_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$')
);

create index if not exists idx_ticket_refund_auth_links_ticket_status
  on public.ticket_refund_auth_links (ticket_id, status, created_at desc);

create index if not exists idx_ticket_refund_auth_links_discord_pending
  on public.ticket_refund_auth_links (discord_user_id, status, expires_at desc);

drop trigger if exists tr_ticket_refund_auth_links_updated_at
  on public.ticket_refund_auth_links;

create trigger tr_ticket_refund_auth_links_updated_at
  before update on public.ticket_refund_auth_links
  for each row
  execute function public.set_updated_at();

alter table public.ticket_refund_auth_links enable row level security;

drop policy if exists "service_role_all_ticket_refund_auth_links"
  on public.ticket_refund_auth_links;

create policy "service_role_all_ticket_refund_auth_links"
  on public.ticket_refund_auth_links
  for all
  to service_role
  using (true)
  with check (true);

alter table public.guild_sales_carts
  drop constraint if exists guild_sales_carts_status_check;

alter table public.guild_sales_carts
  add constraint guild_sales_carts_status_check
  check (
    status in (
      'link_required',
      'open',
      'payment_pending',
      'paid',
      'delivered',
      'delivery_failed',
      'rejected',
      'cancelled',
      'expired',
      'refunded',
      'charged_back'
    )
  );

alter table public.payment_orders
  drop constraint if exists payment_orders_status_check;

alter table public.payment_orders
  add constraint payment_orders_status_check
  check (
    status in (
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'charged_back'
    )
  );

create table if not exists public.ticket_refund_audit_events (
  id bigint generated always as identity primary key,
  ticket_id bigint references public.tickets(id) on delete set null,
  guild_id text,
  channel_id text,
  discord_user_id text,
  auth_user_id bigint references public.auth_users(id) on delete set null,
  event_type text not null,
  outcome text not null default 'recorded',
  order_key text,
  risk_score integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint ticket_refund_audit_events_risk_score_check
    check (risk_score is null or risk_score between 0 and 100)
);

create index if not exists idx_ticket_refund_audit_events_ticket_created
  on public.ticket_refund_audit_events (ticket_id, created_at desc);

create index if not exists idx_ticket_refund_audit_events_guild_created
  on public.ticket_refund_audit_events (guild_id, created_at desc);

create index if not exists idx_ticket_refund_audit_events_user_created
  on public.ticket_refund_audit_events (discord_user_id, created_at desc);

alter table public.ticket_refund_audit_events enable row level security;

drop policy if exists "service_role_all_ticket_refund_audit_events"
  on public.ticket_refund_audit_events;

create policy "service_role_all_ticket_refund_audit_events"
  on public.ticket_refund_audit_events
  for all
  to service_role
  using (true)
  with check (true);
