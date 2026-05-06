-- Hardening for Discord sales checkout, stock claiming, order events and receipts.
-- Safe to run more than once.

alter table public.guild_sales_carts
add column if not exists customer_email text null,
add column if not exists customer_name text null,
add column if not exists delivery_started_at timestamptz null,
add column if not exists delivery_lock_error text not null default '',
add column if not exists receipt_email_sent_at timestamptz null,
add column if not exists receipt_email_error text not null default '',
add column if not exists discord_notification_sent_at timestamptz null,
add column if not exists discord_notification_error text not null default '';

create index if not exists idx_guild_sales_carts_receipt_pending
on public.guild_sales_carts (status, paid_at)
where receipt_email_sent_at is null;

create index if not exists idx_guild_sales_carts_delivery_pending
on public.guild_sales_carts (status, paid_at)
where delivery_started_at is null;

with ranked_open_carts as (
  select
    id,
    row_number() over (
      partition by guild_id, discord_user_id
      order by created_at desc, id desc
    ) as rn
  from public.guild_sales_carts
  where status in ('link_required', 'open')
)
update public.guild_sales_carts cart
set
  status = 'cancelled',
  cancelled_at = coalesce(cart.cancelled_at, timezone('utc', now()))
from ranked_open_carts ranked
where cart.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists idx_guild_sales_carts_one_open_per_user
on public.guild_sales_carts (guild_id, discord_user_id)
where status in ('link_required', 'open');

alter table public.guild_sales_order_deliveries
add column if not exists cart_item_id uuid null references public.guild_sales_cart_items(id) on delete set null,
add column if not exists unit_index integer null,
add column if not exists idempotency_key text not null default '';

create unique index if not exists idx_guild_sales_order_deliveries_idempotency
on public.guild_sales_order_deliveries (idempotency_key)
where idempotency_key <> '';

create table if not exists public.guild_sales_order_events (
  id bigint generated always as identity primary key,
  cart_id uuid not null references public.guild_sales_carts(id) on delete cascade,
  guild_id text not null,
  auth_user_id bigint null references public.auth_users(id) on delete set null,
  discord_user_id text not null,
  event_type text not null,
  event_key text not null default '',
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_order_events_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_order_events_discord_user_id_check
    check (discord_user_id ~ '^[0-9]{10,25}$')
);

create index if not exists idx_guild_sales_order_events_cart_created
on public.guild_sales_order_events (cart_id, created_at desc);

create index if not exists idx_guild_sales_order_events_guild_created
on public.guild_sales_order_events (guild_id, created_at desc);

create unique index if not exists idx_guild_sales_order_events_cart_event_key
on public.guild_sales_order_events (cart_id, event_key)
where event_key <> '';

alter table public.guild_sales_order_events enable row level security;

drop policy if exists "service_role_all_guild_sales_order_events" on public.guild_sales_order_events;
create policy "service_role_all_guild_sales_order_events"
on public.guild_sales_order_events
for all
to service_role
using (true)
with check (true);

create or replace function public.claim_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_preferred_delivery_method text default null
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
begin
  if p_preferred_delivery_method is not null
    and p_preferred_delivery_method not in ('email', 'discord_dm', 'flowdesk_link')
  then
    raise exception 'Metodo de entrega invalido.';
  end if;

  select *
  into v_item
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and status = 'available'
    and quantity > 0
    and (
      p_preferred_delivery_method is null
      or delivery_method = p_preferred_delivery_method
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.guild_sales_stock_items
  set
    quantity = greatest(0, v_item.quantity - 1),
    status = case when v_item.quantity - 1 > 0 then 'available' else 'delivered' end
  where id = v_item.id;

  update public.guild_sales_products
  set stock_quantity = coalesce(
    (
      select sum(gssi.quantity)::integer
      from public.guild_sales_stock_items gssi
      where gssi.guild_id = p_guild_id
        and gssi.product_id = p_product_id
        and gssi.status = 'available'
    ),
    0
  )
  where guild_id = p_guild_id
    and id = p_product_id;

  return next v_item;
end;
$$;

create or replace function public.sync_guild_sales_product_stock_quantity(
  p_guild_id text,
  p_product_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quantity integer;
begin
  select coalesce(sum(gssi.quantity), 0)::integer
  into v_quantity
  from public.guild_sales_stock_items gssi
  where gssi.guild_id = p_guild_id
    and gssi.product_id = p_product_id
    and gssi.status = 'available';

  update public.guild_sales_products
  set stock_quantity = greatest(0, v_quantity)
  where guild_id = p_guild_id
    and id = p_product_id
    and inventory_tracked is not false;

  return greatest(0, v_quantity);
end;
$$;

create or replace function public.tr_sync_guild_sales_product_stock_quantity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.sync_guild_sales_product_stock_quantity(old.guild_id, old.product_id);
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    perform public.sync_guild_sales_product_stock_quantity(new.guild_id, new.product_id);
  end if;

  return coalesce(new, old);
end;
$$;

create or replace function public.tr_normalize_guild_sales_stock_item_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.quantity > 0 and new.status = 'delivered' then
    new.status = 'available';
  elsif new.quantity = 0 and new.status = 'available' then
    new.status = 'delivered';
  end if;

  return new;
end;
$$;

drop trigger if exists tr_guild_sales_stock_items_normalize_status
on public.guild_sales_stock_items;
create trigger tr_guild_sales_stock_items_normalize_status
before insert or update of quantity, status on public.guild_sales_stock_items
for each row
execute function public.tr_normalize_guild_sales_stock_item_status();

drop trigger if exists tr_guild_sales_stock_items_sync_product_quantity
on public.guild_sales_stock_items;
create trigger tr_guild_sales_stock_items_sync_product_quantity
after insert or update or delete on public.guild_sales_stock_items
for each row
execute function public.tr_sync_guild_sales_product_stock_quantity();

create or replace function public.acquire_guild_sales_cart_delivery_lock(
  p_cart_id uuid
)
returns public.guild_sales_carts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cart public.guild_sales_carts%rowtype;
begin
  update public.guild_sales_carts
  set
    delivery_started_at = timezone('utc', now()),
    delivery_lock_error = ''
  where id = p_cart_id
    and (
      delivery_started_at is null
      or delivery_started_at < timezone('utc', now()) - interval '10 minutes'
    )
    and delivered_at is null
    and status in ('paid', 'payment_pending')
  returning *
  into v_cart;

  if not found then
    return null;
  end if;

  return v_cart;
end;
$$;

select public.sync_guild_sales_product_stock_quantity(product.guild_id, product.product_id)
from (
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
) product;

comment on table public.guild_sales_order_events is 'Auditoria de eventos do pedido de venda Discord: pagamento, entrega, recibo e falhas operacionais.';
comment on function public.claim_guild_sales_stock_item(text, uuid, text) is 'Reserva atomicamente uma unidade disponivel de estoque digital para entrega.';
comment on function public.sync_guild_sales_product_stock_quantity(text, uuid) is 'Recalcula o estoque publicado do produto a partir das unidades digitais disponiveis.';
comment on function public.tr_normalize_guild_sales_stock_item_status() is 'Mantem status e quantidade do estoque digital coerentes antes de recalcular o estoque do produto.';
comment on function public.acquire_guild_sales_cart_delivery_lock(uuid) is 'Adquire trava idempotente para impedir entrega duplicada do mesmo carrinho.';
