create table if not exists public.guild_sales_categories (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  title text not null,
  description text not null default '',
  collection_type text not null default 'manual',
  image_url text null,
  theme_model text not null default 'default',
  published_virtual_store boolean not null default true,
  published_point_of_sale boolean not null default false,
  seo_title text not null default '',
  seo_description text not null default '',
  products_count integer not null default 0,
  active boolean not null default true,
  sort_order integer not null default 0,
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_sales_categories_guild_id_check
    check (guild_id ~ '^[0-9]{10,25}$'),
  constraint guild_sales_categories_title_check
    check (char_length(trim(title)) between 2 and 90),
  constraint guild_sales_categories_description_check
    check (char_length(description) <= 1200),
  constraint guild_sales_categories_collection_type_check
    check (collection_type in ('manual', 'smart')),
  constraint guild_sales_categories_theme_model_check
    check (theme_model in ('default', 'compact', 'featured')),
  constraint guild_sales_categories_products_count_check
    check (products_count >= 0)
);

create index if not exists idx_guild_sales_categories_guild_sort
on public.guild_sales_categories (guild_id, active desc, sort_order asc, created_at desc);

create index if not exists idx_guild_sales_categories_configured_by_user
on public.guild_sales_categories (configured_by_user_id, guild_id, updated_at desc);

drop trigger if exists tr_guild_sales_categories_updated_at on public.guild_sales_categories;
create trigger tr_guild_sales_categories_updated_at
before update on public.guild_sales_categories
for each row
execute function public.set_updated_at();

alter table public.guild_sales_categories enable row level security;

drop policy if exists "service_role_all_guild_sales_categories" on public.guild_sales_categories;
create policy "service_role_all_guild_sales_categories"
on public.guild_sales_categories
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_categories is 'Categorias/colecoes de vendas por servidor, prontas para Discord e futura vitrine web.';
comment on column public.guild_sales_categories.collection_type is 'manual: produtos escolhidos um a um; smart: futura regra automatica.';
comment on column public.guild_sales_categories.published_virtual_store is 'Define se a categoria aparece na futura loja web.';
comment on column public.guild_sales_categories.published_point_of_sale is 'Define se a categoria aparece em canais de venda assistidos.';
