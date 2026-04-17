const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const { syncViolationRolesForDiscordUser } = require("./violationService");

const USER_LOOKUP_CACHE_TTL_MS = 60 * 1000;
const USER_SYNC_DEBOUNCE_MS = 350;
const RECONNECTABLE_STATUSES = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);

const discordUserIdCache = new Map();
const pendingViolationSyncs = new Map();

let violationChangesChannel = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let activeDiscordClient = null;
let lastSubscriptionStatus = null;

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function readDiscordUserIdCache(userId) {
  const entry = discordUserIdCache.get(userId);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    discordUserIdCache.delete(userId);
    return undefined;
  }

  return entry.discordUserId;
}

function writeDiscordUserIdCache(userId, discordUserId) {
  discordUserIdCache.set(userId, {
    discordUserId,
    expiresAt: Date.now() + USER_LOOKUP_CACHE_TTL_MS,
  });
}

async function resolveDiscordUserId(userId) {
  const cached = readDiscordUserIdCache(userId);
  if (cached !== undefined) {
    return cached;
  }

  const { data: user, error } = await supabase
    .from("auth_users")
    .select("discord_user_id")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const discordUserId =
    typeof user?.discord_user_id === "string" ? user.discord_user_id.trim() : null;
  writeDiscordUserIdCache(userId, discordUserId);
  return discordUserId;
}

async function removeChannelSafely(channel) {
  if (!channel) {
    return;
  }

  try {
    await supabase.removeChannel(channel);
  } catch {
    // noop
  }
}

async function closeViolationChangesChannel(channel = violationChangesChannel) {
  if (!channel) {
    return;
  }

  if (channel === violationChangesChannel) {
    violationChangesChannel = null;
  }

  await removeChannelSafely(channel);
}

async function broadcastViolationRefresh(discordUserId, payload) {
  const channel = supabase.channel(`user_violations:${discordUserId}`);

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        void removeChannelSafely(channel);
        reject(new Error("broadcast subscribe timeout"));
      }, env.realtimeBroadcastSubscribeTimeoutMs);

      channel.subscribe(async (status) => {
        if (settled) {
          return;
        }

        if (status === "SUBSCRIBED") {
          try {
            await channel.send({
              type: "broadcast",
              event: "refresh",
              payload,
            });
            settled = true;
            clearTimeout(timeoutId);
            resolve();
          } catch (error) {
            settled = true;
            clearTimeout(timeoutId);
            reject(error);
          } finally {
            void removeChannelSafely(channel);
          }
          return;
        }

        if (RECONNECTABLE_STATUSES.has(status)) {
          settled = true;
          clearTimeout(timeoutId);
          void removeChannelSafely(channel);
          reject(new Error(`broadcast channel ${status.toLowerCase()}`));
        }
      });
    });
  } catch (error) {
    console.warn(
      `[realtimeService] Broadcast refresh failed for ${discordUserId}: ${error?.message || error}`,
    );
  }
}

function queueViolationSync(client, userId, eventType) {
  const normalizedUserId = Number(userId);
  if (!Number.isFinite(normalizedUserId)) {
    return;
  }

  const existingTimeout = pendingViolationSyncs.get(normalizedUserId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeout = setTimeout(async () => {
    pendingViolationSyncs.delete(normalizedUserId);

    try {
      const discordUserId = await resolveDiscordUserId(normalizedUserId);
      if (!discordUserId) {
        console.warn(
          `[realtimeService] Could not resolve Discord ID for user ${normalizedUserId}`,
        );
        return;
      }

      await syncViolationRolesForDiscordUser(client, discordUserId);
      await broadcastViolationRefresh(discordUserId, {
        userId: normalizedUserId,
        discordUserId,
      });

      console.log(
        `[realtimeService] Synced violation roles after ${eventType} for ${discordUserId}`,
      );
    } catch (error) {
      console.error(
        "[realtimeService] Sync error:",
        error instanceof Error ? error.message : error,
      );
    }
  }, USER_SYNC_DEBOUNCE_MS);

  pendingViolationSyncs.set(normalizedUserId, timeout);
}

function scheduleRealtimeReconnect(reason) {
  if (!activeDiscordClient || reconnectTimer) {
    return;
  }

  const baseDelay = Math.max(500, Number(env.realtimeReconnectBaseMs) || 2_000);
  const maxDelay = Math.max(baseDelay, Number(env.realtimeReconnectMaxMs) || 30_000);
  const delay = Math.min(maxDelay, baseDelay * 2 ** reconnectAttempt);
  reconnectAttempt += 1;

  console.warn(
    `[realtimeService] Subscription ${reason}; reconnecting in ${delay}ms`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void subscribeViolationChanges(activeDiscordClient);
  }, delay);
}

async function subscribeViolationChanges(client) {
  activeDiscordClient = client;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  await closeViolationChangesChannel();

  const channel = supabase.channel("account_violations_realtime").on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "account_violations",
    },
    async (payload) => {
      const userId = payload.new?.user_id || payload.old?.user_id;

      if (!userId) {
        console.warn(
          "[realtimeService] Received event without user_id:",
          payload.eventType,
        );
        return;
      }

      queueViolationSync(activeDiscordClient, userId, payload.eventType || "unknown");
    },
  );

  violationChangesChannel = channel;

  channel.subscribe((status) => {
    if (channel !== violationChangesChannel) {
      return;
    }

    if (status !== lastSubscriptionStatus) {
      lastSubscriptionStatus = status;
      console.log(`[realtimeService] Subscription status: ${status}`);
    }

    if (status === "SUBSCRIBED") {
      reconnectAttempt = 0;
      return;
    }

    if (RECONNECTABLE_STATUSES.has(status)) {
      void closeViolationChangesChannel(channel);
      scheduleRealtimeReconnect(status);
    }
  });
}

function initRealtimeListeners(client) {
  console.log("[realtimeService] Initializing Realtime listeners...");
  activeDiscordClient = client;
  void subscribeViolationChanges(client);
}

module.exports = { initRealtimeListeners };
