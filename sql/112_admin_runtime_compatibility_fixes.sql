-- Runtime compatibility fixes for admin dashboard.
-- Safe to run more than once.

do $$
begin
  if to_regtype('public.ticket_status') is not null then
    alter type public.ticket_status add value if not exists 'pending';
    alter type public.ticket_status add value if not exists 'review';
    alter type public.ticket_status add value if not exists 'resolved';
  else
    raise notice 'Skipping missing enum: public.ticket_status';
  end if;

  if to_regclass('public.tickets') is not null then
    alter table public.tickets
      add column if not exists opened_reason text not null default '';
  else
    raise notice 'Skipping missing table: public.tickets';
  end if;

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

  if to_regclass('public.guild_sales_categories') is not null then
    alter table public.guild_sales_categories
      add column if not exists discord_publication_mode text not null default 'online_only',
      add column if not exists discord_channel_id text null;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_categories_discord_publication_mode_check'
        and conrelid = 'public.guild_sales_categories'::regclass
    ) then
      alter table public.guild_sales_categories
        add constraint guild_sales_categories_discord_publication_mode_check
        check (discord_publication_mode in ('online_only', 'channel'));
    end if;

    if not exists (
      select 1
      from pg_constraint
      where conname = 'guild_sales_categories_discord_channel_id_check'
        and conrelid = 'public.guild_sales_categories'::regclass
    ) then
      alter table public.guild_sales_categories
        add constraint guild_sales_categories_discord_channel_id_check
        check (discord_channel_id is null or discord_channel_id ~ '^[0-9]{10,25}$');
    end if;

    create index if not exists idx_guild_sales_categories_discord_channel
      on public.guild_sales_categories (guild_id, discord_channel_id)
      where discord_channel_id is not null;
  else
    raise notice 'Skipping missing table: public.guild_sales_categories';
  end if;

  if to_regclass('public.admin_sessions') is not null then
    create unique index if not exists admin_sessions_auth_session_id_key
      on public.admin_sessions (auth_session_id);
  else
    raise notice 'Skipping missing table: public.admin_sessions';
  end if;
end
$$;
