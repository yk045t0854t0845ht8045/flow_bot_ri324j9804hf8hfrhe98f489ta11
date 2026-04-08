begin;

alter table public.payment_coupons
  drop constraint if exists payment_coupons_discount_value_check;

alter table public.payment_coupons
  add constraint payment_coupons_discount_value_check
  check (discount_value >= 0);

insert into public.payment_coupons (
  code,
  label,
  description,
  status,
  discount_type,
  discount_value,
  metadata
)
values (
  'BETA',
  'Programa Beta',
  'Ativa o status beta da conta sem alterar o valor do checkout. Mantem o Flow PRO mensal em R$ 9,99 para a conta beta.',
  'active',
  'fixed',
  0.00,
  jsonb_build_object(
    'betaProgram', true,
    'onePerUser', true,
    'allowedPlanCodes', jsonb_build_array('pro'),
    'allowedBillingPeriodCodes', jsonb_build_array('monthly'),
    'pinnedMonthlyAmount', 9.99
  )
)
on conflict (code) do update
set
  label = excluded.label,
  description = excluded.description,
  status = excluded.status,
  discount_type = excluded.discount_type,
  discount_value = excluded.discount_value,
  metadata = excluded.metadata,
  updated_at = timezone('utc', now());

commit;
