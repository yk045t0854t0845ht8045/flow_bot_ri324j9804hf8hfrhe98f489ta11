create table if not exists public.guild_plan_settings (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  guild_id text not null,
  plan_code text not null default 'pro',
  monthly_amount numeric(10,2) not null default 9.99 check (monthly_amount > 0),
  currency text not null default 'BRL',
  recurring_enabled boolean not null default false,
  recurring_method_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint guild_plan_settings_plan_code_check check (plan_code in ('pro')),
  constraint guild_plan_settings_unique_user_guild unique (user_id, guild_id)
);

create index if not exists idx_guild_plan_settings_user_guild
on public.guild_plan_settings (user_id, guild_id);

create index if not exists idx_guild_plan_settings_recurring_enabled
on public.guild_plan_settings (recurring_enabled);

drop trigger if exists tr_guild_plan_settings_updated_at on public.guild_plan_settings;
create trigger tr_guild_plan_settings_updated_at
before update on public.guild_plan_settings
for each row
execute function public.set_updated_at();

