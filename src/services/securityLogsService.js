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
const { getGuildSecurityLogsRuntime } = require("./supabaseService");

const RUNTIME_CACHE_TTL_MS = 10_000;
const runtimeCache = new Map();

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

async function resolveAuditExecutor(guild, input) {
  const {
    type,
    targetId = null,
    maxAgeMs = 16_000,
    predicate = null,
  } = input;

  if (!guild) return null;

  const logs = await guild.fetchAuditLogs({ type, limit: 8 }).catch(() => null);
  if (!logs) return null;

  const now = Date.now();
  for (const entry of logs.entries.values()) {
    if (!entry?.executor?.id) continue;
    if (typeof entry.createdTimestamp !== "number") continue;
    if (now - entry.createdTimestamp > maxAgeMs) continue;

    if (targetId && entry.target?.id && entry.target.id !== targetId) {
      continue;
    }

    if (typeof predicate === "function" && !predicate(entry)) {
      continue;
    }

    return entry.executor;
  }

  return null;
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
  const height = 600;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  const [oldImage, newImage] = await Promise.all([
    loadImage(oldUrl).catch(() => null),
    loadImage(newUrl).catch(() => null),
  ]);

  if (!oldImage || !newImage) return null;

  context.fillStyle = "#0b0b0b";
  context.fillRect(0, 0, width, height);

  context.save();
  context.beginPath();
  context.rect(0, 0, width / 2, height);
  context.clip();
  context.drawImage(oldImage, 0, 0, width / 2, height);
  context.restore();

  context.save();
  context.beginPath();
  context.rect(width / 2, 0, width / 2, height);
  context.clip();
  context.drawImage(newImage, width / 2, 0, width / 2, height);
  context.restore();

  context.fillStyle = "rgba(0,0,0,0.35)";
  context.fillRect(0, height - 64, width / 2, 64);
  context.fillRect(width / 2, height - 64, width / 2, 64);

  context.fillStyle = "#f1f1f1";
  context.font = "bold 28px Sans";
  context.fillText("Avatar antigo", 26, height - 24);
  context.fillText("Avatar novo", width / 2 + 26, height - 24);

  context.fillStyle = "rgba(255,255,255,0.88)";
  context.fillRect(width / 2 - 1, 0, 2, height);

  return canvas.toBuffer("image/png");
}

async function handleNicknameOrAvatarUpdate(oldMember, newMember) {
  if (!newMember?.guild || !newMember?.id) return false;
  if (newMember.user?.bot) return false;

  const runtime = await resolveRuntime(newMember.guild.id);
  if (!runtime?.settings) return false;

  const settings = runtime.settings;
  const beforeNick = trimText(oldMember?.nickname || oldMember?.user?.username || "");
  const afterNick = trimText(newMember.nickname || newMember.user?.username || "");
  const beforeAvatar = oldMember?.user?.avatar || null;
  const afterAvatar = newMember.user?.avatar || null;
  let handled = false;

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

  if (beforeAvatar !== afterAvatar) {
    const config = resolveEventConfig(settings, "avatarChange");
    if (config.enabled) {
      handled = true;

      const oldAvatarUrl = oldMember?.user?.displayAvatarURL({
        extension: "png",
        forceStatic: true,
        size: 512,
      });
      const newAvatarUrl = newMember.user?.displayAvatarURL({
        extension: "png",
        forceStatic: true,
        size: 512,
      });
      const comparisonImage = await buildAvatarComparisonImage(
        oldAvatarUrl,
        newAvatarUrl,
      );

      await sendSecurityLog({
        guild: newMember.guild,
        settings,
        eventKey: "avatarChange",
        color: 0x7b9cff,
        title: "Avatar alterado",
        description: `Usuario: ${formatMemberLabel(newMember)}`,
        fields: [
          {
            name: "Avatar antigo",
            value: oldAvatarUrl || "(indisponivel)",
          },
          {
            name: "Avatar novo",
            value: newAvatarUrl || "(indisponivel)",
          },
        ],
        imageBuffer: comparisonImage,
        imageName: `avatar-compare-${newMember.id}.png`,
      });
    }
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
      handled = true;

      const executor = await resolveAuditExecutor(newMember.guild, {
        type: AuditLogEvent.MemberUpdate,
        targetId: newMember.id,
        predicate: (entry) =>
          Array.isArray(entry.changes) &&
          entry.changes.some(
            (change) =>
              String(change?.key || "").toLowerCase() ===
              "communication_disabled_until",
          ),
      });

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
            name: "Executado por",
            value: executor ? formatUserLabel(executor) : "Nao identificado",
          },
        ],
      });
    }
  }

  return handled;
}

async function handleVoiceStateSecurityLog(oldState, newState) {
  const guild = newState?.guild || oldState?.guild;
  if (!guild || !newState?.id) return false;
  if (newState.member?.user?.bot) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) return false;
  const settings = runtime.settings;

  const oldChannel = oldState?.channel || null;
  const newChannel = newState?.channel || null;

  if (!oldChannel && newChannel) {
    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceJoin",
      color: 0x53c46f,
      title: "Entrou em canal de voz",
      description: `Usuario: <@${newState.id}>`,
      fields: [
        { name: "Canal", value: `<#${newChannel.id}>` },
      ],
    });
    return true;
  }

  if (oldChannel && !newChannel) {
    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceLeave",
      color: 0xff9b6a,
      title: "Saiu de canal de voz",
      description: `Usuario: <@${newState.id}>`,
      fields: [
        { name: "Canal anterior", value: `<#${oldChannel.id}>` },
      ],
    });
    return true;
  }

  if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
    let executor = await resolveAuditExecutor(guild, {
      type: AuditLogEvent.MemberMove,
      targetId: newState.id,
    });
    if (!executor) {
      await new Promise((resolve) => {
        setTimeout(resolve, 900);
      });
      executor = await resolveAuditExecutor(guild, {
        type: AuditLogEvent.MemberMove,
        targetId: newState.id,
      });
    }

    if (!executor || executor.id === newState.id) {
      return false;
    }

    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceMove",
      color: 0x79a6ff,
      title: "Membro movido de call",
      description: `Usuario: <@${newState.id}>`,
      fields: [
        { name: "Canal antigo", value: `<#${oldChannel.id}>`, inline: true },
        { name: "Canal novo", value: `<#${newChannel.id}>`, inline: true },
        {
          name: "Executado por",
          value: executor ? formatUserLabel(executor) : "Nao identificado",
        },
      ],
    });
    return true;
  }

  return false;
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

  const executor = await resolveAuditExecutor(guild, {
    type: AuditLogEvent.MemberBanAdd,
    targetId: user.id,
  });

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

  const executor = await resolveAuditExecutor(guild, {
    type: AuditLogEvent.MemberBanRemove,
    targetId: user.id,
  });

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

  const kickExecutor = await resolveAuditExecutor(member.guild, {
    type: AuditLogEvent.MemberKick,
    targetId: member.id,
  });

  if (!kickExecutor) return false;

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
        value: formatUserLabel(kickExecutor),
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
  handleVoiceStateSecurityLog,
};
