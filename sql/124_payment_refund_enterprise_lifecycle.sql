-- Enterprise refund/subscription lifecycle hardening.
-- Safe to run more than once.

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
      'partially_refunded',
      'charged_back'
    )
  );

alter table if exists public.payment_checkout_carts
  drop constraint if exists payment_checkout_carts_cart_status_check;

alter table if exists public.payment_checkout_carts
  add constraint payment_checkout_carts_cart_status_check
  check (
    cart_status in (
      'draft',
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'partially_refunded',
      'charged_back'
    )
  );

alter table if exists public.payment_order_state_history
  drop constraint if exists payment_order_state_history_status_check;

alter table if exists public.payment_order_state_history
  add constraint payment_order_state_history_status_check
  check (
    status in (
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
      'failed',
      'refunded',
      'partially_refunded',
      'charged_back'
    )
  );

create table if not exists public.payment_refund_records (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text null,
  refund_key text not null,
  provider_payment_id text null,
  provider_refund_id text null,
  status text not null,
  kind text not null,
  source text not null,
  amount numeric(12,2) not null default 0,
  currency text not null default 'BRL',
  reason text not null default '',
  actor_user_id text null,
  actor_label text null,
  protocol text null,
  access_action text not null default 'revoke_immediately',
  access_until timestamptz null,
  risk_score integer null,
  risk_flags jsonb not null default '[]'::jsonb,
  provider_payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_refund_records_refund_key_unique unique (payment_order_id, refund_key),
  constraint payment_refund_records_status_check
    check (status in ('refunded', 'partially_refunded', 'charged_back')),
  constraint payment_refund_records_kind_check
    check (kind in ('full_refund', 'partial_refund', 'chargeback', 'manual_adjustment', 'refund_reversal')),
  constraint payment_refund_records_source_check
    check (source in ('official_support_ticket', 'admin_manual', 'system_auto', 'mercado_pago_webhook', 'provider_reconciliation')),
  constraint payment_refund_records_access_action_check
    check (access_action in ('revoke_immediately', 'keep_until_expiration', 'cancel_renewal_only', 'block_internal', 'none')),
  constraint payment_refund_records_amount_check
    check (amount >= 0),
  constraint payment_refund_records_risk_score_check
    check (risk_score is null or risk_score between 0 and 100),
  constraint payment_refund_records_risk_flags_array_check
    check (jsonb_typeof(risk_flags) = 'array')
);

create index if not exists idx_payment_refund_records_order_processed
  on public.payment_refund_records (payment_order_id, processed_at desc);

create index if not exists idx_payment_refund_records_user_processed
  on public.payment_refund_records (user_id, processed_at desc);

create index if not exists idx_payment_refund_records_guild_processed
  on public.payment_refund_records (guild_id, processed_at desc)
  where guild_id is not null;

drop trigger if exists tr_payment_refund_records_updated_at
  on public.payment_refund_records;

create trigger tr_payment_refund_records_updated_at
  before update on public.payment_refund_records
  for each row
  execute function public.set_updated_at();

alter table public.payment_refund_records enable row level security;

drop policy if exists "service_role_all_payment_refund_records"
  on public.payment_refund_records;

create policy "service_role_all_payment_refund_records"
  on public.payment_refund_records
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.payment_risk_flags (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text null,
  payment_order_id bigint references public.payment_orders(id) on delete set null,
  flag_key text not null,
  severity text not null default 'medium',
  status text not null default 'active',
  reason text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_risk_flags_unique unique (user_id, flag_key, payment_order_id),
  constraint payment_risk_flags_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint payment_risk_flags_status_check
    check (status in ('active', 'reviewed', 'dismissed', 'expired'))
);

create index if not exists idx_payment_risk_flags_user_status
  on public.payment_risk_flags (user_id, status, created_at desc);

create index if not exists idx_payment_risk_flags_order
  on public.payment_risk_flags (payment_order_id)
  where payment_order_id is not null;

drop trigger if exists tr_payment_risk_flags_updated_at
  on public.payment_risk_flags;

create trigger tr_payment_risk_flags_updated_at
  before update on public.payment_risk_flags
  for each row
  execute function public.set_updated_at();

alter table public.payment_risk_flags enable row level security;

drop policy if exists "service_role_all_payment_risk_flags"
  on public.payment_risk_flags;

create policy "service_role_all_payment_risk_flags"
  on public.payment_risk_flags
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.payment_refund_policy_rules (
  id bigint generated always as identity primary key,
  plan_family text not null,
  refund_window_days integer not null default 7,
  default_access_action text not null default 'revoke_immediately',
  outside_window_action text not null default 'manual_review',
  allow_partial_proration boolean not null default true,
  anti_abuse_refund_count_threshold integer not null default 2,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_refund_policy_rules_plan_family_unique unique (plan_family),
  constraint payment_refund_policy_rules_plan_family_check
    check (plan_family in ('trial', 'monthly', 'quarterly', 'semiannual', 'annual', 'lifetime', 'custom')),
  constraint payment_refund_policy_rules_access_action_check
    check (default_access_action in ('revoke_immediately', 'keep_until_expiration', 'cancel_renewal_only', 'block_internal', 'none')),
  constraint payment_refund_policy_rules_outside_window_action_check
    check (outside_window_action in ('manual_review', 'partial_proration', 'deny', 'keep_until_expiration')),
  constraint payment_refund_policy_rules_window_check
    check (refund_window_days between 0 and 365),
  constraint payment_refund_policy_rules_abuse_threshold_check
    check (anti_abuse_refund_count_threshold between 1 and 20)
);

insert into public.payment_refund_policy_rules (
  plan_family,
  refund_window_days,
  default_access_action,
  outside_window_action,
  allow_partial_proration,
  anti_abuse_refund_count_threshold,
  metadata
)
values
  ('trial', 0, 'revoke_immediately', 'deny', false, 1, '{"description":"Teste gratuito sem estorno financeiro."}'::jsonb),
  ('monthly', 7, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Janela padrao SaaS mensal."}'::jsonb),
  ('quarterly', 7, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Ciclo trimestral com reembolso proporcional apos a janela."}'::jsonb),
  ('semiannual', 10, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Ciclo semestral com politica proporcional."}'::jsonb),
  ('annual', 14, 'revoke_immediately', 'partial_proration', true, 2, '{"description":"Ciclo anual com janela estendida."}'::jsonb),
  ('lifetime', 14, 'revoke_immediately', 'manual_review', false, 1, '{"description":"Plano vitalicio exige revisao manual depois da janela."}'::jsonb),
  ('custom', 7, 'revoke_immediately', 'manual_review', true, 2, '{"description":"Fallback para ciclos personalizados."}'::jsonb)
on conflict (plan_family) do nothing;

drop trigger if exists tr_payment_refund_policy_rules_updated_at
  on public.payment_refund_policy_rules;

create trigger tr_payment_refund_policy_rules_updated_at
  before update on public.payment_refund_policy_rules
  for each row
  execute function public.set_updated_at();

alter table public.payment_refund_policy_rules enable row level security;

drop policy if exists "service_role_all_payment_refund_policy_rules"
  on public.payment_refund_policy_rules;

create policy "service_role_all_payment_refund_policy_rules"
  on public.payment_refund_policy_rules
  for all
  to service_role
  using (true)
  with check (true);

update public.payment_orders
set status = 'refunded'
where status = 'cancelled'
  and (
    lower(coalesce(provider_status, '')) = 'refunded'
    or lower(coalesce(provider_status_detail, '')) like '%refund%'
    or lower(coalesce(provider_status_detail, '')) like '%reembols%'
  );

update public.payment_orders
set status = 'charged_back'
where status <> 'charged_back'
  and lower(coalesce(provider_status, '')) in ('charged_back', 'chargeback');

comment on table public.payment_refund_records
is 'Normalized immutable refund ledger for account payment history, support decisions, provider reconciliation and admin audit.';

comment on table public.payment_refund_policy_rules
is 'Configurable refund/access policy defaults by plan billing family.';
