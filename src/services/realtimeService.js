const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const { syncViolationRolesForDiscordUser } = require("./violationService");

// Re-using same config as violationService
const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Initializes Supabase Realtime listeners for the Discord bot.
 * Listens for changes in account violations and triggers role synchronization.
 * 
 * @param {import("discord.js").Client} client 
 */
function initRealtimeListeners(client) {
  console.log("[realtimeService] Initializing Realtime listeners...");

  supabase
    .channel("account_violations_realtime")
    .on(
      "postgres_changes",
      { 
        event: "*", 
        schema: "public", 
        table: "account_violations" 
      },
      async (payload) => {
        // payload.new for INSERT/UPDATE, payload.old for DELETE
        const userId = payload.new?.user_id || payload.old?.user_id;
        
        if (!userId) {
          console.warn("[realtimeService] Received event without user_id:", payload.eventType);
          return;
        }

        try {
          console.log(`[realtimeService] DB ${payload.eventType} event on user ${userId}. Syncing in 200ms...`);
          
          // Reduced delay: 200ms is usually enough for commit propagation
          setTimeout(async () => {
            try {
              // 1. Resolve Discord ID
              const { data: user } = await supabase
                .from("auth_users")
                .select("discord_user_id")
                .eq("id", userId)
                .maybeSingle();

              if (!user?.discord_user_id) {
                console.warn(`[realtimeService] Could not resolve Discord ID for user ${userId}`);
                return;
              }

              // 2. Sync Roles
              await syncViolationRolesForDiscordUser(client, user.discord_user_id);

              // 3. Broadcast to site
              await supabase
                .channel(`user_violations:${user.discord_user_id}`)
                .send({
                  type: "broadcast",
                  event: "refresh",
                  payload: { userId, discordUserId: user.discord_user_id },
                });

              console.log(`[realtimeService] Real-time sync & broadcast completed for ${user.discord_user_id}`);
            } catch (innerErr) {
              console.error("[realtimeService] Sync error:", innerErr.message);
            }
          }, 200);
          
        } catch (err) {
          console.error("[realtimeService] Payload error:", err.message);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[realtimeService] Subscription status: ${status}`);
    });
}

module.exports = { initRealtimeListeners };
