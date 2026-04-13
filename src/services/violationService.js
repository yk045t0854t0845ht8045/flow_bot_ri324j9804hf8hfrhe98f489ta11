const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

// ─── Constants ────────────────────────────────────────────────────────────────
const OFFICIAL_GUILD_ID = "1353259338759671838";

const VIOLATION_ROLE_IDS = {
  1: "1493281297039097958", // Limitado
  2: "1493281298352181350", // Muito Limitado
  3: "1493281190566957187", // Em Risco
  4: "1493281297945334022", // Suspenso
};

const ALL_VIOLATION_ROLE_IDS = Object.values(VIOLATION_ROLE_IDS);

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Resolves the violation level (0-4) for a given discord user ID.
 * Looks up internal user ID from auth_users, then counts active violations.
 */
async function getViolationLevelForDiscordUser(discordUserId) {
  const { data: user } = await supabase
    .from("auth_users")
    .select("id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (!user) return 0;

  const now = new Date().toISOString();

  const { data: violations } = await supabase
    .from("account_violations")
    .select("id, expires_at")
    .eq("user_id", user.id);

  if (!violations || violations.length === 0) return 0;

  const activeCount = violations.filter((v) => {
    if (!v.expires_at) return true; // No expiry = permanent
    return new Date(v.expires_at).getTime() > Date.now();
  }).length;

  if (activeCount === 0) return 0;
  if (activeCount === 1) return 1;
  if (activeCount === 2) return 2;
  if (activeCount === 3) return 3;
  return 4;
}

/**
 * Syncs violation roles for a Discord user:
 * 1. Removes ALL violation roles from the member
 * 2. Applies the single correct one (if level > 0)
 */
async function syncViolationRolesForDiscordUser(client, discordUserId) {
  try {
    const guild = await client.guilds.fetch(OFFICIAL_GUILD_ID).catch(() => null);
    if (!guild) {
      console.warn("[violationService] Could not fetch official guild.");
      return;
    }

    const level = await getViolationLevelForDiscordUser(discordUserId);

    // Fetch member with force: true to ensure we have the absolute latest roles from Discord API
    const member = await guild.members.fetch({ user: discordUserId, force: true }).catch(() => null);
    if (!member) {
      console.warn(`[violationService] Member ${discordUserId} not found in guild.`);
      return;
    }

    // Remove all violation roles first (more robustly)
    const rolesToRemove = ALL_VIOLATION_ROLE_IDS.filter(roleId => member.roles.cache.has(roleId));
    
    if (rolesToRemove.length > 0) {
      await member.roles.remove(rolesToRemove, "Flowdesk - Limpeza de cargo de violação").catch((err) => {
        console.error(`[violationService] Failed to remove roles for ${discordUserId}:`, err.message);
      });
    }

    // Apply the correct role
    if (level > 0) {
      const newRoleId = VIOLATION_ROLE_IDS[level];
      if (!member.roles.cache.has(newRoleId)) {
        await member.roles.add(newRoleId, `Flowdesk - Nível de violação: ${level}`).catch((err) => {
          console.error(`[violationService] Failed to add role ${newRoleId} to ${discordUserId}:`, err.message);
        });
      }
    }

    console.log(`[violationService] Synced roles for ${discordUserId}: Level ${level} (Total active violations: ${level})`);
    return level;
  } catch (err) {
    console.error("[violationService] Error syncing violation roles:", err.message);
  }
}

/**
 * Checks if a Discord user is suspended (level 4).
 * Useful for blocking bot commands or actions.
 */
async function isDiscordUserSuspended(discordUserId) {
  const level = await getViolationLevelForDiscordUser(discordUserId);
  return level >= 4;
}

/**
 * Checks if a Discord user is at risk or suspended (level 3+).
 * Useful for lighter restrictions.
 */
async function isDiscordUserAtRisk(discordUserId) {
  const level = await getViolationLevelForDiscordUser(discordUserId);
  return level >= 3;
}

/**
 * Called on bot startup / periodically to re-sync ALL members of the official guild.
 * Ensures roles are consistent even after bot restarts or manual DB edits.
 */
async function syncAllViolationRoles(client) {
  console.log("[violationService] Starting full violation role sync...");

  try {
    const guild = await client.guilds.fetch(OFFICIAL_GUILD_ID).catch(() => null);
    if (!guild) {
      console.warn("[violationService] Could not fetch official guild for full sync.");
      return;
    }

    // Fetch all members who have at least one violation role
    const allMembers = await guild.members.fetch().catch(() => null);
    if (!allMembers) return;

    let synced = 0;
    for (const [memberId] of allMembers) {
      await syncViolationRolesForDiscordUser(client, memberId);
      synced++;
    }

    console.log(`[violationService] Full sync completed: ${synced} members checked.`);
  } catch (err) {
    console.error("[violationService] Full sync error:", err.message);
  }
}

module.exports = {
  getViolationLevelForDiscordUser,
  syncViolationRolesForDiscordUser,
  isDiscordUserSuspended,
  isDiscordUserAtRisk,
  syncAllViolationRoles,
};
