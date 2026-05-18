alter table if exists public.guild_ticket_refund_settings
  add constraint guild_ticket_refund_settings_single_mode_check
  check (
    (auto_process_enabled = true and manual_approval_required = false)
    or
    (auto_process_enabled = false and manual_approval_required = true)
  ) not valid;

create index if not exists idx_guild_ticket_refund_settings_mode_updated
  on public.guild_ticket_refund_settings (guild_id, auto_process_enabled, manual_approval_required, updated_at desc);

create index if not exists idx_ticket_refund_audit_events_protocol
  on public.ticket_refund_audit_events ((metadata->>'protocol'))
  where metadata ? 'protocol';

create index if not exists idx_ticket_dm_queue_refund_pending
  on public.ticket_dm_queue (guild_id, status, next_attempt_at)
  where kind in ('ticket_refund_processed_dm', 'ticket_refund_denied_dm');
