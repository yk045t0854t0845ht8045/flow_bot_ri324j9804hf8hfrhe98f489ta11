const { PermissionsBitField } = require("discord.js");
const {
  enqueueGuildAutoRoleQueueItems,
  getDueGuildAutoRoleQueueItems,
  getGuildAutoRoleRuntime,
  getPendingGuildAutoRoleSyncSettings,
  markGuildAutoRoleQueueItemCancelled,
  markGuildAutoRoleQueueItemCompleted,
  markGuildAutoRoleQueueItemProcessing,
  markGuildAutoRoleSyncCompleted,
  markGuildAutoRoleSyncFailed,
  markGuildAutoRoleSyncProcessing,
  postponeGuildAutoRoleQueueItem,
  rescheduleGuildAutoRoleQueueItem,
} = require("./supabaseService");

const AUTOROLE_RETRY_DELAYS_MS = [
  30 * 1000,
  2 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
];
const AUTOROLE_QUEUE_PROCESS_INTERVAL_MS = 15 * 1000;
const AUTOROLE_LICENSE_POSTPONE_MS = 10 * 60 * 1000;
const AUTOROLE_MAX_ATTEMPTS = 7;
const AUTOROLE_RUNTIME_CACHE_TTL_MS = 60 * 1000;

let processingPromise = null;
let intervalHandle = null;
const runtimeCache = new Map();

function resolveNextRetryTimestamp(attemptCount) {
  const delay =
    AUTOROLE_RETRY_DELAYS_MS[
      Math.min(attemptCount - 1, AUTOROLE_RETRY_DELAYS_MS.length - 1)
    ] || AUTOROLE_RETRY_DELAYS_MS[AUTOROLE_RETRY_DELAYS_MS.length - 1];

  return new Date(Date.now() + delay).toISOString();
}

function normalizeDelayMinutes(value) {
  return value === 10 || value === 20 || value === 30 ? value : 0;
}

function resolveDueAtIso(delayMinutes) {
  const normalizedDelay = normalizeDelayMinutes(delayMinutes);
  if (!normalizedDelay) return new Date().toISOString();
  return new Date(Date.now() + normalizedDelay * 60 * 1000).toISOString();
}

function normalizeRoleIdsFromSettings(settings) {
  const raw = settings?.role_ids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id) => typeof id === "string" && /^\d{10,25}$/.test(id));
}

function isAutoRoleBlockedError(error) {
  const code = error?.code || error?.rawError?.code;
  return code === 50013 || code === 50001;
}

async function getCachedGuildAutoRoleRuntime(guildId) {
  const cached = runtimeCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < AUTOROLE_RUNTIME_CACHE_TTL_MS) {
    return cached.runtime;
  }

  const runtime = await getGuildAutoRoleRuntime(guildId);
  runtimeCache.set(guildId, { timestamp: Date.now(), runtime });
  return runtime;
}

async function enqueueAutoRoleForMember({ member }) {
  if (!member?.guild?.id || !member?.id) {
    return { queued: false, reason: "invalid_member" };
  }

  if (member.user?.bot) {
    return { queued: false, reason: "bot_member" };
  }

  const runtime = await getCachedGuildAutoRoleRuntime(member.guild.id);
  if (!runtime?.licenseUsable) {
    return { queued: false, reason: "license_unusable", licenseStatus: runtime?.licenseStatus || null };
  }

  const settings = runtime.settings;
  if (!settings || settings.enabled !== true) {
    return { queued: false, reason: "disabled" };
  }

  const roleIds = normalizeRoleIdsFromSettings(settings);
  if (!roleIds.length) {
    return { queued: false, reason: "no_roles" };
  }

  const dueAt = resolveDueAtIso(settings.assignment_delay_minutes);
  await enqueueGuildAutoRoleQueueItems([
    {
      guildId: member.guild.id,
      memberId: member.id,
      dueAt,
      requestedSource: "member_join",
    },
  ]);

  return { queued: true, dueAt };
}

async function processPendingExistingMembersSync(client, options = {}) {
  const { limit = 1, insertBatchSize = 250 } = options;
  const settingsRows = await getPendingGuildAutoRoleSyncSettings(limit);
  const results = [];

  for (const settingsRow of settingsRows) {
    const guildId = settingsRow.guild_id;
    if (!guildId) continue;

    try {
      const runtime = await getCachedGuildAutoRoleRuntime(guildId);
      const licenseUsable = Boolean(runtime?.licenseUsable);

      if (!licenseUsable) {
        results.push({ guildId, status: "skipped", reason: "license_unusable" });
        continue;
      }

      if (settingsRow.enabled !== true) {
        await markGuildAutoRoleSyncFailed(guildId, "Autorole desativado.");
        results.push({ guildId, status: "failed", reason: "disabled" });
        continue;
      }

      const roleIds = normalizeRoleIdsFromSettings(settingsRow);
      if (!roleIds.length) {
        await markGuildAutoRoleSyncFailed(guildId, "Nenhum cargo configurado para autorole.");
        results.push({ guildId, status: "failed", reason: "no_roles" });
        continue;
      }

      const guild =
        client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        await markGuildAutoRoleSyncFailed(guildId, "Bot sem acesso ao servidor para sincronizacao.");
        results.push({ guildId, status: "failed", reason: "guild_missing" });
        continue;
      }

      await markGuildAutoRoleSyncProcessing(guildId);

      const members = await guild.members.fetch().catch(() => null);
      if (!members) {
        await markGuildAutoRoleSyncFailed(guildId, "Falha ao carregar membros para sincronizacao.");
        results.push({ guildId, status: "failed", reason: "members_fetch_failed" });
        continue;
      }

      // Para sincronizacao em massa, aplicamos imediatamente (o delay do "ao entrar"
      // fica apenas para novos membros).
      const dueAt = new Date().toISOString();
      const queueBatch = [];
      let insertedCount = 0;

      for (const member of members.values()) {
        if (member.user?.bot) continue;
        const hasAnyMissingRole = roleIds.some((roleId) => !member.roles.cache.has(roleId));
        if (!hasAnyMissingRole) continue;

        queueBatch.push({
          guildId,
          memberId: member.id,
          dueAt,
          requestedSource: "existing_members_sync",
        });

        if (queueBatch.length >= insertBatchSize) {
          insertedCount += await enqueueGuildAutoRoleQueueItems(queueBatch.splice(0));
        }
      }

      if (queueBatch.length) {
        insertedCount += await enqueueGuildAutoRoleQueueItems(queueBatch);
      }

      await markGuildAutoRoleSyncCompleted(guildId);
      results.push({ guildId, status: "completed", insertedCount });
    } catch (error) {
      const lastError =
        error instanceof Error ? error.message : "Falha ao sincronizar autorole.";
      try {
        await markGuildAutoRoleSyncFailed(settingsRow.guild_id, lastError);
      } catch {
        // ignore secondary failures
      }
      results.push({ guildId: settingsRow.guild_id, status: "failed", lastError });
    }
  }

  return results;
}

async function processAutoRoleQueue(client, options = {}) {
  const { limit = 12 } = options;
  const queueItems = await getDueGuildAutoRoleQueueItems(limit);
  const results = [];

  for (const queueItem of queueItems) {
    const nextAttemptCount = Number(queueItem.attempt_count || 0) + 1;
    const guildId = queueItem.guild_id;
    const memberId = queueItem.member_id;

    try {
      await markGuildAutoRoleQueueItemProcessing(queueItem.id, {
        attemptCount: nextAttemptCount,
      });

      const runtime = await getCachedGuildAutoRoleRuntime(guildId);
      const settings = runtime?.settings;

      if (!settings || settings.enabled !== true) {
        await markGuildAutoRoleQueueItemCancelled(queueItem.id, {
          lastError: "Autorole desativado ou nao configurado.",
        });
        results.push({ id: queueItem.id, status: "cancelled", reason: "disabled" });
        continue;
      }

      if (!runtime?.licenseUsable) {
        await postponeGuildAutoRoleQueueItem(queueItem.id, {
          nextDueAt: new Date(Date.now() + AUTOROLE_LICENSE_POSTPONE_MS).toISOString(),
          lastError: `Plano da conta nao esta ativo (status: ${runtime?.licenseStatus || "unknown"}).`,
        });
        results.push({ id: queueItem.id, status: "queued", reason: "license_unusable" });
        continue;
      }

      const roleIds = normalizeRoleIdsFromSettings(settings);
      if (!roleIds.length) {
        await markGuildAutoRoleQueueItemCancelled(queueItem.id, {
          lastError: "Nenhum cargo configurado para autorole.",
        });
        results.push({ id: queueItem.id, status: "cancelled", reason: "no_roles" });
        continue;
      }

      const guild =
        client.guilds.cache.get(guildId) ||
        (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        await markGuildAutoRoleQueueItemCancelled(queueItem.id, {
          lastError: "Bot sem acesso ao servidor.",
        });
        results.push({ id: queueItem.id, status: "cancelled", reason: "guild_missing" });
        continue;
      }

      const me =
        guild.members.me || (await guild.members.fetchMe().catch(() => null));
      const canManageRoles =
        Boolean(me) &&
        me.permissions.has(PermissionsBitField.Flags.ManageRoles);

      if (!canManageRoles) {
        await markGuildAutoRoleQueueItemCancelled(queueItem.id, {
          lastError: "Bot sem permissao de gerenciar cargos.",
        });
        results.push({ id: queueItem.id, status: "cancelled", reason: "missing_permissions" });
        continue;
      }

      const member =
        guild.members.cache.get(memberId) ||
        (await guild.members.fetch(memberId).catch(() => null));
      if (!member) {
        await markGuildAutoRoleQueueItemCancelled(queueItem.id, {
          lastError: "Membro nao encontrado (talvez saiu do servidor).",
        });
        results.push({ id: queueItem.id, status: "cancelled", reason: "member_missing" });
        continue;
      }

      if (member.user?.bot) {
        await markGuildAutoRoleQueueItemCancelled(queueItem.id, {
          lastError: "Membro e bot (autorole ignora bots).",
        });
        results.push({ id: queueItem.id, status: "cancelled", reason: "bot_member" });
        continue;
      }

      const assignableRoleIds = roleIds.filter((roleId) => {
        if (roleId === guildId) return false;
        const role = guild.roles.cache.get(roleId);
        if (!role || role.managed) return false;
        if (!me?.roles?.highest) return false;
        return me.roles.highest.comparePositionTo(role) > 0;
      });

      const missingRoleIds = assignableRoleIds.filter(
        (roleId) => !member.roles.cache.has(roleId),
      );

      if (!missingRoleIds.length) {
        await markGuildAutoRoleQueueItemCompleted(queueItem.id);
        results.push({ id: queueItem.id, status: "completed", skipped: true });
        continue;
      }

      await member.roles.add(missingRoleIds, "Flowdesk AutoRole");
      await markGuildAutoRoleQueueItemCompleted(queueItem.id);
      results.push({ id: queueItem.id, status: "completed", added: missingRoleIds.length });
    } catch (error) {
      const lastError =
        error instanceof Error ? error.message : "Falha ao aplicar autorole.";

      if (isAutoRoleBlockedError(error)) {
        await rescheduleGuildAutoRoleQueueItem(queueItem.id, {
          attemptCount: nextAttemptCount,
          nextDueAt: new Date().toISOString(),
          lastError,
          finalFailure: true,
        });
        results.push({ id: queueItem.id, status: "failed", lastError });
        continue;
      }

      const reachedMaxAttempts = nextAttemptCount >= AUTOROLE_MAX_ATTEMPTS;
      await rescheduleGuildAutoRoleQueueItem(queueItem.id, {
        attemptCount: nextAttemptCount,
        nextDueAt: reachedMaxAttempts
          ? new Date().toISOString()
          : resolveNextRetryTimestamp(nextAttemptCount),
        lastError,
        finalFailure: reachedMaxAttempts,
      });

      results.push({
        id: queueItem.id,
        status: reachedMaxAttempts ? "failed" : "queued",
        lastError,
      });
    }
  }

  return results;
}

async function processAutoRoleWorker(client, options = {}) {
  if (processingPromise) {
    return processingPromise;
  }

  processingPromise = (async () => {
    const syncResults = await processPendingExistingMembersSync(client, {
      limit: options.syncLimit || 1,
    });
    const queueResults = await processAutoRoleQueue(client, {
      limit: options.queueLimit || 12,
    });
    return { syncResults, queueResults };
  })();

  try {
    return await processingPromise;
  } finally {
    processingPromise = null;
  }
}

function startAutoRoleWorker(client) {
  if (intervalHandle) {
    return intervalHandle;
  }

  void processAutoRoleWorker(client).catch((error) => {
    console.error("[autorole-worker]", error);
  });

  intervalHandle = setInterval(() => {
    void processAutoRoleWorker(client).catch((error) => {
      console.error("[autorole-worker]", error);
    });
  }, AUTOROLE_QUEUE_PROCESS_INTERVAL_MS);

  return intervalHandle;
}

module.exports = {
  enqueueAutoRoleForMember,
  processAutoRoleQueue,
  processPendingExistingMembersSync,
  processAutoRoleWorker,
  startAutoRoleWorker,
};
