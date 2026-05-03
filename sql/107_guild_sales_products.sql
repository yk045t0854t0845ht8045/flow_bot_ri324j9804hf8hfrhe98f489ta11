create table if not exists public.guild_sales_products (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  title text not null,
  description text not null default '',
  category_id uuid null references public.guild_sales_categories(id) on delete set null,
  status text not null default 'active',
  media_urls jsonb not null default '[]'::jsonb,
  price_amount numeric(12,2) not null default 0,
  compare_at_price_amount numeric(12,2) null,
  unit_price_amount numeric(12,2) null,
  charge_taxes boolean not null default true,
  cost_per_item_amount numeric(12,2) null,
  inventory_tracked boolean not null default true,
  stock_quantity integer not null default 0,
  sku text not null default '',
  barcode text not null default '',
  barcode_mode text not null default 'auto',
  product_type text not null default '',
  manufacturer text not null default '',
  tags text[] not null default '{}',
  theme_model text not null default 'default',
  published_virtual_store boolean not null default true,
  published_point_of_sale boolean not null default true,
  published_pinterest boolean not null default false,
  active boolean not null default true,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_products_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_products_title_check
    check (char_length(trim(title)) between 2 and 120),
  constraint guild_sales_products_description_check
    check (char_length(description) <= 1800),
  constraint guild_sales_products_status_check
    check (status in ('active', 'draft', 'archived')),
  constraint guild_sales_products_theme_model_check
    check (theme_model in ('default', 'compact', 'featured')),
  constraint guild_sales_products_barcode_mode_check
    check (barcode_mode in ('auto', 'manual')),
  constraint guild_sales_products_price_check
    check (price_amount >= 0 and coalesce(compare_at_price_amount, 0) >= 0 and coalesce(unit_price_amount, 0) >= 0 and coalesce(cost_per_item_amount, 0) >= 0),
  constraint guild_sales_products_stock_check
    check (stock_quantity >= 0)
);

create index if not exists idx_guild_sales_products_guild_status_created
on public.guild_sales_products (guild_id, status, created_at desc);

create index if not exists idx_guild_sales_products_category_created
on public.guild_sales_products (category_id, created_at desc)
where category_id is not null;

create index if not exists idx_guild_sales_products_configured_by_user
on public.guild_sales_products (configured_by_user_id, guild_id, updated_at desc);

drop trigger if exists tr_guild_sales_products_updated_at on public.guild_sales_products;
create trigger tr_guild_sales_products_updated_at
before update on public.guild_sales_products
for each row
execute function public.set_updated_at();

alter table public.guild_sales_products enable row level security;

drop policy if exists "service_role_all_guild_sales_products" on public.guild_sales_products;
create policy "service_role_all_guild_sales_products"
on public.guild_sales_products
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_products is 'Produtos de vendas por servidor, prontos para Discord e futura vitrine web.';
comment on column public.guild_sales_products.sku is 'Codigo interno do produto. Pode ser gerado automaticamente pelo painel e editado manualmente.';
comment on column public.guild_sales_products.barcode is 'Codigo de barras do produto. Pode ser automatico ou preenchido manualmente.';
