-- MANUTENCAO OPERACIONAL APENAS.
-- NUNCA use este arquivo em bootstrap, migracao nova ou portabilidade.
-- Reset completo de plano/pagamentos para a conta do user_id = 1.
-- Protegido por validacao do discord_user_id informado.
-- Ajuste os dois valores abaixo se quiser reutilizar para outra conta.

begin;

do $$
declare
  v_user_id bigint := 1;
  v_expected_discord_user_id text := '1183873738375188500';
  v_found_discord_user_id text;
begin
  select au.discord_user_id
    into v_found_discord_user_id
    from public.auth_users au
   where au.id = v_user_id;

  if v_found_discord_user_id is null then
    raise exception 'auth_users.id=% nao encontrado.', v_user_id;
  end if;

  if v_found_discord_user_id <> v_expected_discord_user_id then
    raise exception
      'Discord divergente para auth_users.id=% . Esperado=% Encontrado=%',
      v_user_id,
      v_expected_discord_user_id,
      v_found_discord_user_id;
  end if;
end
$$;

create temp table tmp_reset_payment_orders on commit drop as
select po.id
  from public.payment_orders po
 where po.user_id = 1;

delete from public.payment_order_events
 where payment_order_id in (select id from tmp_reset_payment_orders);

delete from public.auth_user_plan_downgrade_enforcements
 where user_id = 1
    or resolved_payment_order_id in (select id from tmp_reset_payment_orders);

delete from public.auth_user_plan_scheduled_changes
 where user_id = 1;

delete from public.auth_user_plan_flow_point_events
 where user_id = 1
    or payment_order_id in (select id from tmp_reset_payment_orders);

delete from public.auth_user_plan_flow_points
 where user_id = 1;

delete from public.payment_coupon_redemptions
 where user_id = 1
    or payment_order_id in (select id from tmp_reset_payment_orders);

delete from public.payment_gift_card_redemptions
 where user_id = 1
    or payment_order_id in (select id from tmp_reset_payment_orders);

delete from public.auth_user_plan_guilds
 where user_id = 1;

delete from public.guild_plan_settings
 where user_id = 1;

delete from public.auth_user_hidden_payment_methods
 where user_id = 1;

delete from public.auth_user_payment_method_verifications
 where user_id = 1;

delete from public.auth_user_payment_methods
 where user_id = 1;

delete from public.auth_user_plan_state
 where user_id = 1;

delete from public.payment_orders
 where user_id = 1;

commit;

select
  au.id as user_id,
  au.discord_user_id,
  (select count(*) from public.payment_orders where user_id = au.id) as payment_orders_count,
  (select count(*) from public.auth_user_plan_state where user_id = au.id) as plan_state_count,
  (select count(*) from public.auth_user_plan_guilds where user_id = au.id) as plan_guilds_count,
  (select count(*) from public.guild_plan_settings where user_id = au.id) as guild_plan_settings_count,
  (select count(*) from public.auth_user_payment_methods where user_id = au.id) as payment_methods_count,
  (select count(*) from public.auth_user_payment_method_verifications where user_id = au.id) as payment_method_verifications_count,
  (select count(*) from public.auth_user_hidden_payment_methods where user_id = au.id) as hidden_payment_methods_count,
  (select count(*) from public.auth_user_plan_flow_points where user_id = au.id) as flow_points_count,
  (select count(*) from public.auth_user_plan_flow_point_events where user_id = au.id) as flow_point_events_count,
  (select count(*) from public.auth_user_plan_scheduled_changes where user_id = au.id) as scheduled_changes_count,
  (select count(*) from public.auth_user_plan_downgrade_enforcements where user_id = au.id) as downgrade_enforcements_count,
  (select count(*) from public.payment_coupon_redemptions where user_id = au.id) as coupon_redemptions_count,
  (select count(*) from public.payment_gift_card_redemptions where user_id = au.id) as gift_card_redemptions_count
from public.auth_users au
where au.id = 1;
