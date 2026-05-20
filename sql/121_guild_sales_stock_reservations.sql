-- Atomic stock reservations for Discord sales checkout.
-- Prevents a cart from generating a payment for stock that can be consumed by another cart before approval.
-- Safe to run more than once.

alter table if exists public.guild_sales_stock_items
  add column if not exists reserved_cart_id uuid null references public.guild_sales_carts(id) on delete set null,
  add column if not exists reserved_cart_item_id uuid null references public.guild_sales_cart_items(id) on delete set null,
  add column if not exists reserved_unit_index integer null,
  add column if not exists reserved_at timestamptz null,
  add column if not exists reservation_expires_at timestamptz null;

create index if not exists idx_guild_sales_stock_items_reserved_cart
  on public.guild_sales_stock_items (reserved_cart_id, status, reservation_expires_at)
  where reserved_cart_id is not null;

create index if not exists idx_guild_sales_stock_items_expired_reservations
  on public.guild_sales_stock_items (reservation_expires_at)
  where status = 'reserved' and reservation_expires_at is not null;

create unique index if not exists idx_guild_sales_stock_items_reserved_unit_unique
  on public.guild_sales_stock_items (reserved_cart_id, reserved_cart_item_id, reserved_unit_index)
  where status = 'reserved'
    and reserved_cart_id is not null
    and reserved_cart_item_id is not null
    and reserved_unit_index is not null;

create or replace function public.release_expired_guild_sales_stock_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer := 0;
begin
  create temporary table if not exists pg_temp.guild_sales_stock_reservations_to_sync (
    guild_id text not null,
    product_id uuid not null,
    primary key (guild_id, product_id)
  ) on commit drop;

  truncate table pg_temp.guild_sales_stock_reservations_to_sync;

  insert into pg_temp.guild_sales_stock_reservations_to_sync (guild_id, product_id)
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
  where status = 'reserved'
    and reservation_expires_at is not null
    and reservation_expires_at <= timezone('utc', now())
  on conflict do nothing;

  update public.guild_sales_stock_items
  set
    status = 'available',
    reserved_cart_id = null,
    reserved_cart_item_id = null,
    reserved_unit_index = null,
    reserved_at = null,
    reservation_expires_at = null
  where status = 'reserved'
    and reservation_expires_at is not null
    and reservation_expires_at <= timezone('utc', now());

  get diagnostics v_released = row_count;

  perform public.sync_guild_sales_product_stock_quantity(sync.guild_id, sync.product_id)
  from pg_temp.guild_sales_stock_reservations_to_sync sync;

  return v_released;
end;
$$;

create or replace function public.reserve_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_cart_id uuid,
  p_cart_item_id uuid,
  p_unit_index integer,
  p_reservation_expires_at timestamptz,
  p_preferred_delivery_method text default null
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
  v_reserved public.guild_sales_stock_items%rowtype;
begin
  if p_preferred_delivery_method is not null
    and p_preferred_delivery_method not in ('email', 'discord_dm', 'flowdesk_link')
  then
    raise exception 'Metodo de entrega invalido.';
  end if;

  perform public.release_expired_guild_sales_stock_reservations();

  select *
  into v_reserved
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and reserved_cart_id = p_cart_id
    and reserved_cart_item_id = p_cart_item_id
    and reserved_unit_index = p_unit_index
    and status = 'reserved'
    and quantity > 0
  for update
  limit 1;

  if found then
    update public.guild_sales_stock_items
    set reservation_expires_at = greatest(
      coalesce(reservation_expires_at, p_reservation_expires_at),
      p_reservation_expires_at
    )
    where id = v_reserved.id
    returning *
    into v_reserved;

    return next v_reserved;
    return;
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

  if v_item.quantity > 1 then
    update public.guild_sales_stock_items
    set quantity = greatest(0, v_item.quantity - 1)
    where id = v_item.id;

    insert into public.guild_sales_stock_items (
      guild_id,
      product_id,
      product_name,
      item_type,
      delivery_method,
      status,
      category,
      platform,
      provider,
      email,
      login,
      password,
      access_type,
      recovery,
      gift_card_name,
      redemption_value,
      redemption_code,
      access_link,
      link_password,
      region,
      validity,
      quantity,
      server,
      buyer_required_id,
      delivery_deadline,
      service_type,
      required_buyer_info,
      discord_product_type,
      server_or_bot_link,
      token_or_key,
      required_permissions,
      tool_name,
      automation_type,
      software_name,
      software_version,
      operating_system,
      license_key,
      download_link,
      subscription_duration,
      account_type,
      course_name,
      item_name,
      instructions,
      observations,
      payload,
      configured_by_user_id,
      reserved_cart_id,
      reserved_cart_item_id,
      reserved_unit_index,
      reserved_at,
      reservation_expires_at
    )
    values (
      v_item.guild_id,
      v_item.product_id,
      v_item.product_name,
      v_item.item_type,
      v_item.delivery_method,
      'reserved',
      v_item.category,
      v_item.platform,
      v_item.provider,
      v_item.email,
      v_item.login,
      v_item.password,
      v_item.access_type,
      v_item.recovery,
      v_item.gift_card_name,
      v_item.redemption_value,
      v_item.redemption_code,
      v_item.access_link,
      v_item.link_password,
      v_item.region,
      v_item.validity,
      1,
      v_item.server,
      v_item.buyer_required_id,
      v_item.delivery_deadline,
      v_item.service_type,
      v_item.required_buyer_info,
      v_item.discord_product_type,
      v_item.server_or_bot_link,
      v_item.token_or_key,
      v_item.required_permissions,
      v_item.tool_name,
      v_item.automation_type,
      v_item.software_name,
      v_item.software_version,
      v_item.operating_system,
      v_item.license_key,
      v_item.download_link,
      v_item.subscription_duration,
      v_item.account_type,
      v_item.course_name,
      v_item.item_name,
      v_item.instructions,
      v_item.observations,
      v_item.payload,
      v_item.configured_by_user_id,
      p_cart_id,
      p_cart_item_id,
      p_unit_index,
      timezone('utc', now()),
      p_reservation_expires_at
    )
    returning *
    into v_reserved;
  else
    update public.guild_sales_stock_items
    set
      status = 'reserved',
      reserved_cart_id = p_cart_id,
      reserved_cart_item_id = p_cart_item_id,
      reserved_unit_index = p_unit_index,
      reserved_at = timezone('utc', now()),
      reservation_expires_at = p_reservation_expires_at
    where id = v_item.id
    returning *
    into v_reserved;
  end if;

  perform public.sync_guild_sales_product_stock_quantity(p_guild_id, p_product_id);
  return next v_reserved;
end;
$$;

create or replace function public.claim_reserved_guild_sales_stock_item(
  p_guild_id text,
  p_product_id uuid,
  p_cart_id uuid,
  p_cart_item_id uuid,
  p_unit_index integer
)
returns setof public.guild_sales_stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.guild_sales_stock_items%rowtype;
begin
  select *
  into v_item
  from public.guild_sales_stock_items
  where guild_id = p_guild_id
    and product_id = p_product_id
    and reserved_cart_id = p_cart_id
    and reserved_cart_item_id = p_cart_item_id
    and reserved_unit_index = p_unit_index
    and (
      (status = 'reserved' and quantity > 0)
      or status = 'delivered'
    )
  for update
  limit 1;

  if not found then
    return;
  end if;

  if v_item.status = 'delivered' then
    return next v_item;
    return;
  end if;

  update public.guild_sales_stock_items
  set
    quantity = 0,
    status = 'delivered'
  where id = v_item.id;

  perform public.sync_guild_sales_product_stock_quantity(p_guild_id, p_product_id);
  return next v_item;
end;
$$;

create or replace function public.release_guild_sales_stock_reservations(
  p_cart_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released integer := 0;
begin
  create temporary table if not exists pg_temp.guild_sales_stock_reservations_to_sync (
    guild_id text not null,
    product_id uuid not null,
    primary key (guild_id, product_id)
  ) on commit drop;

  truncate table pg_temp.guild_sales_stock_reservations_to_sync;

  insert into pg_temp.guild_sales_stock_reservations_to_sync (guild_id, product_id)
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
  where reserved_cart_id = p_cart_id
    and status = 'reserved'
    and quantity > 0
  on conflict do nothing;

  update public.guild_sales_stock_items
  set
    status = 'available',
    reserved_cart_id = null,
    reserved_cart_item_id = null,
    reserved_unit_index = null,
    reserved_at = null,
    reservation_expires_at = null
  where reserved_cart_id = p_cart_id
    and status = 'reserved'
    and quantity > 0;

  get diagnostics v_released = row_count;

  perform public.sync_guild_sales_product_stock_quantity(sync.guild_id, sync.product_id)
  from pg_temp.guild_sales_stock_reservations_to_sync sync;

  return v_released;
end;
$$;

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

  perform public.release_expired_guild_sales_stock_reservations();

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

  perform public.sync_guild_sales_product_stock_quantity(p_guild_id, p_product_id);
  return next v_item;
end;
$$;

select public.release_expired_guild_sales_stock_reservations();
select public.sync_guild_sales_product_stock_quantity(stock.guild_id, stock.product_id)
from (
  select distinct guild_id, product_id
  from public.guild_sales_stock_items
) stock;

comment on function public.reserve_guild_sales_stock_item(text, uuid, uuid, uuid, integer, timestamptz, text) is 'Reserves one available digital stock unit for a cart item/unit before payment is created.';
comment on function public.claim_reserved_guild_sales_stock_item(text, uuid, uuid, uuid, integer) is 'Consumes a stock unit previously reserved for a cart item/unit after payment approval.';
comment on function public.release_guild_sales_stock_reservations(uuid) is 'Releases pending stock reservations for an unpaid or failed sales cart.';
comment on function public.release_expired_guild_sales_stock_reservations() is 'Releases expired pending stock reservations and returns the number of released rows.';
