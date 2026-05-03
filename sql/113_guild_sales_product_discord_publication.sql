-- Discord publication fields for sales products.
-- Safe to run more than once.

do $$
begin
  if to_regclass('public.guild_sales_products') is not null then
    alter table public.guild_sales_products
      add column if not exists discord_publication_mode text not null default 'online_only',
      add column if not exists discord_channel_id text null,
      add column if not exists discord_message_id text null,
      add column if not exists discord_last_synced_at timestamptz null,
      add column if not exists discord_sync_status text not null default 'idle',
      add column if not exists discord_sync_error text null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_publication_mode_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_publication_mode_check
        check (discord_publication_mode in ('online_only', 'channel'));
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_channel_id_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_channel_id_check
        check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$');
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_message_id_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_message_id_check
        check (discord_message_id is null or discord_message_id ~ '^[0-9]{10,25}$');
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_products_discord_sync_status_check'
        and conrelid = 'public.guild_sales_products'::regclass
    ) then
      alter table public.guild_sales_products
        add constraint guild_sales_products_discord_sync_status_check
        check (discord_sync_status in ('idle', 'synced', 'failed'));
    end if;

    create index if not exists idx_guild_sales_products_discord_channel
      on public.guild_sales_products (guild_id, discord_channel_id)
      where discord_channel_id is not null;
  else
    raise notice 'Skipping missing table: public.guild_sales_products';
  end if;
end
$$;

