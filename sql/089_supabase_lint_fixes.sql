-- Supabase lint fixes acumulados.
-- Envie os proximos itens e eu continuo adicionando neste mesmo arquivo.

alter function public.get_status_severity_weight(public.system_status_type)
set search_path = pg_catalog, public;

alter function public.normalize_status_message(text)
set search_path = pg_catalog, public;

alter function public.system_status_is_incident_worthy(public.system_status_type)
set search_path = pg_catalog, public;

alter function public.maintain_worst_daily_status()
set search_path = pg_catalog, public;

alter function public.set_updated_at()
set search_path = pg_catalog, public;

alter function public.base36_encode_bigint(bigint)
set search_path = pg_catalog, public;

alter function public.log_system_status_change()
set search_path = pg_catalog, public;

alter function public.create_plan_expiry_task()
set search_path = pg_catalog, public;

alter function public.handle_plan_status_change()
set search_path = pg_catalog, public;

alter function public.touch_system_component_updated_at()
set search_path = pg_catalog, public;

alter function public.touch_system_status_subscription_updated_at()
set search_path = pg_catalog, public;

alter function public.system_status_refresh_incident_copy(uuid)
set search_path = pg_catalog, public;

alter function public.system_status_insert_incident_update(
  uuid,
  public.incident_status_type,
  text
)
set search_path = pg_catalog, public;

alter function public.sync_system_incident_dates()
set search_path = pg_catalog, public;

alter function public.system_status_sync_daily_lock()
set search_path = pg_catalog, public;

alter function public.system_status_touch_incident_from_update()
set search_path = pg_catalog, public;

alter function public.system_status_handle_component_transition()
set search_path = pg_catalog, public;

alter function public.system_status_touch_updated_at()
set search_path = pg_catalog, public;

alter function public.system_status_log_component_status_change()
set search_path = pg_catalog, public;

alter function public.system_status_log_incident_change()
set search_path = pg_catalog, public;

alter function public.system_status_log_incident_update_change()
set search_path = pg_catalog, public;

alter function public.system_status_log_maintenance_change()
set search_path = pg_catalog, public;

alter function public.system_status_touch_runtime_lease_updated_at()
set search_path = pg_catalog, public;

alter function public.payment_parse_numeric(text, numeric)
set search_path = pg_catalog, public;

alter function public.payment_parse_boolean(text, boolean)
set search_path = pg_catalog, public;

alter function public.ensure_service_role_all_policy(regclass, text)
set search_path = pg_catalog, public;

alter function public.payment_orders_assign_public_identifiers()
set search_path = pg_catalog, public;

do $$
begin
  if to_regclass('public.discord_cdn_cache') is not null then
    alter table public.discord_cdn_cache enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.discord_cdn_cache'::regclass,
      'service_role_all_discord_cdn_cache'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_health_pings') is not null then
    alter table public.system_health_pings enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_health_pings'::regclass,
      'service_role_all_system_health_pings'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_status_audit') is not null then
    alter table public.system_status_audit enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_status_audit'::regclass,
      'service_role_all_system_status_audit'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_status_subscriptions') is not null then
    alter table public.system_status_subscriptions enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_status_subscriptions'::regclass,
      'service_role_all_system_status_subscriptions'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.system_status_webhook_deliveries') is not null then
    alter table public.system_status_webhook_deliveries enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.system_status_webhook_deliveries'::regclass,
      'service_role_all_system_status_webhook_deliveries'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.ticket_dm_queue') is not null then
    alter table public.ticket_dm_queue enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.ticket_dm_queue'::regclass,
      'service_role_all_ticket_dm_queue'
    );
  end if;
end
$$;

do $$
begin
  if to_regclass('public.ticket_transcripts') is not null then
    alter table public.ticket_transcripts enable row level security;
    perform public.ensure_service_role_all_policy(
      'public.ticket_transcripts'::regclass,
      'service_role_all_ticket_transcripts'
    );
  end if;
end
$$;
