const {
  AttachmentBuilder,
  AuditLogEvent,
  ContainerBuilder,
  EmbedBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
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
    for (const entry of logs.entries.values()) {
      if (!entry?.executor?.id) continue;
      if (typeof entry.createdTimestamp !== "number") continue;
      if (now - entry.createdTimestamp > maxAgeMs) continue;

      const entryTargetId = resolveAuditEntryTargetId(entry);
      if (targetId && entryTargetId !== targetId) {
        continue;
      }

      if (typeof predicate === "function" && !predicate(entry)) {
        continue;
      }

      return entry;
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
}) {
  const config = resolveEventConfig(settings, eventKey);
  if (!config.enabled || !config.channelId) return false;

  const channel = await resolveTextChannel(guild, config.channelId);
  if (!channel) return false;

  const safeFields = normalizeSecurityLogFields(fields);
  const timestampUnix = Math.floor(Date.now() / 1000);
  const headerTitle = toSnippet(title || config.label, 180);
  const headerLines = [`## ${headerTitle}`];
  const metaLines = [];
  const normalizedDescription = String(description || "").trim();

  if (normalizedDescription) {
    metaLines.push(`-# ${normalizedDescription}`);
  }
  metaLines.push(`-# Registrado em <t:${timestampUnix}:F>`);

  headerLines.push(metaLines.join("\n"));

  const fieldChunks = chunkTextBlocks(
    safeFields.map((field) => `### ${field.name}\n${field.value}`),
  );

  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(headerLines.join("\n\n")),
    );

  if (fieldChunks.length) {
    container.addSeparatorComponents(
      new SeparatorBuilder()
        .setSpacing(SeparatorSpacingSize.Small)
        .setDivider(true),
    );

    for (const chunk of fieldChunks) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(chunk),
      );
    }
  }

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [container],
  };

  if (imageBuffer) {
    container
      .addSeparatorComponents(
        new SeparatorBuilder()
          .setSpacing(SeparatorSpacingSize.Small)
          .setDivider(true),
      )
      .addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(`attachment://${imageName}`),
        ),
      );

    payload.files = [new AttachmentBuilder(imageBuffer, { name: imageName })];
  }

  const sent = await channel.send(payload).catch(() => null);
  if (sent) return true;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title || config.label)
    .setDescription(description || "")
    .setTimestamp(new Date());

  if (safeFields.length) {
    embed.addFields(safeFields);
  }

  const fallbackPayload = {
    embeds: [embed],
    allowedMentions: { parse: [] },
  };

  if (imageBuffer) {
    const attachment = new AttachmentBuilder(imageBuffer, { name: imageName });
    embed.setImage(`attachment://${imageName}`);
    fallbackPayload.files = [attachment];
  }

  const fallbackSent = await channel.send(fallbackPayload).catch((error) => {
    const detail = error instanceof Error ? error.message : "falha ao enviar log";
    console.warn(
      `[security-logs] falha ao enviar log ${eventKey} em guild ${guild.id} canal ${config.channelId}: ${detail}`,
    );
    return null;
  });

  return Boolean(fallbackSent);
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
      fields: [{ name: "Canal", value: `<#${newChannel.id}>` }],
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
      fields: [{ name: "Canal anterior", value: `<#${oldChannel.id}>` }],
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
        retryDelaysMs: [0, 450, 850],
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
        retryDelaysMs: [0, 450, 850],
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
  handleUserAvatarUpdate,
  handleVoiceStateSecurityLog,
};
