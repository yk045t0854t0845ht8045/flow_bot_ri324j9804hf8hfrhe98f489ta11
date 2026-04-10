const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const flowPlansCatalog = require("../../shared/flow-plans.json");

const TICKETS_TABLE = "tickets";
const EVENTS_TABLE = "ticket_events";
const TICKET_SETTINGS_TABLE = "guild_ticket_settings";
const TICKET_STAFF_SETTINGS_TABLE = "guild_ticket_staff_settings";
const WELCOME_SETTINGS_TABLE = "guild_welcome_settings";
const ANTILINK_SETTINGS_TABLE = "guild_antilink_settings";
const SECURITY_LOGS_SETTINGS_TABLE = "guild_security_logs_settings";
const PAYMENT_ORDERS_TABLE = "payment_orders";
const TICKET_TRANSCRIPTS_TABLE = "ticket_transcripts";
const TICKET_DM_QUEUE_TABLE = "ticket_dm_queue";
const TICKET_AI_SESSIONS_TABLE = "ticket_ai_sessions";
const TICKET_AI_MESSAGES_TABLE = "ticket_ai_messages";
const DEFAULT_LICENSE_VALIDITY_DAYS = 30;
const EXPIRED_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function unwrap(result, operation) {
  if (result.error) {
    throw new Error(
      `[Supabase] Falha em "${operation}": ${result.error.message}`,
    );
  }

  return result.data;
}

function resolveLicenseBaseTimestamp(order) {
  const paidAtMs = order.paid_at ? Date.parse(order.paid_at) : Number.NaN;
  if (Number.isFinite(paidAtMs)) return paidAtMs;

  const createdAtMs = Date.parse(order.created_at);
  if (Number.isFinite(createdAtMs)) return createdAtMs;

  return Date.now();
}

function resolveLicenseValidityMs(order) {
  const explicitCycleDays =
    typeof order?.plan_billing_cycle_days === "number" &&
    Number.isFinite(order.plan_billing_cycle_days) &&
    order.plan_billing_cycle_days > 0
      ? order.plan_billing_cycle_days
      : null;

  if (explicitCycleDays) {
    return explicitCycleDays * 24 * 60 * 60 * 1000;
  }

  const normalizedPlanCode =
    typeof order?.plan_code === "string"
      ? order.plan_code.trim().toLowerCase()
      : "";
  const catalogCycleDays = Number(
    flowPlansCatalog?.[normalizedPlanCode]?.billingCycleDays,
  );
  const cycleDays =
    Number.isInteger(catalogCycleDays) && catalogCycleDays > 0
      ? catalogCycleDays
      : DEFAULT_LICENSE_VALIDITY_DAYS;

  return cycleDays * 24 * 60 * 60 * 1000;
}

function resolveLatestLicenseStatusFromApprovedOrders(orders, nowMs = Date.now()) {
  if (!Array.isArray(orders) || !orders.length) {
    return {
      status: "not_paid",
      usable: false,
      latestCoverage: null,
    };
  }

  const sortedOrders = [...orders].sort((left, right) => {
    return resolveLicenseBaseTimestamp(left) - resolveLicenseBaseTimestamp(right);
  });

  let latestCoverage = null;

  for (const order of sortedOrders) {
    const paidTimestampMs = resolveLicenseBaseTimestamp(order);
    let licenseStartsAtMs = paidTimestampMs;

    if (latestCoverage) {
      const previousLicenseExpiresAtMs = latestCoverage.licenseExpiresAtMs;
      const previousGraceExpiresAtMs = latestCoverage.graceExpiresAtMs;
      const previousRenewalWindowStartsAtMs =
        previousLicenseExpiresAtMs - EXPIRED_GRACE_MS;

      if (
        Number.isFinite(previousLicenseExpiresAtMs) &&
        Number.isFinite(previousGraceExpiresAtMs) &&
        paidTimestampMs >= previousRenewalWindowStartsAtMs &&
        paidTimestampMs <= previousGraceExpiresAtMs
      ) {
        licenseStartsAtMs = previousLicenseExpiresAtMs;
      }
    }

    const licenseExpiresAtMs = licenseStartsAtMs + resolveLicenseValidityMs(order);
    const graceExpiresAtMs = licenseExpiresAtMs + EXPIRED_GRACE_MS;

    let status = "off";
    if (nowMs <= licenseExpiresAtMs) {
      status = "paid";
    } else if (nowMs <= graceExpiresAtMs) {
      status = "expired";
    }

    latestCoverage = {
      order,
      status,
      licenseStartsAtMs,
      licenseExpiresAtMs,
      graceExpiresAtMs,
    };
  }

  return {
    status: latestCoverage?.status || "not_paid",
    usable:
      latestCoverage?.status === "paid" || latestCoverage?.status === "expired",
    latestCoverage,
  };
}

function normalizePlanCode(value, fallback = "pro") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return flowPlansCatalog?.[normalized] ? normalized : fallback;
}

function resolvePlanNameFromOrder(order) {
  const fromOrder = typeof order?.plan_name === "string" ? order.plan_name.trim() : "";
  if (fromOrder) return fromOrder;

  const normalizedPlanCode = normalizePlanCode(order?.plan_code, "pro");
  const fromCatalog = flowPlansCatalog?.[normalizedPlanCode]?.name;
  return typeof fromCatalog === "string" && fromCatalog.trim()
    ? fromCatalog.trim()
    : "Flow Pro";
}

function resolveExpiresAtIsoFromOrderOrCoverage(order, coverage) {
  if (
    coverage &&
    Number.isFinite(coverage.licenseExpiresAtMs) &&
    coverage.licenseExpiresAtMs > 0
  ) {
    return new Date(coverage.licenseExpiresAtMs).toISOString();
  }

  const expiresAtFromOrder =
    typeof order?.expires_at === "string" ? order.expires_at.trim() : "";
  if (expiresAtFromOrder) return expiresAtFromOrder;

  return null;
}

async function getOpenTicketCount(guildId, userId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .eq("status", "open");

  if (result.error) {
    throw new Error(
      `[Supabase] Falha em "getOpenTicketCount": ${result.error.message}`,
    );
  }

  return result.count || 0;
}

async function getOpenTicketsForUser(guildId, userId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("*")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  return unwrap(result, "getOpenTicketsForUser") || [];
}

async function getAllOpenTickets() {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("*")
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  return unwrap(result, "getAllOpenTickets") || [];
}

async function getLastTicketForUser(guildId, userId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("opened_at")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return unwrap(result, "getLastTicketForUser");
}

async function createTicket({ protocol, guildId, channelId, userId, openedReason = "" }) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .insert({
      protocol,
      guild_id: guildId,
      channel_id: channelId,
      user_id: userId,
      opened_reason: String(openedReason || "").trim(),
      status: "open",
    })
    .select("*")
    .single();

  return unwrap(result, "createTicket");
}

async function getOpenTicketByChannel(guildId, channelId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("*")
    .eq("guild_id", guildId)
    .eq("channel_id", channelId)
    .eq("status", "open")
    .maybeSingle();

  return unwrap(result, "getOpenTicketByChannel");
}

async function getTicketAiSession(ticketId) {
  const result = await supabase
    .from(TICKET_AI_SESSIONS_TABLE)
    .select("*")
    .eq("ticket_id", ticketId)
    .maybeSingle();

  return unwrap(result, "getTicketAiSession");
}

async function upsertTicketAiSession(input) {
  const result = await supabase
    .from(TICKET_AI_SESSIONS_TABLE)
    .upsert(
      {
        ticket_id: input.ticketId,
        protocol: input.protocol,
        guild_id: input.guildId,
        channel_id: input.channelId,
        user_id: input.userId,
        status: input.status || "active",
        handoff_reason: input.handoffReason || null,
        handed_off_by: input.handedOffBy || null,
        handed_off_at: input.handedOffAt || null,
        last_ai_reply_at: input.lastAiReplyAt || null,
        last_user_message_at: input.lastUserMessageAt || null,
        last_staff_message_at: input.lastStaffMessageAt || null,
      },
      { onConflict: "ticket_id" },
    )
    .select("*")
    .single();

  return unwrap(result, "upsertTicketAiSession");
}

async function createTicketAiMessage(input) {
  const result = await supabase
    .from(TICKET_AI_MESSAGES_TABLE)
    .insert({
      ticket_id: input.ticketId,
      protocol: input.protocol,
      guild_id: input.guildId,
      channel_id: input.channelId,
      author_id: input.authorId || null,
      author_type: input.authorType,
      source: input.source || "ticket_ai",
      content: String(input.content || "").trim(),
      metadata: input.metadata || {},
    })
    .select("*")
    .single();

  return unwrap(result, "createTicketAiMessage");
}

async function getRecentTicketAiMessages(ticketId, limit = 12) {
  const result = await supabase
    .from(TICKET_AI_MESSAGES_TABLE)
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = unwrap(result, "getRecentTicketAiMessages") || [];
  return rows.reverse();
}

async function claimTicket(ticketId, staffId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      claimed_by: staffId,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .select("*")
    .single();

  return unwrap(result, "claimTicket");
}

async function closeTicket(ticketId, closedBy, transcriptFileName) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      status: "closed",
      closed_by: closedBy,
      closed_at: new Date().toISOString(),
      transcript_file: transcriptFileName,
    })
    .eq("id", ticketId)
    .select("*")
    .single();

  return unwrap(result, "closeTicket");
}

async function upsertTicketTranscript({
  ticketId,
  protocol,
  guildId,
  channelId,
  userId,
  closedBy,
  transcriptHtml,
  accessCodeHash,
}) {
  const result = await supabase
    .from(TICKET_TRANSCRIPTS_TABLE)
    .upsert(
      {
        ticket_id: ticketId,
        protocol,
        guild_id: guildId,
        channel_id: channelId,
        user_id: userId,
        closed_by: closedBy,
        transcript_html: transcriptHtml,
        access_code_hash: accessCodeHash,
      },
      { onConflict: "ticket_id" },
    )
    .select("*")
    .single();

  return unwrap(result, "upsertTicketTranscript");
}

async function getTicketTranscriptByProtocol(protocol) {
  const result = await supabase
    .from(TICKET_TRANSCRIPTS_TABLE)
    .select("*")
    .eq("protocol", protocol)
    .maybeSingle();

  return unwrap(result, "getTicketTranscriptByProtocol");
}

async function enqueueTicketDirectMessage({
  notificationKey,
  kind,
  ticketId = null,
  protocol,
  guildId,
  userId,
  payload,
  maxAttempts = 12,
}) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .upsert(
      {
        notification_key: notificationKey,
        kind,
        ticket_id: ticketId,
        protocol,
        guild_id: guildId,
        user_id: userId,
        payload,
        status: "pending",
        attempt_count: 0,
        max_attempts: maxAttempts,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
        dm_channel_id: null,
        delivered_message_id: null,
        sent_at: null,
      },
      { onConflict: "notification_key" },
    )
    .select("*")
    .single();

  return unwrap(result, "enqueueTicketDirectMessage");
}

async function getDueTicketDirectMessages(limit = 10, notificationKey = null) {
  let query = supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (notificationKey) {
    query = query.eq("notification_key", notificationKey);
  }

  const result = await query;
  return unwrap(result, "getDueTicketDirectMessages") || [];
}

async function markTicketDirectMessageSent(queueId, { dmChannelId, deliveredMessageId }) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      last_error: null,
      dm_channel_id: dmChannelId || null,
      delivered_message_id: deliveredMessageId || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markTicketDirectMessageSent");
}

async function markTicketDirectMessageBlocked(queueId, { attemptCount, lastError }) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .update({
      status: "blocked",
      attempt_count: attemptCount,
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markTicketDirectMessageBlocked");
}

async function rescheduleTicketDirectMessage(queueId, {
  attemptCount,
  nextAttemptAt,
  lastError,
  finalFailure = false,
}) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .update({
      status: finalFailure ? "failed" : "pending",
      attempt_count: attemptCount,
      next_attempt_at: nextAttemptAt,
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "rescheduleTicketDirectMessage");
}

async function closeTicketAsDeleted(ticketId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      status: "closed",
      closed_by: "system:channel_deleted",
      closed_at: new Date().toISOString(),
      transcript_file: null,
    })
    .eq("id", ticketId)
    .eq("status", "open")
    .select("*")
    .maybeSingle();

  return unwrap(result, "closeTicketAsDeleted");
}

async function registerEvent({
  ticketId,
  protocol,
  guildId,
  channelId,
  actorId,
  eventType,
  metadata = {},
}) {
  const result = await supabase.from(EVENTS_TABLE).insert({
    ticket_id: ticketId,
    protocol,
    guild_id: guildId,
    channel_id: channelId,
    actor_id: actorId,
    event_type: eventType,
    metadata,
  });

  unwrap(result, "registerEvent");
}

async function getGuildTicketSettings(guildId) {
  const result = await supabase
    .from(TICKET_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, menu_channel_id, tickets_category_id, logs_created_channel_id, logs_closed_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildTicketSettings");
}

async function getGuildTicketStaffSettings(guildId) {
  const result = await supabase
    .from(TICKET_STAFF_SETTINGS_TABLE)
    .select(
      "guild_id, admin_role_id, claim_role_ids, close_role_ids, notify_role_ids, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildTicketStaffSettings");
}

async function getGuildWelcomeSettings(guildId) {
  const result = await supabase
    .from(WELCOME_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, entry_public_channel_id, entry_log_channel_id, exit_public_channel_id, exit_log_channel_id, entry_layout, exit_layout, entry_thumbnail_mode, exit_thumbnail_mode, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildWelcomeSettings");
}

async function getGuildAntiLinkSettings(guildId) {
  const result = await supabase
    .from(ANTILINK_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, log_channel_id, enforcement_action, timeout_minutes, ignored_role_ids, block_external_links, block_discord_invites, block_obfuscated_links, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildAntiLinkSettings");
}

async function getGuildSecurityLogsSettings(guildId) {
  const result = await supabase
    .from(SECURITY_LOGS_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, use_default_channel, default_channel_id, nickname_change_enabled, nickname_change_channel_id, avatar_change_enabled, avatar_change_channel_id, voice_join_enabled, voice_join_channel_id, voice_leave_enabled, voice_leave_channel_id, message_delete_enabled, message_delete_channel_id, message_edit_enabled, message_edit_channel_id, member_ban_enabled, member_ban_channel_id, member_unban_enabled, member_unban_channel_id, member_kick_enabled, member_kick_channel_id, member_timeout_enabled, member_timeout_channel_id, voice_move_enabled, voice_move_channel_id, voice_mute_enabled, voice_mute_channel_id, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildSecurityLogsSettings");
}

async function getApprovedPaymentOrdersForGuild(guildId) {
  const result = await supabase
    .from(PAYMENT_ORDERS_TABLE)
    .select("id, guild_id, plan_code, paid_at, created_at, plan_billing_cycle_days")
    .eq("guild_id", guildId)
    .eq("status", "approved")
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  return unwrap(result, "getApprovedPaymentOrdersForGuild") || [];
}

async function getUserPlanSnapshotByDiscordUserId(discordUserId) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (!normalizedDiscordUserId) {
    return {
      hasPlan: false,
      hasPurchaseHistory: false,
      userId: null,
    };
  }

  const authUserResult = await supabase
    .from("auth_users")
    .select("id, discord_user_id")
    .eq("discord_user_id", normalizedDiscordUserId)
    .maybeSingle();

  const authUser = unwrap(authUserResult, "getUserPlanSnapshotByDiscordUserId.authUser");
  if (!authUser?.id) {
    return {
      hasPlan: false,
      hasPurchaseHistory: false,
      userId: null,
    };
  }

  const approvedOrdersResult = await supabase
    .from(PAYMENT_ORDERS_TABLE)
    .select(
      "id, user_id, plan_code, plan_name, paid_at, created_at, expires_at, amount, currency, plan_billing_cycle_days",
    )
    .eq("user_id", authUser.id)
    .eq("status", "approved")
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const approvedOrders =
    unwrap(
      approvedOrdersResult,
      "getUserPlanSnapshotByDiscordUserId.approvedOrders",
    ) || [];

  if (!approvedOrders.length) {
    return {
      hasPlan: false,
      hasPurchaseHistory: false,
      userId: authUser.id,
    };
  }

  const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);
  const latestCoverage = license.latestCoverage;
  const latestOrder = latestCoverage?.order || approvedOrders[0];
  const normalizedPlanCode = normalizePlanCode(latestOrder?.plan_code, "pro");
  const resolvedPlanName = resolvePlanNameFromOrder(latestOrder);
  const expiresAtIso = resolveExpiresAtIsoFromOrderOrCoverage(
    latestOrder,
    latestCoverage,
  );
  const purchasedAtIso = latestOrder?.paid_at || latestOrder?.created_at || null;

  return {
    hasPlan: true,
    hasPurchaseHistory: true,
    userId: authUser.id,
    planCode: normalizedPlanCode,
    planName: resolvedPlanName,
    status: license.status === "paid" ? "active" : "expired",
    rawStatus: license.status,
    expiresAt: expiresAtIso,
    purchasedAt: purchasedAtIso,
    amount:
      typeof latestOrder?.amount === "number" && Number.isFinite(latestOrder.amount)
        ? latestOrder.amount
        : null,
    currency:
      typeof latestOrder?.currency === "string" && latestOrder.currency.trim()
        ? latestOrder.currency.trim()
        : "BRL",
    billingCycleDays:
      typeof latestOrder?.plan_billing_cycle_days === "number" &&
      Number.isFinite(latestOrder.plan_billing_cycle_days)
        ? latestOrder.plan_billing_cycle_days
        : null,
  };
}

async function getApprovedPaymentOrdersForGuildIds(guildIds) {
  const uniqueGuildIds = [...new Set((guildIds || []).filter(Boolean))];
  if (!uniqueGuildIds.length) {
    return new Map();
  }

  const result = await supabase
    .from(PAYMENT_ORDERS_TABLE)
    .select("id, guild_id, plan_code, paid_at, created_at, plan_billing_cycle_days")
    .in("guild_id", uniqueGuildIds)
    .eq("status", "approved")
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const rows = unwrap(result, "getApprovedPaymentOrdersForGuildIds") || [];
  const ordersByGuild = new Map(uniqueGuildIds.map((guildId) => [guildId, []]));

  for (const row of rows) {
    if (!ordersByGuild.has(row.guild_id)) {
      ordersByGuild.set(row.guild_id, []);
    }

    ordersByGuild.get(row.guild_id).push(row);
  }

  return ordersByGuild;
}

async function getGuildTicketRuntime(guildId) {
  const [settings, staffSettings, approvedOrders] = await Promise.all([
    getGuildTicketSettings(guildId),
    getGuildTicketStaffSettings(guildId),
    getApprovedPaymentOrdersForGuild(guildId),
  ]);

  const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);

  return {
    guildId,
    settings: settings || null,
    staffSettings: staffSettings || null,
    licenseStatus: license.status,
    licenseUsable: license.usable,
    latestCoverage: license.latestCoverage,
    isConfigured: Boolean(settings && staffSettings),
  };
}

async function getGuildWelcomeRuntime(guildId) {
  const [settings, approvedOrders] = await Promise.all([
    getGuildWelcomeSettings(guildId),
    getApprovedPaymentOrdersForGuild(guildId),
  ]);

  const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: license.status,
    licenseUsable: license.usable,
    latestCoverage: license.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getGuildAntiLinkRuntime(guildId) {
  const [settings, approvedOrders] = await Promise.all([
    getGuildAntiLinkSettings(guildId),
    getApprovedPaymentOrdersForGuild(guildId),
  ]);

  const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: license.status,
    licenseUsable: license.usable,
    latestCoverage: license.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getGuildSecurityLogsRuntime(guildId) {
  const [settings, approvedOrders] = await Promise.all([
    getGuildSecurityLogsSettings(guildId),
    getApprovedPaymentOrdersForGuild(guildId),
  ]);

  const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: license.status,
    licenseUsable: license.usable,
    latestCoverage: license.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getConfiguredTicketGuildRuntimes() {
  const [settingsResult, staffResult] = await Promise.all([
    supabase
      .from(TICKET_SETTINGS_TABLE)
      .select(
        "guild_id, enabled, menu_channel_id, tickets_category_id, logs_created_channel_id, logs_closed_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, updated_at",
      ),
    supabase
      .from(TICKET_STAFF_SETTINGS_TABLE)
      .select(
        "guild_id, admin_role_id, claim_role_ids, close_role_ids, notify_role_ids, updated_at",
      ),
  ]);

  const settingsRows = unwrap(settingsResult, "getConfiguredTicketGuildRuntimes.settings") || [];
  const staffRows = unwrap(staffResult, "getConfiguredTicketGuildRuntimes.staff") || [];
  const approvedOrdersByGuild = await getApprovedPaymentOrdersForGuildIds(
    settingsRows.map((row) => row.guild_id),
  );

  const staffByGuild = new Map(staffRows.map((row) => [row.guild_id, row]));
  const runtimes = settingsRows.map((settingsRow) => {
    const approvedOrders = approvedOrdersByGuild.get(settingsRow.guild_id) || [];
    const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);
    const staffSettings = staffByGuild.get(settingsRow.guild_id) || null;

    return {
      guildId: settingsRow.guild_id,
      settings: settingsRow,
      staffSettings,
      licenseStatus: license.status,
      licenseUsable: license.usable,
      latestCoverage: license.latestCoverage,
      isConfigured: Boolean(settingsRow && staffSettings),
    };
  });

  return runtimes.filter((runtime) => runtime.settings);
}

async function updateGuildTicketPanelMessageId(guildId, panelMessageId) {
  const result = await supabase
    .from(TICKET_SETTINGS_TABLE)
    .update({
      panel_message_id: panelMessageId || null,
    })
    .eq("guild_id", guildId)
    .select("guild_id, panel_message_id")
    .single();

  return unwrap(result, "updateGuildTicketPanelMessageId");
}

module.exports = {
  enqueueTicketDirectMessage,
  closeTicketAsDeleted,
  createTicket,
  getDueTicketDirectMessages,
  getConfiguredTicketGuildRuntimes,
  getGuildAntiLinkRuntime,
  getGuildAntiLinkSettings,
  getGuildSecurityLogsRuntime,
  getGuildSecurityLogsSettings,
  createTicketAiMessage,
  getGuildTicketRuntime,
  getTicketAiSession,
  getRecentTicketAiMessages,
  getGuildWelcomeRuntime,
  getLastTicketForUser,
  getOpenTicketByChannel,
  getOpenTicketCount,
  getOpenTicketsForUser,
  getAllOpenTickets,
  getTicketTranscriptByProtocol,
  getGuildWelcomeSettings,
  claimTicket,
  closeTicket,
  markTicketDirectMessageBlocked,
  markTicketDirectMessageSent,
  registerEvent,
  rescheduleTicketDirectMessage,
  upsertTicketAiSession,
  upsertTicketTranscript,
  updateGuildTicketPanelMessageId,
  getUserPlanSnapshotByDiscordUserId,
};
