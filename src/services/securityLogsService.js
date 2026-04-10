const {
  ActionRowBuilder,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} = require("discord.js");
const { calculateUserDefaultAvatarIndex } = require("@discordjs/rest");
const { getGuildSecurityLogsRuntime } = require("./supabaseService");

const RUNTIME_CACHE_TTL_MS = 10_000;
const runtimeCache = new Map();
const recentEventCache = new Map();
const globalAvatarSnapshotCache = new Map();
const guildAvatarSnapshotCache = new Map();
const voiceStateSnapshotCache = new Map();

const DEFAULT_AUDIT_RETRY_DELAYS_MS = [0, 1_200, 1_400, 1_600];
const KICK_AUDIT_RETRY_DELAYS_MS = [0, 1_000, 1_500, 2_200, 3_200];
const RECENT_EVENT_TTL_MS = 20_000;
const SECURITY_LOG_DETAILS_PREFIX = "securitylog:details:";

let canvasModuleResolved = false;
let canvasModule = null;

const SECURITY_LOG_EVENT_CONFIG = {
  nicknameChange: {
    enabledColumn: "nickname_change_enabled",
    channelColumn: "nickname_change_channel_id",
    label: "Alteracao de nickname",
  },
  avatarChange: {
    enabledColumn: "avatar_change_enabled",
    channelColumn: "avatar_change_channel_id",
    label: "Alteracao de avatar",
  },
  voiceJoin: {
    enabledColumn: "voice_join_enabled",
    channelColumn: "voice_join_channel_id",
    label: "Entrou em canal de voz",
  },
  voiceLeave: {
    enabledColumn: "voice_leave_enabled",
    channelColumn: "voice_leave_channel_id",
    label: "Saiu de canal de voz",
  },
  messageDelete: {
    enabledColumn: "message_delete_enabled",
    channelColumn: "message_delete_channel_id",
    label: "Mensagem deletada",
  },
  messageEdit: {
    enabledColumn: "message_edit_enabled",
    channelColumn: "message_edit_channel_id",
    label: "Mensagem editada",
  },
  memberBan: {
    enabledColumn: "member_ban_enabled",
    channelColumn: "member_ban_channel_id",
    label: "Membro banido",
  },
  memberUnban: {
    enabledColumn: "member_unban_enabled",
    channelColumn: "member_unban_channel_id",
    label: "Membro desbanido",
  },
  memberKick: {
    enabledColumn: "member_kick_enabled",
    channelColumn: "member_kick_channel_id",
    label: "Membro expulso",
  },
  memberTimeout: {
    enabledColumn: "member_timeout_enabled",
    channelColumn: "member_timeout_channel_id",
    label: "Membro silenciado",
  },
  voiceMove: {
    enabledColumn: "voice_move_enabled",
    channelColumn: "voice_move_channel_id",
    label: "Membro movido de call",
  },
  voiceMute: {
    enabledColumn: "voice_mute_enabled",
    channelColumn: "voice_mute_channel_id",
    label: "Mute e desmute em call",
  },
};

function resolveCanvasModule() {
  if (canvasModuleResolved) return canvasModule;
  canvasModuleResolved = true;
  try {
    canvasModule = require("@napi-rs/canvas");
  } catch {
    canvasModule = null;
  }
  return canvasModule;
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toSnippet(value, maxLength = 800) {
  const normalized = trimText(String(value || ""))
    .replace(/`/g, "'")
    .replace(/\s+/g, " ");
  if (!normalized) return "(sem conteudo textual)";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function toCodeBlock(value, maxLength = 800) {
  return `\`\`\`\n${toSnippet(value, maxLength)}\n\`\`\``;
}

function toFieldValue(value, maxLength = 1024) {
  const normalized = String(value || "").trim();
  if (!normalized) return "-";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeSecurityLogFields(fields = []) {
  return fields
    .filter((field) => field && typeof field.name === "string")
    .slice(0, 24)
    .map((field) => ({
      name: toSnippet(field.name, 256),
      value: toFieldValue(field.value, 1024),
      inline: Boolean(field.inline),
    }));
}

function chunkTextBlocks(blocks, maxLength = 3500, maxChunks = 6) {
  const normalizedBlocks = blocks
    .map((block) => String(block || "").trim())
    .filter(Boolean);

  if (!normalizedBlocks.length) return [];

  const chunks = [];
  let currentChunk = "";

  for (const block of normalizedBlocks) {
    if (!currentChunk) {
      currentChunk = block;
      continue;
    }

    if (currentChunk.length + 2 + block.length <= maxLength) {
      currentChunk += `\n\n${block}`;
      continue;
    }

    chunks.push(currentChunk);
    if (chunks.length >= maxChunks) {
      return chunks;
    }

    currentChunk = block;
  }

  if (currentChunk && chunks.length < maxChunks) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function formatDateTime(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "Nao informado";
  const unix = Math.floor(timestampMs / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function formatMemberLabel(member) {
  if (!member?.id) return "Membro desconhecido";
  return `<@${member.id}> (\`${member.id}\`)`;
}

function formatUserLabel(user) {
  if (!user?.id) return "Usuario desconhecido";
  return `<@${user.id}> (\`${user.id}\`)`;
}

function resolveEventConfig(settings, eventKey) {
  const config = SECURITY_LOG_EVENT_CONFIG[eventKey];
  if (!config || !settings) return { enabled: false, channelId: null, label: "" };
  if (settings.enabled !== true) {
    return { enabled: false, channelId: null, label: config.label };
  }

  const useDefaultChannel = settings.use_default_channel === true;
  const resolvedDefaultChannelId = trimText(settings.default_channel_id);
  const resolvedEventChannelId = trimText(settings[config.channelColumn]);

  return {
    enabled: settings[config.enabledColumn] === true,
    channelId: useDefaultChannel
      ? resolvedDefaultChannelId || null
      : resolvedEventChannelId || null,
    label: config.label,
  };
}

async function resolveTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function resolveRuntime(guildId) {
  const cached = runtimeCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const runtime = await getGuildSecurityLogsRuntime(guildId).catch(() => null);
  runtimeCache.set(guildId, {
    value: runtime,
    expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS,
  });
  return runtime;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function registerRecentEvent(cacheKey, ttlMs = RECENT_EVENT_TTL_MS) {
  const key = trimText(cacheKey);
  if (!key) return false;

  const now = Date.now();
  const expiresAt = recentEventCache.get(key) || 0;
  if (expiresAt > now) {
    return true;
  }

  recentEventCache.set(key, now + ttlMs);
  for (const [entryKey, entryExpiresAt] of recentEventCache.entries()) {
    if (entryExpiresAt <= now) {
      recentEventCache.delete(entryKey);
    }
  }

  return false;
}

function resolveAuditEntryTargetId(entry) {
  if (entry?.target?.id) return entry.target.id;
  if (entry?.extra?.id) return entry.extra.id;
  return null;
}

async function resolveAuditEntry(guild, input) {
  const {
    type,
    targetId = null,
    maxAgeMs = 30_000,
    predicate = null,
    retryDelaysMs = DEFAULT_AUDIT_RETRY_DELAYS_MS,
    limit = 12,
    allowUnknownTarget = false,
  } = input;

  if (!guild) return null;

  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }

    const logs = await guild.fetchAuditLogs({ type, limit }).catch(() => null);
    if (!logs) {
      continue;
    }

    const now = Date.now();
    let fallbackUnknownTargetEntry = null;
    for (const entry of logs.entries.values()) {
      if (!entry?.executor?.id) continue;
      if (typeof entry.createdTimestamp !== "number") continue;
      if (now - entry.createdTimestamp > maxAgeMs) continue;

      const entryTargetId = resolveAuditEntryTargetId(entry);
      if (typeof predicate === "function" && !predicate(entry)) {
        continue;
      }

      if (!targetId) {
        return entry;
      }

      if (entryTargetId === targetId) {
        return entry;
      }

      if (!entryTargetId && allowUnknownTarget && !fallbackUnknownTargetEntry) {
        fallbackUnknownTargetEntry = entry;
      }
    }

    if (fallbackUnknownTargetEntry) {
      return fallbackUnknownTargetEntry;
    }
  }

  return null;
}

function resolveStaticUserAvatarUrl(user) {
  if (!user || typeof user.displayAvatarURL !== "function") return null;
  return user.displayAvatarURL({
    extension: "png",
    forceStatic: true,
    size: 512,
  });
}

function resolveStaticMemberAvatarUrl(member) {
  if (!member || typeof member.displayAvatarURL !== "function") return null;
  return member.displayAvatarURL({
    extension: "png",
    forceStatic: true,
    size: 512,
  });
}

function resolveDefaultAvatarUrl(client, userId) {
  if (!client?.rest?.cdn || !userId) return null;
  const index = calculateUserDefaultAvatarIndex(userId);
  return client.rest.cdn.defaultAvatar(index);
}

function resolveUserAvatarUrlFromHash(client, userId, avatarHash, fallbackUser = null) {
  const normalizedHash = trimText(avatarHash);
  if (normalizedHash) {
    return client.rest.cdn.avatar(userId, normalizedHash, {
      extension: "png",
      forceStatic: true,
      size: 512,
    });
  }

  return resolveStaticUserAvatarUrl(fallbackUser) || resolveDefaultAvatarUrl(client, userId);
}

function resolveMemberAvatarUrlFromHash(
  client,
  guildId,
  userId,
  avatarHash,
  fallbackMember = null,
  fallbackUser = null,
) {
  const normalizedHash = trimText(avatarHash);
  if (normalizedHash) {
    return client.rest.cdn.guildMemberAvatar(guildId, userId, normalizedHash, {
      extension: "png",
      forceStatic: true,
      size: 512,
    });
  }

  return (
    resolveStaticMemberAvatarUrl(fallbackMember) ||
    resolveUserAvatarUrlFromHash(client, userId, null, fallbackUser)
  );
}

function resolveGuildAvatarSnapshotKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getKnownGlobalAvatarHash(client, userId) {
  if (globalAvatarSnapshotCache.has(userId)) {
    return globalAvatarSnapshotCache.get(userId);
  }

  const cachedUser = client?.users?.cache?.get(userId);
  if (cachedUser) {
    return cachedUser.avatar || null;
  }

  return undefined;
}

function rememberGlobalAvatarHash(userId, avatarHash) {
  if (!userId) return;
  globalAvatarSnapshotCache.set(userId, avatarHash || null);
}

function getKnownGuildAvatarHash(guild, userId) {
  if (!guild?.id || !userId) return undefined;

  const snapshotKey = resolveGuildAvatarSnapshotKey(guild.id, userId);
  if (guildAvatarSnapshotCache.has(snapshotKey)) {
    return guildAvatarSnapshotCache.get(snapshotKey);
  }

  const cachedMember = guild.members?.cache?.get(userId);
  if (cachedMember) {
    return cachedMember.avatar || null;
  }

  return undefined;
}

function rememberGuildAvatarHash(guildId, userId, avatarHash) {
  if (!guildId || !userId) return;
  guildAvatarSnapshotCache.set(
    resolveGuildAvatarSnapshotKey(guildId, userId),
    avatarHash || null,
  );
}

function resolveVoiceStateSnapshotKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getKnownVoiceStateSnapshot(guildId, userId) {
  if (!guildId || !userId) return null;
  return voiceStateSnapshotCache.get(resolveVoiceStateSnapshotKey(guildId, userId)) || null;
}

function rememberVoiceStateSnapshot(guildId, userId, snapshot) {
  if (!guildId || !userId || !snapshot) return;
  voiceStateSnapshotCache.set(resolveVoiceStateSnapshotKey(guildId, userId), {
    channelId: snapshot.channelId || null,
    serverMute:
      typeof snapshot.serverMute === "boolean" ? snapshot.serverMute : null,
    serverDeaf:
      typeof snapshot.serverDeaf === "boolean" ? snapshot.serverDeaf : null,
  });
}

function resolveVoiceChannel(guild, channelId, fallbackChannel = null) {
  if (fallbackChannel?.id === channelId) {
    return fallbackChannel;
  }

  if (!guild || !channelId) return null;
  return guild.channels?.cache?.get(channelId) || fallbackChannel || null;
}

function hasAuditChangeKey(entry, keys) {
  if (!Array.isArray(entry?.changes) || !Array.isArray(keys) || !keys.length) {
    return false;
  }

  const allowedKeys = new Set(
    keys.map((key) => String(key || "").toLowerCase()).filter(Boolean),
  );
  if (!allowedKeys.size) return false;

  return entry.changes.some((change) =>
    allowedKeys.has(String(change?.key || "").toLowerCase()),
  );
}

function encodeButtonValue(value) {
  const normalized = trimText(String(value || ""));
  return normalized || "0";
}

function decodeButtonValue(value) {
  const normalized = trimText(String(value || ""));
  return normalized && normalized !== "0" ? normalized : null;
}

function buildSecurityLogDetailsCustomId(eventKey, context = {}) {
  const targetId = encodeButtonValue(context.targetId);
  const actorId = encodeButtonValue(context.actorId);
  const channelId = encodeButtonValue(context.channelId);
  const oldChannelId = encodeButtonValue(context.oldChannelId);
  const newChannelId = encodeButtonValue(context.newChannelId);
  const scope = encodeButtonValue(context.scope);
  const state = encodeButtonValue(context.state);
  const until = Number.isFinite(context.untilTimestamp)
    ? Math.max(0, Math.trunc(context.untilTimestamp)).toString(36)
    : "0";

  switch (eventKey) {
    case "avatarChange":
      return `${SECURITY_LOG_DETAILS_PREFIX}av:${targetId}:${scope}`;
    case "nicknameChange":
      return `${SECURITY_LOG_DETAILS_PREFIX}nn:${targetId}`;
    case "voiceJoin":
      return `${SECURITY_LOG_DETAILS_PREFIX}vj:${targetId}:${channelId}`;
    case "voiceLeave":
      return `${SECURITY_LOG_DETAILS_PREFIX}vl:${targetId}:${channelId}`;
    case "voiceMove":
      return `${SECURITY_LOG_DETAILS_PREFIX}vm:${targetId}:${actorId}:${oldChannelId}:${newChannelId}`;
    case "voiceMute":
      return `${SECURITY_LOG_DETAILS_PREFIX}vt:${targetId}:${actorId}:${channelId}:${state}`;
    case "messageDelete":
      return `${SECURITY_LOG_DETAILS_PREFIX}md:${targetId}:${channelId}`;
    case "messageEdit":
      return `${SECURITY_LOG_DETAILS_PREFIX}me:${targetId}:${channelId}`;
    case "memberBan":
      return `${SECURITY_LOG_DETAILS_PREFIX}mb:${targetId}:${actorId}`;
    case "memberUnban":
      return `${SECURITY_LOG_DETAILS_PREFIX}mu:${targetId}:${actorId}`;
    case "memberKick":
      return `${SECURITY_LOG_DETAILS_PREFIX}mk:${targetId}:${actorId}`;
    case "memberTimeout":
      return `${SECURITY_LOG_DETAILS_PREFIX}mt:${targetId}:${actorId}:${until}`;
    default:
      return null;
  }
}

function parseSecurityLogDetailsCustomId(customId) {
  const normalized = trimText(customId);
  if (!normalized.startsWith(SECURITY_LOG_DETAILS_PREFIX)) {
    return null;
  }

  const body = normalized.slice(SECURITY_LOG_DETAILS_PREFIX.length);
  const parts = body.split(":");
  const code = parts.shift() || "";

  switch (code) {
    case "av":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        scope: decodeButtonValue(parts[1]),
      };
    case "nn":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
      };
    case "vj":
    case "vl":
    case "md":
    case "me":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        channelId: decodeButtonValue(parts[1]),
      };
    case "vm":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
        oldChannelId: decodeButtonValue(parts[2]),
        newChannelId: decodeButtonValue(parts[3]),
      };
    case "vt":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
        channelId: decodeButtonValue(parts[2]),
        state: decodeButtonValue(parts[3]),
      };
    case "mb":
    case "mu":
    case "mk":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
      };
    case "mt":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
        untilTimestamp:
          parts[2] && parts[2] !== "0"
            ? Number.parseInt(parts[2], 36)
            : null,
      };
    default:
      return null;
  }
}

function formatUserReference(userId) {
  return userId ? `<@${userId}> (\`${userId}\`)` : "Nao identificado";
}

function formatChannelReference(channelId) {
  return channelId ? `<#${channelId}> (\`${channelId}\`)` : "Nao identificado";
}

function buildActionRowsFromButtons(buttons = []) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)),
    );
  }
  return rows;
}

function buildSecurityLogActionRows(guildId, eventKey, context = {}) {
  const buttons = [];
  const detailCustomId = buildSecurityLogDetailsCustomId(eventKey, context);

  if (detailCustomId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(detailCustomId)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Detalhes"),
    );
  }

  const primaryChannelId = trimText(
    context.newChannelId || context.channelId || "",
  );
  if (guildId && primaryChannelId) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(eventKey === "voiceMove" ? "Abrir destino" : "Abrir canal")
        .setURL(`https://discord.com/channels/${guildId}/${primaryChannelId}`),
    );
  }

  if (eventKey === "avatarChange") {
    const oldAvatarUrl = trimText(context.oldAvatarUrl || "");
    const newAvatarUrl = trimText(context.newAvatarUrl || "");

    if (oldAvatarUrl) {
      buttons.push(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Avatar antigo")
          .setURL(oldAvatarUrl),
      );
    }

    if (newAvatarUrl && buttons.length < 5) {
      buttons.push(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Avatar novo")
          .setURL(newAvatarUrl),
      );
    }
  }

  return buildActionRowsFromButtons(buttons);
}

function createSecurityLogSeparator({
  divider = true,
  spacing = SeparatorSpacingSize.Small,
} = {}) {
  return new SeparatorBuilder().setDivider(divider).setSpacing(spacing);
}

function buildSecurityLogFieldTextBlocks(fields = []) {
  const safeFields = normalizeSecurityLogFields(fields);
  if (!safeFields.length) return [];

  const lines = safeFields.map((field) => {
    const label = toSnippet(field.name, 120);
    const normalizedValue = trimText(field.value || "-") || "-";
    const compactValue = normalizedValue.replace(/\s*\n\s*/g, " ").trim();
    const shouldUseBlock =
      normalizedValue.includes("\n") ||
      normalizedValue.includes("```") ||
      compactValue.length > 180;

    return shouldUseBlock
      ? `**${label}**\n${normalizedValue}`
      : `**${label}:** ${compactValue}`;
  });

  return chunkTextBlocks(lines, 2_400, 10);
}

function buildSecurityLogPayload({
  color = 0x5ca9ff,
  title,
  description,
  fields = [],
  imageBuffer = null,
  imageName = "security-log.png",
  thumbnailUrl = null,
  buttonRows = [],
  flags = MessageFlags.IsComponentsV2,
}) {
  const container = new ContainerBuilder().setAccentColor(color);
  const normalizedTitle = toSnippet(title || "Flowdesk Security Logs", 180);
  const normalizedDescription = trimText(description || "");
  const descriptionBlocks = normalizedDescription
    ? chunkTextBlocks([normalizedDescription], 3_500, 4)
    : [];
  const fieldBlocks = buildSecurityLogFieldTextBlocks(fields);
  const safeButtonRows = Array.isArray(buttonRows)
    ? buttonRows.filter(Boolean)
    : [];

  if (thumbnailUrl) {
    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${normalizedTitle}`),
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder()
          .setURL(thumbnailUrl)
          .setDescription(normalizedTitle),
      );

    if (descriptionBlocks[0]) {
      headerSection.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(descriptionBlocks[0]),
      );
    }

    container.addSectionComponents(headerSection);
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${normalizedTitle}`),
    );

    if (descriptionBlocks[0]) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(descriptionBlocks[0]),
      );
    }
  }

  for (const block of descriptionBlocks.slice(1)) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(block),
    );
  }

  if (fieldBlocks.length) {
    container.addSeparatorComponents(createSecurityLogSeparator());
    for (const block of fieldBlocks) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(block),
      );
    }
  }

  if (imageBuffer) {
    container.addSeparatorComponents(createSecurityLogSeparator());
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${imageName}`)
          .setDescription(normalizedTitle),
      ),
    );
  }

  if (safeButtonRows.length) {
    container.addSeparatorComponents(createSecurityLogSeparator());
    container.addActionRowComponents(...safeButtonRows);
  }

  container.addSeparatorComponents(
    createSecurityLogSeparator({
      divider: false,
      spacing: SeparatorSpacingSize.Small,
    }),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# Flowdesk Security Logs"),
  );

  const payload = {
    components: [container],
    flags,
    allowedMentions: { parse: [] },
  };

  if (imageBuffer) {
    payload.files = [new AttachmentBuilder(imageBuffer, { name: imageName })];
  }

  return payload;
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "Menos de 1 minuto";
  }

  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}min`);

  return parts.join(" ") || "Menos de 1 minuto";
}

async function sendSecurityLog({
  guild,
  settings,
  eventKey,
  color = 0x5ca9ff,
  title,
  description,
  fields = [],
  imageBuffer = null,
  imageName = "security-log.png",
  thumbnailUrl = null,
  buttonContext = null,
}) {
  const config = resolveEventConfig(settings, eventKey);
  if (!config.enabled || !config.channelId) return false;

  const channel = await resolveTextChannel(guild, config.channelId);
  if (!channel) return false;

  const payload = buildSecurityLogPayload({
    color,
    title: title || config.label,
    description,
    fields,
    imageBuffer,
    imageName,
    thumbnailUrl,
    buttonRows: buildSecurityLogActionRows(guild.id, eventKey, buttonContext),
  });

  const sent = await channel.send(payload).catch((error) => {
    const detail = error instanceof Error ? error.message : "falha ao enviar log";
    console.warn(
      `[security-logs] falha ao enviar log ${eventKey} em guild ${guild.id} canal ${config.channelId}: ${detail}`,
    );
    return null;
  });

  return Boolean(sent);
}

function isSecurityLogButtonInteraction(interaction) {
  return (
    interaction?.isButton?.() &&
    trimText(interaction.customId).startsWith(SECURITY_LOG_DETAILS_PREFIX)
  );
}

function buildSecurityLogDetailsFields(parsed) {
  switch (parsed?.code) {
    case "av":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        {
          name: "Escopo",
          value:
            parsed.scope === "global"
              ? "Avatar global da conta"
              : "Avatar especifico do servidor",
          inline: true,
        },
      ];
    case "nn":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId) },
      ];
    case "vj":
    case "vl":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Canal", value: formatChannelReference(parsed.channelId), inline: true },
      ];
    case "vm":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Movido por", value: formatUserReference(parsed.actorId), inline: true },
        { name: "Canal antigo", value: formatChannelReference(parsed.oldChannelId), inline: true },
        { name: "Canal novo", value: formatChannelReference(parsed.newChannelId), inline: true },
      ];
    case "vt":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
        { name: "Canal", value: formatChannelReference(parsed.channelId), inline: true },
        {
          name: "Estado",
          value: parsed.state === "muted" ? "Mutado em voz" : "Desmutado em voz",
          inline: true,
        },
      ];
    case "md":
    case "me":
      return [
        { name: "Autor", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Canal", value: formatChannelReference(parsed.channelId), inline: true },
      ];
    case "mb":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
      ];
    case "mu":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
      ];
    case "mk":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
      ];
    case "mt":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
        {
          name: "Silenciado ate",
          value: parsed.untilTimestamp ? formatDateTime(parsed.untilTimestamp) : "Nao informado",
        },
      ];
    default:
      return [];
  }
}

function buildSecurityLogDetailsTitle(parsed) {
  switch (parsed?.code) {
    case "av":
      return "Detalhes da alteracao de avatar";
    case "nn":
      return "Detalhes da alteracao de nickname";
    case "vj":
      return "Detalhes da entrada em call";
    case "vl":
      return "Detalhes da saida de call";
    case "vm":
      return "Detalhes da movimentacao de call";
    case "vt":
      return "Detalhes do mute em call";
    case "md":
      return "Detalhes da mensagem deletada";
    case "me":
      return "Detalhes da mensagem editada";
    case "mb":
      return "Detalhes do banimento";
    case "mu":
      return "Detalhes do desbanimento";
    case "mk":
      return "Detalhes da expulsao";
    case "mt":
      return "Detalhes do silenciamento";
    default:
      return "Detalhes da log";
  }
}

async function handleSecurityLogButtonInteraction(interaction) {
  const parsed = parseSecurityLogDetailsCustomId(interaction?.customId);
  if (!parsed) return false;

  const logUrl =
    interaction?.guildId && interaction?.channelId && interaction?.message?.id
      ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${interaction.message.id}`
      : null;
  const primaryChannelId =
    parsed.newChannelId || parsed.channelId || parsed.oldChannelId || null;
  const buttons = [];

  if (logUrl) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Abrir log")
        .setURL(logUrl),
    );
  }

  if (interaction?.guildId && primaryChannelId) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(parsed.code === "vm" ? "Abrir destino" : "Abrir canal")
        .setURL(
          `https://discord.com/channels/${interaction.guildId}/${primaryChannelId}`,
        ),
    );
  }

  await interaction.reply(
    buildSecurityLogPayload({
      color: 0x7b9cff,
      title: buildSecurityLogDetailsTitle(parsed),
      description: logUrl
        ? "Abrir a mensagem original ou navegar direto para o canal relacionado."
        : "Informacoes adicionais desta log de seguranca.",
      fields: buildSecurityLogDetailsFields(parsed),
      buttonRows: buildActionRowsFromButtons(buttons),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    }),
  );

  return true;
}

function drawRoundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.max(
    0,
    Math.min(radius, width / 2, height / 2),
  );

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawCoverImage(context, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const offsetX = x + (width - drawWidth) / 2;
  const offsetY = y + (height - drawHeight) / 2;
  context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

async function buildAvatarComparisonImage(oldAvatarUrl, newAvatarUrl) {
  const oldUrl = trimText(oldAvatarUrl);
  const newUrl = trimText(newAvatarUrl);
  if (!oldUrl || !newUrl) return null;

  const canvasApi = resolveCanvasModule();
  if (!canvasApi?.createCanvas || !canvasApi?.loadImage) {
    return null;
  }

  const { createCanvas, loadImage } = canvasApi;
  const width = 1200;
  const height = 620;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  const [oldImage, newImage] = await Promise.all([
    loadImage(oldUrl).catch(() => null),
    loadImage(newUrl).catch(() => null),
  ]);

  if (!oldImage || !newImage) return null;

  context.fillStyle = "#0a0d14";
  context.fillRect(0, 0, width, height);

  const framePadding = 22;
  const frameX = framePadding;
  const frameY = framePadding;
  const frameWidth = width - framePadding * 2;
  const frameHeight = height - framePadding * 2;
  const splitX = frameX + frameWidth / 2;

  context.fillStyle = "rgba(0, 0, 0, 0.32)";
  drawRoundedRect(context, frameX + 10, frameY + 14, frameWidth, frameHeight, 28);
  context.fill();

  context.save();
  drawRoundedRect(context, frameX, frameY, frameWidth, frameHeight, 28);
  context.clip();

  drawCoverImage(context, oldImage, frameX, frameY, frameWidth / 2, frameHeight);
  drawCoverImage(context, newImage, splitX, frameY, frameWidth / 2, frameHeight);

  const topFade = context.createLinearGradient(0, frameY, 0, frameY + 150);
  topFade.addColorStop(0, "rgba(0,0,0,0.28)");
  topFade.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = topFade;
  context.fillRect(frameX, frameY, frameWidth, 150);

  const bottomFade = context.createLinearGradient(0, frameY + frameHeight - 150, 0, frameY + frameHeight);
  bottomFade.addColorStop(0, "rgba(0,0,0,0)");
  bottomFade.addColorStop(1, "rgba(0,0,0,0.32)");
  context.fillStyle = bottomFade;
  context.fillRect(frameX, frameY + frameHeight - 150, frameWidth, 150);

  context.fillStyle = "rgba(255,255,255,0.12)";
  context.fillRect(splitX - 1.5, frameY, 3, frameHeight);

  context.restore();

  context.strokeStyle = "rgba(255,255,255,0.1)";
  context.lineWidth = 2;
  drawRoundedRect(context, frameX, frameY, frameWidth, frameHeight, 28);
  context.stroke();

  return canvas.toBuffer("image/png");
}

async function dispatchGuildMemberAvatarChange({
  guild,
  userId,
  beforeMemberAvatarHash,
  afterMemberAvatarHash,
  oldMember = null,
  newMember = null,
  fallbackUser = null,
}) {
  if (!guild?.id || !userId) return false;
  if (beforeMemberAvatarHash === afterMemberAvatarHash) {
    rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
    return false;
  }

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) {
    rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
    return false;
  }

  const config = resolveEventConfig(runtime.settings, "avatarChange");
  if (!config.enabled) {
    rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
    return false;
  }

  const oldAvatarUrl = resolveMemberAvatarUrlFromHash(
    guild.client,
    guild.id,
    userId,
    beforeMemberAvatarHash,
    oldMember,
    fallbackUser,
  );
  const newAvatarUrl = resolveMemberAvatarUrlFromHash(
    guild.client,
    guild.id,
    userId,
    afterMemberAvatarHash,
    newMember,
    fallbackUser,
  );
  const dedupeKey = [
    "avatar",
    "guild",
    guild.id,
    userId,
    beforeMemberAvatarHash || "none",
    afterMemberAvatarHash || "none",
  ].join(":");

  rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);

  if (registerRecentEvent(dedupeKey)) {
    return false;
  }

  const comparisonImage = await buildAvatarComparisonImage(
    oldAvatarUrl,
    newAvatarUrl,
  );

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "avatarChange",
    color: 0x7b9cff,
    title: "Avatar do servidor alterado",
    description: `Usuario: ${formatMemberLabel(newMember || oldMember || { id: userId })}`,
    imageBuffer: comparisonImage,
    imageName: `avatar-guild-compare-${userId}.png`,
    buttonContext: {
      targetId: userId,
      scope: "server",
      oldAvatarUrl,
      newAvatarUrl,
    },
  });

  return true;
}

async function dispatchGlobalAvatarChange({
  client,
  userId,
  beforeAvatarHash,
  afterAvatarHash,
  oldUser = null,
  newUser = null,
}) {
  if (!client?.guilds?.cache || !userId) return false;
  if (beforeAvatarHash === afterAvatarHash) {
    rememberGlobalAvatarHash(userId, afterAvatarHash);
    return false;
  }

  const oldAvatarUrl = resolveUserAvatarUrlFromHash(
    client,
    userId,
    beforeAvatarHash,
    oldUser,
  );
  const newAvatarUrl = resolveUserAvatarUrlFromHash(
    client,
    userId,
    afterAvatarHash,
    newUser,
  );
  const comparisonImage = await buildAvatarComparisonImage(
    oldAvatarUrl,
    newAvatarUrl,
  );

  rememberGlobalAvatarHash(userId, afterAvatarHash);

  let handled = false;
  for (const guild of client.guilds.cache.values()) {
    const member = await resolveMemberFromGuild(guild, userId);
    if (!member || member.user?.bot) {
      continue;
    }

    const runtime = await resolveRuntime(guild.id);
    if (!runtime?.settings) {
      continue;
    }

    const config = resolveEventConfig(runtime.settings, "avatarChange");
    if (!config.enabled) {
      continue;
    }

    const dedupeKey = [
      "avatar",
      "global",
      guild.id,
      userId,
      beforeAvatarHash || "none",
      afterAvatarHash || "none",
    ].join(":");

    if (registerRecentEvent(dedupeKey)) {
      continue;
    }

    await sendSecurityLog({
      guild,
      settings: runtime.settings,
      eventKey: "avatarChange",
      color: 0x7b9cff,
      title: "Avatar global alterado",
      description: `Usuario: ${formatMemberLabel(member)}`,
      imageBuffer: comparisonImage,
      imageName: `avatar-global-compare-${userId}.png`,
      buttonContext: {
        targetId: userId,
        scope: "global",
        oldAvatarUrl,
        newAvatarUrl,
      },
    });
    handled = true;
  }

  return handled;
}

async function handleNicknameOrAvatarUpdate(oldMember, newMember) {
  if (!newMember?.guild || !newMember?.id) return false;
  if (newMember.user?.bot) return false;

  const runtime = await resolveRuntime(newMember.guild.id);
  if (!runtime?.settings) return false;

  const settings = runtime.settings;
  const beforeNick = trimText(oldMember?.nickname || "");
  const afterNick = trimText(newMember.nickname || "");
  const beforeMemberAvatar = oldMember?.avatar || null;
  const afterMemberAvatar = newMember?.avatar || null;
  let handled = false;

  rememberGlobalAvatarHash(newMember.id, newMember.user?.avatar || null);
  rememberGuildAvatarHash(newMember.guild.id, newMember.id, afterMemberAvatar);

  if (beforeNick !== afterNick) {
    const config = resolveEventConfig(settings, "nicknameChange");
    if (config.enabled) {
      handled = true;
      await sendSecurityLog({
        guild: newMember.guild,
        settings,
        eventKey: "nicknameChange",
        color: 0x6a9cff,
        title: "Nickname alterado",
        description: `Usuario: ${formatMemberLabel(newMember)}`,
        thumbnailUrl: resolveStaticMemberAvatarUrl(newMember),
      fields: [
        {
          name: "Nickname antigo",
          value: beforeNick || "(sem nickname)",
          },
          {
            name: "Nickname novo",
            value: afterNick || "(sem nickname)",
          },
        ],
        buttonContext: {
          targetId: newMember.id,
        },
      });
    }
  }

  if (beforeMemberAvatar !== afterMemberAvatar) {
    handled =
      (await dispatchGuildMemberAvatarChange({
        guild: newMember.guild,
        userId: newMember.id,
        beforeMemberAvatarHash: beforeMemberAvatar,
        afterMemberAvatarHash: afterMemberAvatar,
        oldMember,
        newMember,
        fallbackUser: newMember.user || oldMember?.user || null,
      })) || handled;
  }

  const beforeTimeout = oldMember?.communicationDisabledUntilTimestamp || null;
  const afterTimeout = newMember?.communicationDisabledUntilTimestamp || null;
  const timeoutWasApplied =
    Number.isFinite(afterTimeout) &&
    afterTimeout > Date.now() &&
    (!Number.isFinite(beforeTimeout) || afterTimeout !== beforeTimeout);

  if (timeoutWasApplied) {
    const config = resolveEventConfig(settings, "memberTimeout");
    if (config.enabled) {
      const timeoutAuditEntry =
        (await resolveAuditEntry(newMember.guild, {
          type: AuditLogEvent.MemberUpdate,
          targetId: newMember.id,
          maxAgeMs: 45_000,
          retryDelaysMs: [0, 900, 1_400, 2_000],
          predicate: (entry) =>
            Array.isArray(entry.changes) &&
            entry.changes.some(
              (change) =>
                String(change?.key || "").toLowerCase() ===
                "communication_disabled_until",
            ),
        })) ||
        (await resolveAuditEntry(newMember.guild, {
          type: AuditLogEvent.AutoModerationUserCommunicationDisabled,
          targetId: newMember.id,
          maxAgeMs: 45_000,
          retryDelaysMs: [0, 900, 1_500],
        }));
      const executor = timeoutAuditEntry?.executor || null;
      const reason = trimText(timeoutAuditEntry?.reason || "");
      const dedupeKey = ["timeout", newMember.guild.id, newMember.id, afterTimeout].join(":");

      if (!registerRecentEvent(dedupeKey)) {
        handled = true;

        await sendSecurityLog({
          guild: newMember.guild,
          settings,
          eventKey: "memberTimeout",
          color: 0xffab4a,
          title: "Membro silenciado",
          description: `Usuario: ${formatMemberLabel(newMember)}`,
          fields: [
            {
              name: "Silenciado ate",
              value: formatDateTime(afterTimeout),
            },
            {
              name: "Duracao aproximada",
              value: formatDurationMs(afterTimeout - Date.now()),
              inline: true,
            },
            {
              name: "Executado por",
              value: executor ? formatUserLabel(executor) : "Nao identificado",
              inline: true,
            },
            {
              name: "Motivo",
              value: reason || "Nao informado",
            },
          ],
          thumbnailUrl: resolveStaticMemberAvatarUrl(newMember),
          buttonContext: {
            targetId: newMember.id,
            actorId: executor?.id || null,
            untilTimestamp: afterTimeout,
          },
        });
      }
    }
  }

  return handled;
}

async function resolveMemberFromGuild(guild, userId) {
  if (!guild || !userId) return null;
  return (
    guild.members.cache.get(userId) ||
    (await guild.members.fetch(userId).catch(() => null))
  );
}

async function handleUserAvatarUpdate(oldUser, newUser, client) {
  if (!client?.guilds?.cache || !newUser?.id) return false;
  if (newUser.bot) return false;

  const beforeAvatar = oldUser?.avatar || null;
  const afterAvatar = newUser?.avatar || null;
  return dispatchGlobalAvatarChange({
    client,
    userId: newUser.id,
    beforeAvatarHash: beforeAvatar,
    afterAvatarHash: afterAvatar,
    oldUser,
    newUser,
  });
}

async function handleRawSecurityPacket(packet, client) {
  if (!packet?.t || !client) return false;

  if (packet.t === "USER_UPDATE") {
    const userId = trimText(packet.d?.id);
    if (!userId || packet.d?.bot === true) return false;
    if (!Object.prototype.hasOwnProperty.call(packet.d || {}, "avatar")) return false;

    const beforeAvatarHash = getKnownGlobalAvatarHash(client, userId);
    const afterAvatarHash = packet.d.avatar || null;
    const cachedUser = client.users?.cache?.get(userId) || null;

    if (beforeAvatarHash === undefined) {
      rememberGlobalAvatarHash(userId, afterAvatarHash);
      return false;
    }

    return dispatchGlobalAvatarChange({
      client,
      userId,
      beforeAvatarHash,
      afterAvatarHash,
      oldUser: cachedUser,
      newUser: cachedUser,
    });
  }

  if (packet.t === "GUILD_MEMBER_UPDATE") {
    const guildId = trimText(packet.d?.guild_id);
    const userId = trimText(packet.d?.user?.id);
    if (!guildId || !userId || packet.d?.user?.bot === true) return false;

    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return false;

    const cachedUser = client.users?.cache?.get(userId) || null;
    const cachedMember = guild.members?.cache?.get(userId) || null;
    let handled = false;

    if (Object.prototype.hasOwnProperty.call(packet.d || {}, "avatar")) {
      const beforeMemberAvatarHash = getKnownGuildAvatarHash(guild, userId);
      const afterMemberAvatarHash = packet.d.avatar || null;

      if (beforeMemberAvatarHash === undefined) {
        rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
      } else {
        handled =
          (await dispatchGuildMemberAvatarChange({
            guild,
            userId,
            beforeMemberAvatarHash,
            afterMemberAvatarHash,
            oldMember: cachedMember,
            newMember: cachedMember,
            fallbackUser: cachedUser,
          })) || handled;
      }
    }

    if (Object.prototype.hasOwnProperty.call(packet.d?.user || {}, "avatar")) {
      const beforeAvatarHash = getKnownGlobalAvatarHash(client, userId);
      const afterAvatarHash = packet.d.user.avatar || null;

      if (beforeAvatarHash === undefined) {
        rememberGlobalAvatarHash(userId, afterAvatarHash);
      } else {
        handled =
          (await dispatchGlobalAvatarChange({
            client,
            userId,
            beforeAvatarHash,
            afterAvatarHash,
            oldUser: cachedUser,
            newUser: cachedUser,
          })) || handled;
      }
    }

    return handled;
  }

  return false;
}

async function handleVoiceStateSecurityLog(oldState, newState) {
  const guild = newState?.guild || oldState?.guild;
  if (!guild || !newState?.id) return false;
  if (newState.member?.user?.bot) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) {
    rememberVoiceStateSnapshot(guild.id, newState.id, {
      channelId: newState?.channelId ?? null,
      serverMute:
        typeof newState?.serverMute === "boolean" ? newState.serverMute : null,
      serverDeaf:
        typeof newState?.serverDeaf === "boolean" ? newState.serverDeaf : null,
    });
    return false;
  }
  const settings = runtime.settings;
  const snapshot = getKnownVoiceStateSnapshot(guild.id, newState.id);
  const oldChannelId = oldState?.channelId ?? snapshot?.channelId ?? null;
  const newChannelId = newState?.channelId ?? null;
  const oldChannel = resolveVoiceChannel(guild, oldChannelId, oldState?.channel || null);
  const newChannel = resolveVoiceChannel(guild, newChannelId, newState?.channel || null);
  const oldServerMute =
    typeof oldState?.serverMute === "boolean"
      ? oldState.serverMute
      : typeof snapshot?.serverMute === "boolean"
        ? snapshot.serverMute
        : null;
  const newServerMute =
    typeof newState?.serverMute === "boolean" ? newState.serverMute : null;
  const memberLabel = formatMemberLabel(
    newState.member || oldState.member || { id: newState.id },
  );
  let handled = false;

  if (!oldChannel && newChannel) {
    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceJoin",
      color: 0x53c46f,
      title: "Entrou em canal de voz",
      description: `Usuario: ${memberLabel}`,
      thumbnailUrl: resolveStaticMemberAvatarUrl(newState.member),
      fields: [{ name: "Canal", value: `<#${newChannel.id}>` }],
      buttonContext: {
        targetId: newState.id,
        channelId: newChannel.id,
      },
    });
    handled = true;
  }

  if (oldChannel && !newChannel) {
    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceLeave",
      color: 0xff9b6a,
      title: "Saiu de canal de voz",
      description: `Usuario: ${memberLabel}`,
      thumbnailUrl: resolveStaticMemberAvatarUrl(oldState.member),
      fields: [{ name: "Canal anterior", value: `<#${oldChannel.id}>` }],
      buttonContext: {
        targetId: newState.id,
        channelId: oldChannel.id,
      },
    });
    handled = true;
  }

  if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    const moveConfig = resolveEventConfig(settings, "voiceMove");
    if (moveConfig.enabled) {
      const moveAuditEntry = await resolveAuditEntry(guild, {
        type: AuditLogEvent.MemberMove,
        targetId: newState.id,
        maxAgeMs: 45_000,
        retryDelaysMs: [0, 650, 1_000, 1_600],
        limit: 20,
        allowUnknownTarget: true,
        predicate: (entry) => {
          const auditChannelId = entry?.extra?.channel?.id;
          return (
            !auditChannelId ||
            auditChannelId === oldChannel.id ||
            auditChannelId === newChannel.id
          );
        },
      });
      const executor = moveAuditEntry?.executor || null;
      const reason = trimText(moveAuditEntry?.reason || "");
      const movedByModerator = executor?.id && executor.id !== newState.id;
      const dedupeKey = [
        "voice-move",
        guild.id,
        newState.id,
        oldChannel.id,
        newChannel.id,
        executor?.id || "self",
      ].join(":");

      if (!registerRecentEvent(dedupeKey)) {
        await sendSecurityLog({
          guild,
          settings,
          eventKey: "voiceMove",
          color: movedByModerator ? 0x79a6ff : 0x6cb8ff,
          title: movedByModerator
            ? "Membro movido de call"
            : "Membro trocou de canal de voz",
          description: `Usuario: ${memberLabel}`,
          thumbnailUrl: resolveStaticMemberAvatarUrl(newState.member || oldState.member),
          fields: [
            { name: "Canal antigo", value: `<#${oldChannel.id}>`, inline: true },
            { name: "Canal novo", value: `<#${newChannel.id}>`, inline: true },
            {
              name: movedByModerator ? "Executado por" : "Origem do movimento",
              value: movedByModerator
                ? formatUserLabel(executor)
                : "Mudanca direta do usuario ou auditoria indisponivel",
            },
            {
              name: "Motivo",
              value: reason || "Nao informado",
            },
          ],
          buttonContext: {
            targetId: newState.id,
            actorId: executor?.id || null,
            oldChannelId: oldChannel.id,
            newChannelId: newChannel.id,
          },
        });
        handled = true;
      }
    }
  }

  const voiceMuteChanged =
    typeof oldServerMute === "boolean" &&
    typeof newServerMute === "boolean" &&
    oldServerMute !== newServerMute;

  if (voiceMuteChanged) {
    const muteConfig = resolveEventConfig(settings, "voiceMute");
    if (muteConfig.enabled) {
      const muteAuditEntry = await resolveAuditEntry(guild, {
        type: AuditLogEvent.MemberUpdate,
        targetId: newState.id,
        maxAgeMs: 45_000,
        retryDelaysMs: [0, 650, 1_000, 1_600],
        limit: 20,
        predicate: (entry) => hasAuditChangeKey(entry, ["mute"]),
      });
      const executor = muteAuditEntry?.executor || null;
      const reason = trimText(muteAuditEntry?.reason || "");
      const currentChannel = newChannel || oldChannel;
      const dedupeKey = [
        "voice-mute",
        guild.id,
        newState.id,
        oldServerMute ? "muted" : "unmuted",
        newServerMute ? "muted" : "unmuted",
      ].join(":");

      if (!registerRecentEvent(dedupeKey)) {
        await sendSecurityLog({
          guild,
          settings,
          eventKey: "voiceMute",
          color: newServerMute ? 0xffb24d : 0x63d39a,
          title: newServerMute
            ? "Membro mutado na call"
            : "Membro desmutado na call",
          description: `Usuario: ${memberLabel}`,
          thumbnailUrl: resolveStaticMemberAvatarUrl(newState.member || oldState.member),
          fields: [
            {
              name: "Canal",
              value: currentChannel ? `<#${currentChannel.id}>` : "Nao identificado",
              inline: true,
            },
            {
              name: "Executado por",
              value: executor ? formatUserLabel(executor) : "Nao identificado",
              inline: true,
            },
            {
              name: "Motivo",
              value: reason || "Nao informado",
            },
          ],
          buttonContext: {
            targetId: newState.id,
            actorId: executor?.id || null,
            channelId: currentChannel?.id || null,
            state: newServerMute ? "muted" : "unmuted",
          },
        });
        handled = true;
      }
    }
  }

  rememberVoiceStateSnapshot(guild.id, newState.id, {
    channelId: newChannelId,
    serverMute: newServerMute,
    serverDeaf:
      typeof newState?.serverDeaf === "boolean" ? newState.serverDeaf : null,
  });

  return handled;
}

async function handleMessageDeleteSecurityLog(message) {
  if (!message?.guild || !message?.guildId) return false;
  if (message.author?.bot || message.webhookId) return false;

  const runtime = await resolveRuntime(message.guildId);
  if (!runtime?.settings) return false;

  const authorLabel = message.author
    ? formatUserLabel(message.author)
    : "Nao identificado";
  const channelLabel = message.channelId ? `<#${message.channelId}>` : "Nao identificado";

  await sendSecurityLog({
    guild: message.guild,
    settings: runtime.settings,
    eventKey: "messageDelete",
    color: 0xe08989,
    title: "Mensagem deletada",
    description: `Autor: ${authorLabel}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(message.author),
    fields: [
      {
        name: "Canal",
        value: channelLabel,
        inline: true,
      },
      {
        name: "Conteudo",
        value: toCodeBlock(message.content, 700),
      },
    ],
    buttonContext: {
      targetId: message.author?.id || null,
      channelId: message.channelId || null,
    },
  });

  return true;
}

async function handleMessageEditSecurityLog(oldMessage, newMessage) {
  const guild = newMessage?.guild || oldMessage?.guild;
  const guildId = newMessage?.guildId || oldMessage?.guildId;
  if (!guild || !guildId) return false;

  const author = newMessage?.author || oldMessage?.author;
  if (author?.bot) return false;

  const oldContent = trimText(oldMessage?.content || "");
  const newContent = trimText(newMessage?.content || "");
  if (oldContent === newContent) return false;

  const runtime = await resolveRuntime(guildId);
  if (!runtime?.settings) return false;

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "messageEdit",
    color: 0x69b7ff,
    title: "Mensagem editada",
    description: `Autor: ${author ? formatUserLabel(author) : "Nao identificado"}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(author),
    fields: [
      {
        name: "Canal",
        value: newMessage?.channelId
          ? `<#${newMessage.channelId}>`
          : oldMessage?.channelId
            ? `<#${oldMessage.channelId}>`
            : "Nao identificado",
      },
      {
        name: "Conteudo antigo",
        value: toCodeBlock(oldContent || "(indisponivel)", 520),
      },
      {
        name: "Conteudo novo",
        value: toCodeBlock(newContent || "(indisponivel)", 520),
      },
    ],
    buttonContext: {
      targetId: author?.id || null,
      channelId: newMessage?.channelId || oldMessage?.channelId || null,
    },
  });

  return true;
}

async function handleGuildBanAddSecurityLog(ban) {
  const guild = ban?.guild;
  const user = ban?.user;
  if (!guild || !user?.id) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) return false;

  const auditEntry = await resolveAuditEntry(guild, {
    type: AuditLogEvent.MemberBanAdd,
    targetId: user.id,
    maxAgeMs: 35_000,
  });
  const executor = auditEntry?.executor || null;
  const reason = trimText(auditEntry?.reason || "");

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "memberBan",
    color: 0xe86363,
    title: "Membro banido",
    description: `Alvo: ${formatUserLabel(user)}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(user),
    fields: [
      {
        name: "Executado por",
        value: executor ? formatUserLabel(executor) : "Nao identificado",
      },
      {
        name: "Motivo",
        value: reason || "Nao informado",
      },
    ],
    buttonContext: {
      targetId: user.id,
      actorId: executor?.id || null,
    },
  });

  return true;
}

async function handleGuildBanRemoveSecurityLog(ban) {
  const guild = ban?.guild;
  const user = ban?.user;
  if (!guild || !user?.id) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) return false;

  const auditEntry = await resolveAuditEntry(guild, {
    type: AuditLogEvent.MemberBanRemove,
    targetId: user.id,
    maxAgeMs: 35_000,
  });
  const executor = auditEntry?.executor || null;
  const reason = trimText(auditEntry?.reason || "");

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "memberUnban",
    color: 0x6ac985,
    title: "Membro desbanido",
    description: `Alvo: ${formatUserLabel(user)}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(user),
    fields: [
      {
        name: "Executado por",
        value: executor ? formatUserLabel(executor) : "Nao identificado",
      },
      {
        name: "Motivo",
        value: reason || "Nao informado",
      },
    ],
    buttonContext: {
      targetId: user.id,
      actorId: executor?.id || null,
    },
  });

  return true;
}

async function handleMemberRemoveSecurityLog(member) {
  if (!member?.guild || !member?.id) return false;
  if (member.user?.bot) return false;

  const runtime = await resolveRuntime(member.guild.id);
  if (!runtime?.settings) return false;

  const config = resolveEventConfig(runtime.settings, "memberKick");
  if (!config.enabled) return false;

  const kickAuditEntry = await resolveAuditEntry(member.guild, {
    type: AuditLogEvent.MemberKick,
    targetId: member.id,
    maxAgeMs: 60_000,
    limit: 20,
    retryDelaysMs: KICK_AUDIT_RETRY_DELAYS_MS,
  });

  if (!kickAuditEntry) return false;

  const dedupeKey = ["kick", member.guild.id, member.id, kickAuditEntry.id].join(":");
  if (registerRecentEvent(dedupeKey, 30_000)) {
    return false;
  }

  await sendSecurityLog({
    guild: member.guild,
    settings: runtime.settings,
    eventKey: "memberKick",
    color: 0xff9c5f,
    title: "Membro expulso",
    description: `Alvo: ${formatMemberLabel(member)}`,
    thumbnailUrl: resolveStaticMemberAvatarUrl(member),
    fields: [
      {
        name: "Executado por",
        value: kickAuditEntry.executor
          ? formatUserLabel(kickAuditEntry.executor)
          : "Nao identificado",
      },
      {
        name: "Motivo",
        value: trimText(kickAuditEntry.reason || "") || "Nao informado",
      },
    ],
    buttonContext: {
      targetId: member.id,
      actorId: kickAuditEntry.executor?.id || null,
    },
  });

  return true;
}

module.exports = {
  handleGuildBanAddSecurityLog,
  handleGuildBanRemoveSecurityLog,
  handleMemberRemoveSecurityLog,
  handleMessageDeleteSecurityLog,
  handleMessageEditSecurityLog,
  handleNicknameOrAvatarUpdate,
  handleRawSecurityPacket,
  handleSecurityLogButtonInteraction,
  handleUserAvatarUpdate,
  handleVoiceStateSecurityLog,
  isSecurityLogButtonInteraction,
};
