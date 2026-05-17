create table if not exists public.guild_ticket_refund_settings (
  guild_id text primary key,
  enabled boolean not null default true,
  refund_limit_days integer not null default 7 check (refund_limit_days >= 0 and refund_limit_days <= 365),
  refund_rules text not null default '',
  auto_process_enabled boolean not null default false,
  manual_approval_required boolean not null default true,
  approval_channel_id text,
  approver_role_ids text[] not null default '{}',
  success_message text not null default '',
  error_message text not null default '',
  configured_by_user_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists guild_ticket_refund_settings_updated_idx
  on public.guild_ticket_refund_settings (updated_at desc);

alter table public.guild_ticket_refund_settings enable row level security;

drop policy if exists "guild_ticket_refund_settings_service_role_all"
  on public.guild_ticket_refund_settings;

create policy "guild_ticket_refund_settings_service_role_all"
  on public.guild_ticket_refund_settings
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.set_guild_ticket_refund_settings_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists guild_ticket_refund_settings_updated_at
  on public.guild_ticket_refund_settings;

create trigger guild_ticket_refund_settings_updated_at
  before update on public.guild_ticket_refund_settings
  for each row
  execute function public.set_guild_ticket_refund_settings_updated_at();
