begin;

create or replace function public.base36_encode_bigint(p_value bigint)
returns text
language plpgsql
immutable
strict
as $$
declare
  v_alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyz';
  v_value bigint := abs(p_value);
  v_remainder integer;
  v_encoded text := '';
begin
  if p_value = 0 then
    return '0';
  end if;

  while v_value > 0 loop
    v_remainder := (v_value % 36)::integer;
    v_encoded := substr(v_alphabet, v_remainder + 1, 1) || v_encoded;
    v_value := v_value / 36;
  end loop;

  if p_value < 0 then
    return '-' || v_encoded;
  end if;

  return v_encoded;
end;
$$;

create or replace function public.payment_parse_numeric(
  p_value text,
  p_default numeric default 0
)
returns numeric
language plpgsql
immutable
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return p_default;
  end if;

  if btrim(p_value) ~ '^-?[0-9]+(\.[0-9]+)?$' then
    return p_value::numeric;
  end if;

  return p_default;
end;
$$;

create or replace function public.payment_parse_boolean(
  p_value text,
  p_default boolean default false
)
returns boolean
language plpgsql
immutable
as $$
declare
  v_normalized text;
begin
  if p_value is null or btrim(p_value) = '' then
    return p_default;
  end if;

  v_normalized := lower(btrim(p_value));

  if v_normalized in ('1', 'true', 't', 'yes', 'y', 'on') then
    return true;
  end if;

  if v_normalized in ('0', 'false', 'f', 'no', 'n', 'off') then
    return false;
  end if;

  return p_default;
end;
$$;

create or replace function public.ensure_service_role_all_policy(
  p_table regclass,
  p_policy_name text
)
returns void
language plpgsql
as $$
begin
  if exists (
    select 1
    from pg_roles
    where rolname = 'service_role'
  ) then
    execute format('drop policy if exists %I on %s', p_policy_name, p_table);
    execute format(
      'create policy %I on %s for all to service_role using (true) with check (true)',
      p_policy_name,
      p_table
    );
  end if;
end;
$$;

alter table public.payment_orders
  add column if not exists order_public_id text,
  add column if not exists cart_public_id text,
  add column if not exists scope_type text,
  add column if not exists checkout_surface text default 'payment',
  add column if not exists checkout_origin text default 'flowdesk_checkout';

update public.payment_orders
set
  scope_type = case when guild_id is null then 'account' else 'guild' end,
  order_public_id = coalesce(nullif(order_public_id, ''), 'flw_' || public.base36_encode_bigint(order_number)),
  cart_public_id = coalesce(nullif(cart_public_id, ''), 'crt_' || public.base36_encode_bigint(id)),
  checkout_surface = coalesce(nullif(checkout_surface, ''), 'payment'),
  checkout_origin = coalesce(
    nullif(checkout_origin, ''),
    nullif(provider_payload ->> 'source', ''),
    'flowdesk_checkout'
  )
where scope_type is null
   or order_public_id is null
   or order_public_id = ''
   or cart_public_id is null
   or cart_public_id = ''
   or checkout_surface is null
   or checkout_surface = ''
   or checkout_origin is null
   or checkout_origin = '';

alter table public.payment_orders
  alter column scope_type set default 'guild',
  alter column checkout_surface set default 'payment',
  alter column checkout_origin set default 'flowdesk_checkout';

alter table public.payment_orders
  alter column scope_type set not null,
  alter column checkout_surface set not null,
  alter column checkout_origin set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'payment_orders_scope_type_check'
      and conrelid = 'public.payment_orders'::regclass
  ) then
    alter table public.payment_orders
      add constraint payment_orders_scope_type_check
      check (scope_type in ('account', 'guild'));
  end if;
end
$$;

create unique index if not exists idx_payment_orders_order_public_id_unique
on public.payment_orders (order_public_id)
where order_public_id is not null;

create unique index if not exists idx_payment_orders_cart_public_id_unique
on public.payment_orders (cart_public_id)
where cart_public_id is not null;

create index if not exists idx_payment_orders_user_scope_status_created_at
on public.payment_orders (user_id, scope_type, status, created_at desc);

create index if not exists idx_payment_orders_public_lookup
on public.payment_orders (order_public_id, cart_public_id);

drop trigger if exists tr_payment_orders_public_identifiers on public.payment_orders;
create or replace function public.payment_orders_assign_public_identifiers()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is not null and (new.order_public_id is null or btrim(new.order_public_id) = '') then
    new.order_public_id := 'flw_' || public.base36_encode_bigint(new.order_number);
  end if;

  if new.id is not null and (new.cart_public_id is null or btrim(new.cart_public_id) = '') then
    new.cart_public_id := 'crt_' || public.base36_encode_bigint(new.id);
  end if;

  new.scope_type := case when new.guild_id is null then 'account' else 'guild' end;
  new.checkout_surface := coalesce(nullif(new.checkout_surface, ''), 'payment');
  new.checkout_origin := coalesce(
    nullif(new.checkout_origin, ''),
    nullif(new.provider_payload ->> 'source', ''),
    'flowdesk_checkout'
  );

  return new;
end;
$$;

create trigger tr_payment_orders_public_identifiers
before insert or update on public.payment_orders
for each row
execute function public.payment_orders_assign_public_identifiers();

create table if not exists public.payment_checkout_carts (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  order_number bigint not null,
  order_public_id text not null,
  cart_public_id text not null,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null
    check (scope_type in ('account', 'guild')),
  source text not null default 'flowdesk_checkout',
  checkout_surface text not null default 'payment',
  checkout_step integer
    check (checkout_step is null or checkout_step between 0 and 99),
  cart_status text not null default 'draft'
    check (cart_status in ('draft', 'pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  plan_code text not null,
  plan_name text not null,
  billing_cycle_days integer not null
    check (billing_cycle_days > 0),
  currency text not null default 'BRL',
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  subtotal_amount numeric(10,2) not null default 0
    check (subtotal_amount >= 0),
  coupon_amount numeric(10,2) not null default 0
    check (coupon_amount >= 0),
  gift_card_amount numeric(10,2) not null default 0
    check (gift_card_amount >= 0),
  flow_points_amount numeric(10,2) not null default 0
    check (flow_points_amount >= 0),
  total_amount numeric(10,2) not null default 0
    check (total_amount >= 0),
  coupon_code text,
  gift_card_code text,
  payer_name text,
  payer_document_last4 text,
  payer_document_type text
    check (payer_document_type in ('CPF', 'CNPJ')),
  plan_snapshot jsonb not null default '{}'::jsonb,
  pricing_snapshot jsonb not null default '{}'::jsonb,
  transition_snapshot jsonb not null default '{}'::jsonb,
  provider_snapshot jsonb not null default '{}'::jsonb,
  customer_snapshot jsonb not null default '{}'::jsonb,
  checkout_context jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  finalized_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint payment_checkout_carts_payment_order_id_key unique (payment_order_id),
  constraint payment_checkout_carts_order_public_id_cart_public_id_key unique (order_public_id, cart_public_id)
);

create index if not exists idx_payment_checkout_carts_user_status_updated_at
on public.payment_checkout_carts (user_id, cart_status, updated_at desc);

create index if not exists idx_payment_checkout_carts_scope_status_updated_at
on public.payment_checkout_carts (scope_type, guild_id, cart_status, updated_at desc);

create index if not exists idx_payment_checkout_carts_public_lookup
on public.payment_checkout_carts (order_public_id, cart_public_id);

drop trigger if exists tr_payment_checkout_carts_updated_at on public.payment_checkout_carts;
create trigger tr_payment_checkout_carts_updated_at
before update on public.payment_checkout_carts
for each row
execute function public.set_updated_at();

alter table public.payment_checkout_carts enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_checkout_carts'::regclass,
  'service_role_all_payment_checkout_carts'
);

create table if not exists public.payment_order_state_history (
  id bigint generated always as identity primary key,
  payment_order_id bigint not null references public.payment_orders(id) on delete cascade,
  order_number bigint not null,
  order_public_id text,
  cart_public_id text,
  user_id bigint not null references public.auth_users(id) on delete restrict,
  guild_id text,
  scope_type text not null
    check (scope_type in ('account', 'guild')),
  payment_method text not null
    check (payment_method in ('pix', 'card', 'trial')),
  status text not null
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'failed')),
  provider_status text,
  provider_status_detail text,
  provider_payment_id text,
  provider_external_reference text,
  amount numeric(10,2) not null default 0
    check (amount >= 0),
  currency text not null default 'BRL',
  plan_code text,
  plan_name text,
  billing_cycle_days integer,
  snapshot_kind text not null
    check (snapshot_kind in ('insert', 'update', 'backfill')),
  snapshot_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_payment_order_state_history_order_created_at
on public.payment_order_state_history (payment_order_id, created_at desc);

create index if not exists idx_payment_order_state_history_user_created_at
on public.payment_order_state_history (user_id, created_at desc);

create unique index if not exists idx_payment_order_state_history_backfill_unique
on public.payment_order_state_history (payment_order_id, snapshot_kind)
where snapshot_kind = 'backfill';

alter table public.payment_order_state_history enable row level security;
select public.ensure_service_role_all_policy(
  'public.payment_order_state_history'::regclass,
  'service_role_all_payment_order_state_history'
);

create or replace function public.refresh_payment_checkout_projection(
  p_order public.payment_orders,
  p_snapshot_kind text default 'update'
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_provider_payload jsonb := coalesce(p_order.provider_payload, '{}'::jsonb);
  v_pricing jsonb := case
    when jsonb_typeof(v_provider_payload -> 'pricing') = 'object'
      then v_provider_payload -> 'pricing'
    else '{}'::jsonb
  end;
  v_coupon jsonb := case
    when jsonb_typeof(v_pricing -> 'coupon') = 'object'
      then v_pricing -> 'coupon'
    else '{}'::jsonb
  end;
  v_gift_card jsonb := case
    when jsonb_typeof(v_pricing -> 'giftCard') = 'object'
      then v_pricing -> 'giftCard'
    else '{}'::jsonb
  end;
  v_flow_points jsonb := case
    when jsonb_typeof(v_pricing -> 'flowPoints') = 'object'
      then v_pricing -> 'flowPoints'
    else '{}'::jsonb
  end;
  v_transition jsonb := case
    when jsonb_typeof(v_provider_payload -> 'transition') = 'object'
      then v_provider_payload -> 'transition'
    else '{}'::jsonb
  end;
  v_plan jsonb := case
    when jsonb_typeof(v_provider_payload -> 'plan') = 'object'
      then v_provider_payload -> 'plan'
    else '{}'::jsonb
  end;
  v_scope_type text := case when p_order.guild_id is null then 'account' else 'guild' end;
  v_order_public_id text := coalesce(
    nullif(btrim(coalesce(p_order.order_public_id, '')), ''),
    'flw_' || public.base36_encode_bigint(p_order.order_number)
  );
  v_cart_public_id text := coalesce(
    nullif(btrim(coalesce(p_order.cart_public_id, '')), ''),
    'crt_' || public.base36_encode_bigint(p_order.id)
  );
  v_source text := coalesce(
    nullif(btrim(coalesce(v_provider_payload ->> 'source', '')), ''),
    nullif(btrim(coalesce(p_order.checkout_origin, '')), ''),
    'flowdesk_checkout'
  );
  v_checkout_surface text := coalesce(
    nullif(btrim(coalesce(p_order.checkout_surface, '')), ''),
    'payment'
  );
  v_checkout_step integer := case
    when coalesce(v_provider_payload ->> 'step', '') ~ '^\d+$'
      then (v_provider_payload ->> 'step')::integer
    else null
  end;
  v_plan_code text := coalesce(
    nullif(btrim(coalesce(v_plan ->> 'code', p_order.plan_code, '')), ''),
    'pro'
  );
  v_plan_name text := coalesce(
    nullif(btrim(coalesce(v_plan ->> 'name', p_order.plan_name, '')), ''),
    'Flow Pro'
  );
  v_billing_cycle_days integer := greatest(
    coalesce(
      public.payment_parse_numeric(v_plan ->> 'billingCycleDays', null)::integer,
      p_order.plan_billing_cycle_days,
      30
    ),
    1
  );
  v_coupon_amount numeric(10,2) := round(
    greatest(public.payment_parse_numeric(v_coupon ->> 'amount', 0), 0)::numeric,
    2
  );
  v_gift_card_amount numeric(10,2) := round(
    greatest(public.payment_parse_numeric(v_gift_card ->> 'amount', 0), 0)::numeric,
    2
  );
  v_flow_points_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_flow_points ->> 'appliedAmount', null),
        public.payment_parse_numeric(v_transition ->> 'flowPointsApplied', 0)
      ),
      0
    )::numeric,
    2
  );
  v_subtotal_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_pricing ->> 'subtotalAmount', null),
        public.payment_parse_numeric(v_pricing ->> 'baseAmount', null),
        p_order.amount,
        0
      ),
      0
    )::numeric,
    2
  );
  v_total_amount numeric(10,2) := round(
    greatest(
      coalesce(
        public.payment_parse_numeric(v_pricing ->> 'totalAmount', null),
        p_order.amount,
        0
      ),
      0
    )::numeric,
    2
  );
  v_cart_status text := case
    when p_order.status = 'pending'
      and p_order.provider_payment_id is null
      and public.payment_parse_boolean(v_provider_payload ->> 'precreated', false)
      then 'draft'
    else p_order.status
  end;
  v_payer_document_digits text := regexp_replace(coalesce(p_order.payer_document, ''), '\D', '', 'g');
  v_payer_document_last4 text := case
    when v_payer_document_digits <> '' then right(v_payer_document_digits, 4)
    else null
  end;
  v_plan_snapshot jsonb := case
    when v_plan <> '{}'::jsonb then v_plan
    else jsonb_strip_nulls(
      jsonb_build_object(
        'code', v_plan_code,
        'name', v_plan_name,
        'billingCycleDays', v_billing_cycle_days,
        'entitlements', jsonb_strip_nulls(
          jsonb_build_object(
            'maxLicensedServers', p_order.plan_max_licensed_servers,
            'maxActiveTickets', p_order.plan_max_active_tickets,
            'maxAutomations', p_order.plan_max_automations,
            'maxMonthlyActions', p_order.plan_max_monthly_actions
          )
        )
      )
    )
  end;
  v_provider_snapshot jsonb := jsonb_strip_nulls(
    jsonb_build_object(
      'provider', p_order.provider,
      'providerPaymentId', p_order.provider_payment_id,
      'externalReference', p_order.provider_external_reference,
      'status', p_order.provider_status,
      'statusDetail', p_order.provider_status_detail,
      'ticketUrl', p_order.provider_ticket_url,
      'mercadoPago', case
        when jsonb_typeof(v_provider_payload -> 'mercado_pago') = 'object'
          then v_provider_payload -> 'mercado_pago'
        else null
      end
    )
  );
  v_customer_snapshot jsonb := jsonb_strip_nulls(
    jsonb_build_object(
      'payerName', p_order.payer_name,
      'payerDocumentType', p_order.payer_document_type,
      'payerDocumentLast4', v_payer_document_last4
    )
  );
  v_now timestamptz := timezone('utc', now());
begin
  insert into public.payment_checkout_carts (
    payment_order_id,
    order_number,
    order_public_id,
    cart_public_id,
    user_id,
    guild_id,
    scope_type,
    source,
    checkout_surface,
    checkout_step,
    cart_status,
    payment_method,
    plan_code,
    plan_name,
    billing_cycle_days,
    currency,
    amount,
    subtotal_amount,
    coupon_amount,
    gift_card_amount,
    flow_points_amount,
    total_amount,
    coupon_code,
    gift_card_code,
    payer_name,
    payer_document_last4,
    payer_document_type,
    plan_snapshot,
    pricing_snapshot,
    transition_snapshot,
    provider_snapshot,
    customer_snapshot,
    checkout_context,
    opened_at,
    last_seen_at,
    finalized_at
  )
  values (
    p_order.id,
    p_order.order_number,
    v_order_public_id,
    v_cart_public_id,
    p_order.user_id,
    p_order.guild_id,
    v_scope_type,
    v_source,
    v_checkout_surface,
    v_checkout_step,
    v_cart_status,
    p_order.payment_method,
    v_plan_code,
    v_plan_name,
    v_billing_cycle_days,
    coalesce(nullif(btrim(coalesce(p_order.currency, '')), ''), 'BRL'),
    round(greatest(coalesce(p_order.amount, 0), 0)::numeric, 2),
    v_subtotal_amount,
    v_coupon_amount,
    v_gift_card_amount,
    v_flow_points_amount,
    v_total_amount,
    nullif(btrim(coalesce(v_coupon ->> 'code', '')), ''),
    nullif(btrim(coalesce(v_gift_card ->> 'code', '')), ''),
    p_order.payer_name,
    v_payer_document_last4,
    p_order.payer_document_type,
    coalesce(v_plan_snapshot, '{}'::jsonb),
    coalesce(v_pricing, '{}'::jsonb),
    coalesce(v_transition, '{}'::jsonb),
    coalesce(v_provider_snapshot, '{}'::jsonb),
    coalesce(v_customer_snapshot, '{}'::jsonb),
    coalesce(v_provider_payload, '{}'::jsonb),
    coalesce(p_order.created_at, v_now),
    v_now,
    case
      when v_cart_status in ('approved', 'rejected', 'cancelled', 'expired', 'failed')
        then coalesce(p_order.paid_at, p_order.updated_at, v_now)
      else null
    end
  )
  on conflict (payment_order_id) do update
  set
    order_number = excluded.order_number,
    order_public_id = excluded.order_public_id,
    cart_public_id = excluded.cart_public_id,
    user_id = excluded.user_id,
    guild_id = excluded.guild_id,
    scope_type = excluded.scope_type,
    source = excluded.source,
    checkout_surface = excluded.checkout_surface,
    checkout_step = excluded.checkout_step,
    cart_status = excluded.cart_status,
    payment_method = excluded.payment_method,
    plan_code = excluded.plan_code,
    plan_name = excluded.plan_name,
    billing_cycle_days = excluded.billing_cycle_days,
    currency = excluded.currency,
    amount = excluded.amount,
    subtotal_amount = excluded.subtotal_amount,
    coupon_amount = excluded.coupon_amount,
    gift_card_amount = excluded.gift_card_amount,
    flow_points_amount = excluded.flow_points_amount,
    total_amount = excluded.total_amount,
    coupon_code = excluded.coupon_code,
    gift_card_code = excluded.gift_card_code,
    payer_name = excluded.payer_name,
    payer_document_last4 = excluded.payer_document_last4,
    payer_document_type = excluded.payer_document_type,
    plan_snapshot = excluded.plan_snapshot,
    pricing_snapshot = excluded.pricing_snapshot,
    transition_snapshot = excluded.transition_snapshot,
    provider_snapshot = excluded.provider_snapshot,
    customer_snapshot = excluded.customer_snapshot,
    checkout_context = excluded.checkout_context,
    last_seen_at = excluded.last_seen_at,
    finalized_at = case
      when excluded.cart_status in ('approved', 'rejected', 'cancelled', 'expired', 'failed')
        then coalesce(public.payment_checkout_carts.finalized_at, excluded.finalized_at)
      else null
    end;

  if p_snapshot_kind is not null then
    if p_snapshot_kind <> 'backfill'
       or not exists (
         select 1
         from public.payment_order_state_history h
         where h.payment_order_id = p_order.id
           and h.snapshot_kind = 'backfill'
       ) then
      insert into public.payment_order_state_history (
        payment_order_id,
        order_number,
        order_public_id,
        cart_public_id,
        user_id,
        guild_id,
        scope_type,
        payment_method,
        status,
        provider_status,
        provider_status_detail,
        provider_payment_id,
        provider_external_reference,
        amount,
        currency,
        plan_code,
        plan_name,
        billing_cycle_days,
        snapshot_kind,
        snapshot_payload
      )
      values (
        p_order.id,
        p_order.order_number,
        v_order_public_id,
        v_cart_public_id,
        p_order.user_id,
        p_order.guild_id,
        v_scope_type,
        p_order.payment_method,
        p_order.status,
        p_order.provider_status,
        p_order.provider_status_detail,
        p_order.provider_payment_id,
        p_order.provider_external_reference,
        round(greatest(coalesce(p_order.amount, 0), 0)::numeric, 2),
        coalesce(nullif(btrim(coalesce(p_order.currency, '')), ''), 'BRL'),
        v_plan_code,
        v_plan_name,
        v_billing_cycle_days,
        p_snapshot_kind,
        jsonb_strip_nulls(
          jsonb_build_object(
            'checkoutSurface', v_checkout_surface,
            'checkoutOrigin', v_source,
            'plan', v_plan_snapshot,
            'pricing', v_pricing,
            'transition', v_transition,
            'customer', v_customer_snapshot,
            'provider', v_provider_snapshot,
            'providerPayload', v_provider_payload,
            'paidAt', p_order.paid_at,
            'expiresAt', p_order.expires_at
          )
        )
      );
    end if;
  end if;
end;
$$;

create or replace function public.tr_payment_orders_checkout_projection()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.guild_id is not distinct from old.guild_id
       and new.payment_method is not distinct from old.payment_method
       and new.status is not distinct from old.status
       and new.amount is not distinct from old.amount
       and new.currency is not distinct from old.currency
       and new.payer_name is not distinct from old.payer_name
       and new.payer_document is not distinct from old.payer_document
       and new.payer_document_type is not distinct from old.payer_document_type
       and new.provider is not distinct from old.provider
       and new.provider_payment_id is not distinct from old.provider_payment_id
       and new.provider_external_reference is not distinct from old.provider_external_reference
       and new.provider_qr_code is not distinct from old.provider_qr_code
       and new.provider_qr_base64 is not distinct from old.provider_qr_base64
       and new.provider_ticket_url is not distinct from old.provider_ticket_url
       and new.provider_status is not distinct from old.provider_status
       and new.provider_status_detail is not distinct from old.provider_status_detail
       and new.provider_payload is not distinct from old.provider_payload
       and new.plan_code is not distinct from old.plan_code
       and new.plan_name is not distinct from old.plan_name
       and new.plan_billing_cycle_days is not distinct from old.plan_billing_cycle_days
       and new.plan_max_licensed_servers is not distinct from old.plan_max_licensed_servers
       and new.plan_max_active_tickets is not distinct from old.plan_max_active_tickets
       and new.plan_max_automations is not distinct from old.plan_max_automations
       and new.plan_max_monthly_actions is not distinct from old.plan_max_monthly_actions
       and new.order_public_id is not distinct from old.order_public_id
       and new.cart_public_id is not distinct from old.cart_public_id
       and new.scope_type is not distinct from old.scope_type
       and new.checkout_surface is not distinct from old.checkout_surface
       and new.checkout_origin is not distinct from old.checkout_origin
       and new.paid_at is not distinct from old.paid_at
       and new.expires_at is not distinct from old.expires_at then
      return new;
    end if;
  end if;

  perform public.refresh_payment_checkout_projection(new, lower(tg_op));
  return new;
end;
$$;

drop trigger if exists tr_payment_orders_checkout_projection on public.payment_orders;
create trigger tr_payment_orders_checkout_projection
after insert or update on public.payment_orders
for each row
execute function public.tr_payment_orders_checkout_projection();

with ranked_coupon_redemptions as (
  select
    id,
    row_number() over (
      partition by coupon_id, payment_order_id
      order by created_at asc, id asc
    ) as rn
  from public.payment_coupon_redemptions
  where payment_order_id is not null
)
delete from public.payment_coupon_redemptions pcr
using ranked_coupon_redemptions ranked
where pcr.id = ranked.id
  and ranked.rn > 1;

with ranked_gift_card_redemptions as (
  select
    id,
    row_number() over (
      partition by gift_card_id, payment_order_id
      order by created_at asc, id asc
    ) as rn
  from public.payment_gift_card_redemptions
  where payment_order_id is not null
)
delete from public.payment_gift_card_redemptions pgcr
using ranked_gift_card_redemptions ranked
where pgcr.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists idx_payment_coupon_redemptions_coupon_order_unique
on public.payment_coupon_redemptions (coupon_id, payment_order_id)
where payment_order_id is not null;

create unique index if not exists idx_payment_gift_card_redemptions_gift_card_order_unique
on public.payment_gift_card_redemptions (gift_card_id, payment_order_id)
where payment_order_id is not null;

select public.refresh_payment_checkout_projection(po, 'backfill')
from public.payment_orders po;

create or replace view public.payment_checkout_portable_orders_v1 as
select
  po.id as payment_order_id,
  po.order_number,
  po.order_public_id,
  po.cart_public_id,
  po.user_id,
  po.guild_id,
  po.scope_type,
  po.checkout_surface,
  po.checkout_origin,
  po.payment_method,
  po.status,
  po.amount,
  po.currency,
  po.plan_code,
  po.plan_name,
  po.plan_billing_cycle_days,
  po.provider,
  po.provider_payment_id,
  po.provider_external_reference,
  po.provider_status,
  po.provider_status_detail,
  po.paid_at,
  po.expires_at,
  po.created_at,
  po.updated_at,
  pc.cart_status,
  pc.subtotal_amount,
  pc.coupon_amount,
  pc.gift_card_amount,
  pc.flow_points_amount,
  (pc.coupon_amount + pc.gift_card_amount + pc.flow_points_amount) as discount_total_amount,
  pc.total_amount,
  pc.coupon_code,
  pc.gift_card_code,
  pc.plan_snapshot,
  pc.pricing_snapshot,
  pc.transition_snapshot,
  pc.provider_snapshot,
  pc.customer_snapshot,
  pc.checkout_context,
  pc.finalized_at
from public.payment_orders po
left join public.payment_checkout_carts pc
  on pc.payment_order_id = po.id;

commit;
