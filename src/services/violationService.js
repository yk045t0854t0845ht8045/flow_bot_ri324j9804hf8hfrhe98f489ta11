const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

const VIOLATION_CACHE_TTL_MS = 15 * 1000;

const VIOLATION_ROLE_IDS = {
  1: env.officialViolationRoleLevel1Id,
  2: env.officialViolationRoleLevel2Id,
  3: env.officialViolationRoleLevel3Id,
  4: env.officialViolationRoleLevel4Id,
};

const ALL_VIOLATION_ROLE_IDS = Object.values(VIOLATION_ROLE_IDS).filter(Boolean);

const violationLevelCache = new Map();

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function readViolationLevelCache(discordUserId) {
  const entry = violationLevelCache.get(discordUserId);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    violationLevelCache.delete(discordUserId);
    return null;
  }

  return entry.level;
}

function writeViolationLevelCache(discordUserId, level) {
  violationLevelCache.set(discordUserId, {
    level,
    expiresAt: Date.now() + VIOLATION_CACHE_TTL_MS,
  });
}

function resolveViolationLevelFromCount(activeCount) {
  if (activeCount <= 0) return 0;
  if (activeCount === 1) return 1;
  if (activeCount === 2) return 2;
  if (activeCount === 3) return 3;
  return 4;
}

function chunkArray(values, size = 250) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(items, worker) {
  const queue = Array.isArray(items) ? items : [];
  if (!queue.length) {
    return 0;
  }

  const concurrency = Math.max(
    1,
    Math.min(env.violationSyncConcurrency || 1, queue.length),
  );
  let cursor = 0;
  let completed = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        await worker(item);
        completed += 1;
      }
    }),
  );

  return completed;
}

function isViolationActive(violation, nowMs = Date.now()) {
  if (!violation?.expires_at) {
    return true;
  }

  const expiresAtMs = new Date(violation.expires_at).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

async function getOfficialGuild(client, providedGuild = null) {
  if (providedGuild) {
    return providedGuild;
  }

  if (!env.officialSupportGuildId) {
    return null;
  }

  return await client.guilds.fetch(env.officialSupportGuildId).catch(() => null);
}

async function loadViolationLevelMapByDiscordUserIds(discordUserIds) {
  const uniqueDiscordUserIds = [...new Set((discordUserIds || []).filter(Boolean))];
  const violationLevelByDiscordUserId = new Map();

  if (!uniqueDiscordUserIds.length) {
    return violationLevelByDiscordUserId;
  }

  const userRows = [];
  for (const chunk of chunkArray(uniqueDiscordUserIds, 250)) {
    const { data: users, error: usersError } = await supabase
      .from("auth_users")
      .select("id, discord_user_id")
      .in("discord_user_id", chunk);

    if (usersError) {
      throw new Error(usersError.message);
    }

    if (Array.isArray(users) && users.length) {
      userRows.push(...users);
    }
  }

  const userIds = userRows
    .map((row) => row.id)
    .filter((value) => Number.isFinite(value));
  const discordUserIdByUserId = new Map(
    userRows.map((row) => [row.id, row.discord_user_id]),
  );

  let violations = [];
  if (userIds.length) {
    for (const chunk of chunkArray(userIds, 500)) {
      const { data, error } = await supabase
        .from("account_violations")
        .select("user_id, expires_at")
        .in("user_id", chunk);

      if (error) {
        throw new Error(error.message);
      }

      if (Array.isArray(data) && data.length) {
        violations = violations.concat(data);
      }
    }
  }

  const now = Date.now();
  const activeCountsByUserId = new Map();

  for (const violation of violations) {
    if (!Number.isFinite(violation?.user_id) || !isViolationActive(violation, now)) {
      continue;
    }

    activeCountsByUserId.set(
      violation.user_id,
      (activeCountsByUserId.get(violation.user_id) || 0) + 1,
    );
  }

  for (const discordUserId of uniqueDiscordUserIds) {
    violationLevelByDiscordUserId.set(discordUserId, 0);
  }

  for (const [userId, discordUserId] of discordUserIdByUserId.entries()) {
    const level = resolveViolationLevelFromCount(activeCountsByUserId.get(userId) || 0);
    violationLevelByDiscordUserId.set(discordUserId, level);
    writeViolationLevelCache(discordUserId, level);
  }

  return violationLevelByDiscordUserId;
}

async function loadActiveViolationLevelMap() {
  const { data: violations, error } = await supabase
    .from("account_violations")
    .select("user_id, expires_at");

  if (error) {
    throw new Error(error.message);
  }

  const now = Date.now();
  const activeCountsByUserId = new Map();

  for (const violation of violations || []) {
    if (!Number.isFinite(violation?.user_id) || !isViolationActive(violation, now)) {
      continue;
    }

    activeCountsByUserId.set(
      violation.user_id,
      (activeCountsByUserId.get(violation.user_id) || 0) + 1,
    );
  }

  const activeUserIds = [...activeCountsByUserId.keys()];
  const violationLevelByDiscordUserId = new Map();

  if (!activeUserIds.length) {
    return violationLevelByDiscordUserId;
  }

  const userRows = [];
  for (const chunk of chunkArray(activeUserIds, 500)) {
    const { data: users, error: usersError } = await supabase
      .from("auth_users")
      .select("id, discord_user_id")
      .in("id", chunk);

    if (usersError) {
      throw new Error(usersError.message);
    }

    if (Array.isArray(users) && users.length) {
      userRows.push(...users);
    }
  }

  for (const row of userRows) {
    const discordUserId =
      typeof row?.discord_user_id === "string" ? row.discord_user_id.trim() : "";
    if (!discordUserId) {
      continue;
    }

    const level = resolveViolationLevelFromCount(activeCountsByUserId.get(row.id) || 0);
    violationLevelByDiscordUserId.set(discordUserId, level);
    writeViolationLevelCache(discordUserId, level);
  }

  return violationLevelByDiscordUserId;
}

async function getViolationLevelForDiscordUser(discordUserId) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (!normalizedDiscordUserId) {
    return 0;
  }

  const cachedLevel = readViolationLevelCache(normalizedDiscordUserId);
  if (cachedLevel !== null) {
    return cachedLevel;
  }

  const levelMap = await loadViolationLevelMapByDiscordUserIds([
    normalizedDiscordUserId,
  ]);
  return levelMap.get(normalizedDiscordUserId) || 0;
}

async function applyViolationRolesForMember(member, level, options = {}) {
  const { log = true } = options;
  const guild = member?.guild;
  if (!guild) {
    return level;
  }

  if (level >= 4) {
    const suspensionRoleId = VIOLATION_ROLE_IDS[4];
    if (!suspensionRoleId) {
      return level;
    }
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    const botHighestPosition = me?.roles?.highest?.position || 0;

    const rolesToStrip = member.roles.cache.filter((role) =>
      role.id !== suspensionRoleId &&
      role.id !== guild.id &&
      role.position < botHighestPosition &&
      !role.managed
    );

    if (rolesToStrip.size > 0) {
      await member.roles.remove(
        rolesToStrip,
        "Flowdesk - Conta suspensa: remocao de acesso total",
      ).catch((error) => {
        console.error("[violationService] Failed to strip roles:", error.message);
      });
    }

    if (!member.roles.cache.has(suspensionRoleId)) {
      await member.roles.add(
        suspensionRoleId,
        "Flowdesk - Conta suspensa",
      ).catch((error) => {
        console.error("[violationService] Failed to add suspension role:", error.message);
      });
    }

    if (log) {
      console.log(`[violationService] Suspension enforced for ${member.id}`);
    }
    return level;
  }

  const rolesToRemove = ALL_VIOLATION_ROLE_IDS.filter((roleId) =>
    member.roles.cache.has(roleId),
  );

  if (rolesToRemove.length > 0) {
    await member.roles.remove(
      rolesToRemove,
      "Flowdesk - Atualizacao de nivel de violacao",
    ).catch((error) => {
      console.error("[violationService] Failed to remove roles:", error.message);
    });
  }

  if (level > 0) {
    const newRoleId = VIOLATION_ROLE_IDS[level];
    if (newRoleId && !member.roles.cache.has(newRoleId)) {
      await member.roles.add(
        newRoleId,
        `Flowdesk - Nivel de violacao: ${level}`,
      ).catch((error) => {
        console.error("[violationService] Failed to add violation role:", error.message);
      });
    }
  }

  if (log) {
    console.log(`[violationService] Synced roles for ${member.id}: level ${level}`);
  }

  return level;
}

async function syncViolationRolesForDiscordUser(client, discordUserId, options = {}) {
  try {
    const guild = await getOfficialGuild(client, options.guild || null);
    if (!guild) {
      console.warn("[violationService] Could not fetch official guild.");
      return 0;
    }

    const normalizedDiscordUserId =
      typeof discordUserId === "string" ? discordUserId.trim() : "";
    if (!normalizedDiscordUserId) {
      return 0;
    }

    const level =
      typeof options.level === "number"
        ? options.level
        : await getViolationLevelForDiscordUser(normalizedDiscordUserId);

    writeViolationLevelCache(normalizedDiscordUserId, level);

    const member =
      options.member ||
      guild.members.cache.get(normalizedDiscordUserId) ||
      (await guild.members
        .fetch({ user: normalizedDiscordUserId, force: true })
        .catch(() => null));

    if (!member) {
      if (options.log !== false) {
        console.warn(`[violationService] Member ${normalizedDiscordUserId} not found in guild.`);
      }
      return level;
    }

    return await applyViolationRolesForMember(member, level, {
      log: options.log !== false,
    });
  } catch (error) {
    console.error(
      "[violationService] Error syncing violation roles:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

async function isDiscordUserSuspended(discordUserId) {
  const level = await getViolationLevelForDiscordUser(discordUserId);
  return level >= 4;
}

async function isDiscordUserAtRisk(discordUserId) {
  const level = await getViolationLevelForDiscordUser(discordUserId);
  return level >= 3;
}

async function syncAllViolationRoles(client, options = {}) {
  const requestedMode =
    typeof options.mode === "string" ? options.mode.trim().toLowerCase() : "full";
  const mode = ["targeted", "full", "off"].includes(requestedMode)
    ? requestedMode
    : "full";

  if (mode === "off") {
    return { mode, synced: 0, candidateCount: 0 };
  }

  try {
    const guild = await getOfficialGuild(client);
    if (!guild) {
      console.warn("[violationService] Could not fetch official guild for violation sync.");
      return { mode, synced: 0, candidateCount: 0 };
    }

    if (mode === "targeted") {
      console.log("[violationService] Starting targeted violation role sync...");

      const violationLevelByDiscordUserId = await loadActiveViolationLevelMap();
      const candidates = [...violationLevelByDiscordUserId.entries()].map(
        ([discordUserId, level]) => ({
          discordUserId,
          level,
        }),
      );

      const synced = await runWithConcurrency(candidates, async (candidate) => {
        await syncViolationRolesForDiscordUser(client, candidate.discordUserId, {
          guild,
          level: candidate.level,
          log: false,
        });
      });

      console.log(
        `[violationService] Targeted sync completed: ${synced}/${candidates.length} member(s) processed.`,
      );
      return { mode, synced, candidateCount: candidates.length };
    }

    console.log("[violationService] Starting full violation role sync...");

    const allMembers = await guild.members.fetch().catch(() => null);
    if (!allMembers) {
      return { mode, synced: 0, candidateCount: 0 };
    }

    const targetMembers = [...allMembers.values()].filter(
      (member) => !member.user?.bot,
    );
    const violationLevelByDiscordUserId = await loadViolationLevelMapByDiscordUserIds(
      targetMembers.map((member) => member.id),
    );

    const synced = await runWithConcurrency(targetMembers, async (member) => {
      await syncViolationRolesForDiscordUser(client, member.id, {
        guild,
        member,
        level: violationLevelByDiscordUserId.get(member.id) || 0,
        log: false,
      });
    });

    console.log(`[violationService] Full sync completed: ${synced} members checked.`);
    return { mode, synced, candidateCount: targetMembers.length };
  } catch (error) {
    console.error(
      "[violationService] Violation sync error:",
      error instanceof Error ? error.message : error,
    );
    return { mode, synced: 0, candidateCount: 0 };
  }
}

module.exports = {
  getViolationLevelForDiscordUser,
  syncViolationRolesForDiscordUser,
  isDiscordUserSuspended,
  isDiscordUserAtRisk,
  syncAllViolationRoles,
};
