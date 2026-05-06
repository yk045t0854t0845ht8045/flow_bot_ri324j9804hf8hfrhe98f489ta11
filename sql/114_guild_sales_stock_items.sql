-- Digital stock items and delivery metadata for sales products.
-- Safe to run more than once.

create table if not exists public.guild_sales_stock_items (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  product_id uuid not null references public.guild_sales_products(id) on delete cascade,
  product_name text not null default '',
  item_type text not null default 'digital_services',
  delivery_method text not null default 'flowdesk_link',
  status text not null default 'available',
  category text not null default '',
  platform text not null default '',
  provider text not null default '',
  email text not null default '',
  login text not null default '',
  password text not null default '',
  access_type text not null default '',
  recovery text not null default '',
  gift_card_name text not null default '',
  redemption_value text not null default '',
  redemption_code text not null default '',
  access_link text not null default '',
  link_password text not null default '',
  region text not null default '',
  validity text not null default '',
  quantity integer not null default 1,
  server text not null default '',
  buyer_required_id text not null default '',
  delivery_deadline text not null default '',
  service_type text not null default '',
  required_buyer_info text not null default '',
  discord_product_type text not null default '',
  server_or_bot_link text not null default '',
  token_or_key text not null default '',
  required_permissions text not null default '',
  tool_name text not null default '',
  automation_type text not null default '',
  software_name text not null default '',
  software_version text not null default '',
  operating_system text not null default '',
  license_key text not null default '',
  download_link text not null default '',
  subscription_duration text not null default '',
  account_type text not null default '',
  course_name text not null default '',
  item_name text not null default '',
  instructions text not null default '',
  observations text not null default '',
  payload jsonb not null default '{}'::jsonb,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_stock_items_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_stock_items_delivery_method_check
    check (delivery_method in ('email', 'discord_dm', 'flowdesk_link')),
  constraint guild_sales_stock_items_status_check
    check (status in ('available', 'reserved', 'delivered', 'disabled')),
  constraint guild_sales_stock_items_quantity_check
    check (quantity >= 0),
  constraint guild_sales_stock_items_item_type_check
    check (item_type in (
      'accounts_access',
      'emails',
      'gift_cards_codes',
      'virtual_currency',
      'game_items',
      'game_services',
      'premium_subscriptions',
      'artificial_intelligence',
      'discord_bots',
      'social_networks',
      'software_licenses',
      'courses_training',
      'digital_links',
      'digital_services',
      'freelancer',
      'other'
    ))
);

create index if not exists idx_guild_sales_stock_items_product_status
on public.guild_sales_stock_items (guild_id, product_id, status, created_at desc);

create index if not exists idx_guild_sales_stock_items_product_delivery
on public.guild_sales_stock_items (product_id, delivery_method, item_type);

drop trigger if exists tr_guild_sales_stock_items_updated_at on public.guild_sales_stock_items;
create trigger tr_guild_sales_stock_items_updated_at
before update on public.guild_sales_stock_items
for each row
execute function public.set_updated_at();

alter table public.guild_sales_stock_items enable row level security;

drop policy if exists "service_role_all_guild_sales_stock_items" on public.guild_sales_stock_items;
create policy "service_role_all_guild_sales_stock_items"
on public.guild_sales_stock_items
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_stock_items is 'Estoque digital por produto com campos separados para entrega automatica.';
