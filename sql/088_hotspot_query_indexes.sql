create index if not exists idx_account_violations_user_expires_at
on public.account_violations (user_id, expires_at);

create index if not exists idx_auth_security_events_started_session_action_created_at
on public.auth_security_events (session_id, action, created_at desc)
where outcome = 'started';

create index if not exists idx_auth_security_events_started_user_action_created_at
on public.auth_security_events (user_id, action, created_at desc)
where outcome = 'started';

create index if not exists idx_auth_security_events_started_ip_action_created_at
on public.auth_security_events (ip_fingerprint, action, created_at desc)
where outcome = 'started';

create index if not exists idx_payment_orders_user_status_paid_at_created_at_approved
on public.payment_orders (user_id, status, paid_at desc, created_at desc)
where status = 'approved';

create index if not exists idx_payment_orders_user_guild_created_at_desc
on public.payment_orders (user_id, guild_id, created_at desc);

create index if not exists idx_payment_orders_user_status_guild_updated_created_desc
on public.payment_orders (user_id, status, guild_id, updated_at desc, created_at desc);

create index if not exists idx_payment_orders_guild_status_created_at_desc
on public.payment_orders (guild_id, status, created_at desc);

create index if not exists idx_payment_orders_order_number_guild_id
on public.payment_orders (order_number, guild_id);

create index if not exists idx_payment_orders_provider_payment_id
on public.payment_orders (provider_payment_id)
where provider_payment_id is not null;

create index if not exists idx_payment_orders_pending_user_guild_provider_created_desc
on public.payment_orders (user_id, guild_id, provider_payment_id, created_at desc)
where status = 'pending';

create index if not exists idx_auth_sessions_active_user_expires_at
on public.auth_sessions (user_id, expires_at desc)
where revoked_at is null;

create index if not exists idx_guild_ticket_settings_configured_by_user_guild_updated_at
on public.guild_ticket_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_ticket_staff_settings_configured_by_user_guild_updated_at
on public.guild_ticket_staff_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_welcome_settings_configured_by_user_guild_updated_at
on public.guild_welcome_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_antilink_settings_configured_by_user_guild_updated_at
on public.guild_antilink_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_autorole_settings_configured_by_user_guild_updated_at
on public.guild_autorole_settings (configured_by_user_id, guild_id, updated_at desc);

create index if not exists idx_guild_plan_settings_user_guild_updated_at
on public.guild_plan_settings (user_id, guild_id, updated_at desc);

create index if not exists idx_auth_user_plan_guilds_guild_user
on public.auth_user_plan_guilds (guild_id, user_id);

create index if not exists idx_auth_user_team_servers_guild_team
on public.auth_user_team_servers (guild_id, team_id);

create index if not exists idx_auth_user_teams_owner_user_id_id
on public.auth_user_teams (owner_user_id, id);

create index if not exists idx_auth_user_team_members_auth_status_team
on public.auth_user_team_members (invited_auth_user_id, status, team_id);

create index if not exists idx_auth_user_team_members_discord_status_team
on public.auth_user_team_members (invited_discord_user_id, status, team_id);
