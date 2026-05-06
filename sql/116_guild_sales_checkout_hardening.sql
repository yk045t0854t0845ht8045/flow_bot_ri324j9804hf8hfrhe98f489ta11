-- Hardening for Discord sales checkout, stock claiming, order events and receipts.
-- Safe to run more than once.

alter table public.guild_sales_carts
add column if not exists customer_email text null,
add column if not exists customer_name text null,
add column if not exists receipt_email_sent_at timestamptz null,
add column if not exists receipt_email_error text not null default '',
add column if not exists discord_notification_sent_at timestamptz null,
add column if not exists discord_notification_error text not null default '';

create index if not exists idx_guild_sales_carts_receipt_pending
on public.guild_sales_carts (status, paid_at)
where receipt_email_sent_at is null;

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

comment on table public.guild_sales_order_events is 'Auditoria de eventos do pedido de venda Discord: pagamento, entrega, recibo e falhas operacionais.';
comment on function public.claim_guild_sales_stock_item(text, uuid, text) is 'Reserva atomicamente uma unidade disponivel de estoque digital para entrega.';
