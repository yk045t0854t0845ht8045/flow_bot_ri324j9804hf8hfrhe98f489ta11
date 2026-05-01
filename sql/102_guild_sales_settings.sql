create table if not exists public.guild_sales_settings (
  id bigint generated always as identity primary key,
  guild_id text not null unique,
  enabled boolean not null default false,
  carts_category_id text null,
  payment_approved_log_channel_id text null,
  payment_pending_log_channel_id text null,
  payment_rejected_log_channel_id text null,
  receipt_company_name text not null default '',
  receipt_company_document text not null default '',
  receipt_support_text text not null default '',
  configured_by_user_id bigint not null references public.auth_users(id) on delete restrict,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists idx_guild_sales_settings_configured_by_user_guild_updated_at
on public.guild_sales_settings (configured_by_user_id, guild_id, updated_at desc);

drop trigger if exists tr_guild_sales_settings_updated_at on public.guild_sales_settings;
create trigger tr_guild_sales_settings_updated_at
before update on public.guild_sales_settings
for each row
execute function public.set_updated_at();

alter table public.guild_sales_settings enable row level security;

drop policy if exists "service_role_all_guild_sales_settings" on public.guild_sales_settings;
create policy "service_role_all_guild_sales_settings"
on public.guild_sales_settings
for all
to service_role
using (true)
with check (true);

comment on table public.guild_sales_settings is 'Configuracoes base do modulo de vendas por servidor.';
comment on column public.guild_sales_settings.carts_category_id is 'Categoria onde os canais de carrinho serao criados.';
comment on column public.guild_sales_settings.payment_approved_log_channel_id is 'Canal de log para pagamentos aprovados.';
comment on column public.guild_sales_settings.payment_pending_log_channel_id is 'Canal de log para pagamentos pendentes.';
comment on column public.guild_sales_settings.payment_rejected_log_channel_id is 'Canal de log para pagamentos recusados.';
comment on column public.guild_sales_settings.receipt_company_name is 'Nome da empresa exibido no comprovante.';
