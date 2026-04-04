create table if not exists public.auth_user_payment_methods (
  id bigint generated always as identity primary key,
  user_id bigint not null references public.auth_users(id) on delete cascade,
  method_id text not null,
  nickname text,
  brand text,
  first_six text not null,
  last_four text not null,
  exp_month smallint,
  exp_year smallint,
  provider text not null default 'mercado_pago',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint auth_user_payment_methods_unique unique (user_id, method_id),
  constraint auth_user_payment_methods_first_six_check check (first_six ~ '^[0-9]{6}$'),
  constraint auth_user_payment_methods_last_four_check check (last_four ~ '^[0-9]{4}$'),
  constraint auth_user_payment_methods_exp_month_check check (exp_month is null or exp_month between 1 and 12),
  constraint auth_user_payment_methods_exp_year_check check (exp_year is null or exp_year between 0 and 9999)
);

create index if not exists idx_auth_user_payment_methods_user_id
on public.auth_user_payment_methods (user_id);

create index if not exists idx_auth_user_payment_methods_is_active
on public.auth_user_payment_methods (is_active);

create index if not exists idx_auth_user_payment_methods_user_active
on public.auth_user_payment_methods (user_id, is_active);

create index if not exists idx_auth_user_payment_methods_method_id
on public.auth_user_payment_methods (method_id);

drop trigger if exists tr_auth_user_payment_methods_updated_at on public.auth_user_payment_methods;
create trigger tr_auth_user_payment_methods_updated_at
before update on public.auth_user_payment_methods
for each row
execute function public.set_updated_at();

