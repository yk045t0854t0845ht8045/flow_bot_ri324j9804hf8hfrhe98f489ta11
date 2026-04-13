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
          // Resolve Discord ID from internal User ID
          const { data: user, error } = await supabase
            .from("auth_users")
            .select("discord_user_id")
            .eq("id", userId)
            .maybeSingle();

          if (error) {
            console.error("[realtimeService] Error resolving discord_user_id:", error.message);
            return;
          }

          if (!user?.discord_user_id) {
            console.warn(`[realtimeService] Could not find discord_user_id for internal ID ${userId}`);
            return;
          }

          console.log(`[realtimeService] Event [${payload.eventType}] detected for user ${userId}. Scheduling sync in 1s...`);
          
          // Small delay to ensure DB state is fully committed and visible
          setTimeout(async () => {
            try {
              // Trigger the role sync logic
              await syncViolationRolesForDiscordUser(client, user.discord_user_id);

              // Broadcast to frontend (using Discord ID as channel identifier)
              await supabase
                .channel(`user_violations:${user.discord_user_id}`)
                .send({
                  type: "broadcast",
                  event: "refresh",
                  payload: { userId, discordUserId: user.discord_user_id },
                });

              console.log(`[realtimeService] Real-time sync & broadcast completed for ${user.discord_user_id} after delay.`);
            } catch (innerErr) {
              console.error("[realtimeService] Error in delayed sync:", innerErr.message);
            }
          }, 1000);
          
        } catch (err) {
          console.error("[realtimeService] Critical error in handler:", err.message);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[realtimeService] Subscription status: ${status}`);
    });
}

module.exports = { initRealtimeListeners };
