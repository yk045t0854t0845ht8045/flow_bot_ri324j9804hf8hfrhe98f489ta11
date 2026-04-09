begin;

truncate table
  public.payment_order_events,
  public.payment_coupon_redemptions,
  public.payment_gift_card_redemptions,
  public.auth_security_events,
  public.auth_user_favorite_guilds,
  public.auth_user_hidden_payment_methods,
  public.auth_user_payment_method_verifications,
  public.auth_user_payment_methods,
  public.auth_user_discord_links,
  public.auth_user_team_members,
  public.auth_user_team_servers,
  public.auth_user_teams,
  public.auth_user_plan_guilds,
  public.auth_user_plan_state,
  public.guild_plan_settings,
  public.guild_antilink_settings,
  public.guild_security_logs_settings,
  public.guild_welcome_settings,
  public.guild_ticket_staff_settings,
  public.guild_ticket_settings,
  public.ticket_ai_messages,
  public.ticket_ai_sessions,
  public.ticket_dm_queue,
  public.ticket_events,
  public.ticket_transcripts,
  public.tickets,
  public.payment_orders,
  public.payment_coupons,
  public.payment_gift_cards,
  public.auth_sessions,
  public.auth_users
restart identity cascade;

commit;
