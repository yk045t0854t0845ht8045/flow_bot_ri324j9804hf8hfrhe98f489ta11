-- WARNING: DESTRUCTIVE OPERATION
-- Este script trunca (apaga) dados de usuário e reinicia sequences.
-- Preserva tabelas de configuração e políticas (ex.: payment_refund_policy_rules,
-- guild_plan_settings, textos, etc.). Revise a lista abaixo antes de executar.

BEGIN;

-- Lista de tabelas alvo para WIPE (ajuste conforme necessário):
TRUNCATE TABLE
  public.ticket_transcripts,
  public.ticket_dm_queue,
  public.ticket_events,
  public.tickets,

  public.payment_order_events,
  public.payment_orders,
  public.payment_refund_records,
  public.payment_risk_flags,
  public.payment_coupons,

  public.auth_user_payment_method_verifications,
  public.auth_user_payment_methods,
  public.auth_user_hidden_payment_methods,
  public.auth_user_favorite_guilds,
  public.auth_user_discord_links,
  public.auth_user_teams,
  public.auth_user_team_servers,
  public.auth_user_team_members,
  public.auth_security_events,
  public.auth_sessions,
  public.auth_users
CASCADE;

-- Reinicia sequences associadas às tabelas truncadas (coluna id).
DO $$
DECLARE
  tbl text;
  seq regclass;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'ticket_transcripts','ticket_dm_queue','ticket_events','tickets',
      'payment_order_events','payment_orders','payment_refund_records','payment_risk_flags','payment_coupons',
      'auth_user_payment_method_verifications','auth_user_payment_methods','auth_user_hidden_payment_methods','auth_user_favorite_guilds',
      'auth_user_discord_links','auth_user_teams','auth_user_team_servers','auth_user_team_members','auth_security_events','auth_sessions','auth_users'
    ])
  LOOP
    BEGIN
      seq := pg_get_serial_sequence('public.' || tbl, 'id');
      IF seq IS NOT NULL THEN
        EXECUTE format('ALTER SEQUENCE %s RESTART WITH 1', seq::text);
      END IF;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Ignorando reinicio de sequence para %', tbl;
    END;
  END LOOP;
END$$ LANGUAGE plpgsql;

COMMIT;

-- INSTRUÇÕES:
-- 1) Revise as tabelas na lista acima e remova/adicione conforme seu caso.
-- 2) Execute este script no editor SQL do Supabase (como um administrador).
-- 3) Se usar RLS (row level security), execute como role com permissão para truncar.

-- Observação: este script assume coluna de chave primaria chamada `id`.
-- Se sua schema usa nomes diferentes de sequence/PK, ajuste manualmente.
