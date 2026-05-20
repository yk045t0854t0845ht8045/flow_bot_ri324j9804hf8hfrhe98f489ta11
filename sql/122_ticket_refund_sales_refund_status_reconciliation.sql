-- Reconcile sales carts after provider refunds.
-- Safe to run more than once.

alter table public.guild_sales_carts
  drop constraint if exists guild_sales_carts_status_check;

alter table public.guild_sales_carts
  add constraint guild_sales_carts_status_check
  check (
    status in (
      'link_required',
      'open',
      'payment_pending',
      'paid',
      'delivered',
      'delivery_failed',
      'rejected',
      'cancelled',
      'expired',
      'refunded',
      'charged_back'
    )
  );

update public.guild_sales_carts
set
  status = 'refunded',
  provider_status = coalesce(provider_status, 'refunded'),
  provider_status_detail = coalesce(nullif(provider_status_detail, ''), 'ticket_ai_refund')
where status <> 'refunded'
  and (
    lower(coalesce(provider_status, '')) = 'refunded'
    or lower(coalesce(provider_status_detail, '')) like '%refund%'
    or lower(coalesce(provider_status_detail, '')) like '%reembols%'
  );

update public.guild_sales_carts
set status = 'charged_back'
where status <> 'charged_back'
  and lower(coalesce(provider_status, '')) = 'charged_back';

comment on constraint guild_sales_carts_status_check
on public.guild_sales_carts
is 'Allows paid sales carts to move into explicit refunded and charged_back terminal states instead of being collapsed into cancelled.';
