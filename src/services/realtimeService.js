const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const { syncViolationRolesForDiscordUser } = require("./violationService");

const USER_LOOKUP_CACHE_TTL_MS = 60 * 1000;
const USER_SYNC_DEBOUNCE_MS = 350;

const discordUserIdCache = new Map();
const pendingViolationSyncs = new Map();

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function readDiscordUserIdCache(userId) {
  const entry = discordUserIdCache.get(userId);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    discordUserIdCache.delete(userId);
    return null;
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
  if (cached) {
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

  const discordUserId = user?.discord_user_id || null;
  if (discordUserId) {
    writeDiscordUserIdCache(userId, discordUserId);
  }

  return discordUserId;
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

      await supabase
        .channel(`user_violations:${discordUserId}`)
        .send({
          type: "broadcast",
          event: "refresh",
          payload: { userId: normalizedUserId, discordUserId },
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

function initRealtimeListeners(client) {
  console.log("[realtimeService] Initializing Realtime listeners...");

  supabase
    .channel("account_violations_realtime")
    .on(
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

        queueViolationSync(client, userId, payload.eventType || "unknown");
      },
    )
    .subscribe((status) => {
      console.log(`[realtimeService] Subscription status: ${status}`);
    });
}

module.exports = { initRealtimeListeners };
