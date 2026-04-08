const {
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} = require("discord.js");
const { getGuildAntiLinkRuntime } = require("./supabaseService");

const RUNTIME_CACHE_TTL_MS = 10_000;
const runtimeCache = new Map();

const HTTP_LINK_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>()]+/i;
const DISCORD_INVITE_REGEX =
  /\b(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)[a-z0-9-]{2,}\b/i;
const GENERIC_DOMAIN_REGEX =
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})\b/i;
const PLAIN_DOMAIN_REGEX =
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\s*[\.\u2024\u3002\uFF0E]\s*|\s+dot\s+)(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})\b/i;
const MARKDOWN_HIDDEN_LINK_REGEX = /\[[^\]]{1,180}\]\(([^)]+)\)/i;
const OBFUSCATED_HTTP_REGEX =
  /h\s*[tx]\s*[tx]\s*p\s*s?\s*(?:[:\]\)]|\scolon\s)?\s*(?:\/|\sslash\s)\s*(?:\/|\sslash\s)/i;

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase();
}

function normalizeCompact(value) {
  return normalizeText(value).replace(
    /[\s`~!@#$%^&*()_+=[\]{}|;:'",<>/?\\.-]+/g,
    "",
  );
}

function normalizeDeobfuscated(value) {
  return normalizeText(value)
    .replace(/hxxps?/g, (match) => (match === "hxxps" ? "https" : "http"))
    .replace(/\((dot)\)|\[(dot)\]|\{(dot)\}|\sdot\s/g, ".")
    .replace(/\((slash)\)|\[(slash)\]|\{(slash)\}|\sslash\s/g, "/")
    .replace(/\((colon)\)|\[(colon)\]|\{(colon)\}|\scolon\s/g, ":")
    .replace(/\s+/g, "");
}

function normalizeAction(value) {
  if (value === "timeout" || value === "kick" || value === "ban") {
    return value;
  }
  return "delete_only";
}

function normalizeTimeoutMinutes(value) {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(10080, Math.max(1, parsed));
}

function detectViolation(content, settings) {
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const compact = normalizeCompact(content);
  const deobfuscated = normalizeDeobfuscated(content);

  if (
    settings.block_discord_invites !== false &&
    (DISCORD_INVITE_REGEX.test(normalized) ||
      /discord\s*[\.\u2024\u3002\uFF0E]?\s*gg\b/.test(normalized) ||
      compact.includes("discordgg") ||
      compact.includes("discordcominvite") ||
      deobfuscated.includes("discord.gg/") ||
      deobfuscated.includes("discord.com/invite/"))
  ) {
    return {
      rule: "discord_invite",
      reason: "convite do Discord detectado",
    };
  }

  if (
    settings.block_external_links !== false &&
    MARKDOWN_HIDDEN_LINK_REGEX.test(normalized)
  ) {
    return {
      rule: "markdown_hidden_link",
      reason: "link escondido em texto markdown",
    };
  }

  if (
    settings.block_external_links !== false &&
    (HTTP_LINK_REGEX.test(normalized) ||
      GENERIC_DOMAIN_REGEX.test(normalized) ||
      PLAIN_DOMAIN_REGEX.test(normalized))
  ) {
    return {
      rule: "external_link",
      reason: "link externo detectado",
    };
  }

  if (
    settings.block_obfuscated_links !== false &&
    (OBFUSCATED_HTTP_REGEX.test(normalized) ||
      deobfuscated.includes("http://") ||
      deobfuscated.includes("https://") ||
      (deobfuscated.includes("www.") && GENERIC_DOMAIN_REGEX.test(deobfuscated)) ||
      PLAIN_DOMAIN_REGEX.test(deobfuscated) ||
      GENERIC_DOMAIN_REGEX.test(deobfuscated))
  ) {
    return {
      rule: "obfuscated_link",
      reason: "link ofuscado detectado",
    };
  }

  return null;
}

function formatSnippet(content) {
  const normalized = String(content || "")
    .replace(/`/g, "'")
    .replace(/\[[^\]]{1,180}\]\(([^)]+)\)/gi, "[link removido]")
    .replace(
      /\b(?:https?:\/\/|hxxps?:\/\/|www\.)[^\s<>()]+/gi,
      "[link removido]",
    )
    .replace(
      /\b(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)[a-z0-9-]{2,}\b/gi,
      "[convite removido]",
    )
    .replace(
      /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})\b/gi,
      "[dominio removido]",
    )
    .trim();
  if (!normalized) return "(mensagem sem texto)";
  if (normalized.length <= 260) return normalized;
  return `${normalized.slice(0, 257)}...`;
}

function resolveActionLabel(action, timeoutMinutes) {
  if (action === "timeout") return `Silenciar por ${timeoutMinutes} min`;
  if (action === "kick") return "Expulsar usuario";
  if (action === "ban") return "Banir usuario";
  return "Apenas apagar mensagem";
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

  const runtime = await getGuildAntiLinkRuntime(guildId).catch(() => null);
  runtimeCache.set(guildId, {
    value: runtime,
    expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS,
  });
  return runtime;
}

async function resolveMember(message) {
  if (message?.member) return message.member;
  if (!message?.guild || !message?.author?.id) return null;
  return message.guild.members.fetch(message.author.id).catch(() => null);
}

function resolveMessageTextForDetection(message) {
  const fragments = [];

  if (typeof message?.content === "string" && message.content.trim()) {
    fragments.push(message.content.trim());
  }

  if (
    typeof message?.cleanContent === "string" &&
    message.cleanContent.trim() &&
    message.cleanContent.trim() !== message.content?.trim()
  ) {
    fragments.push(message.cleanContent.trim());
  }

  if (Array.isArray(message?.embeds) && message.embeds.length) {
    for (const embed of message.embeds) {
      if (typeof embed?.title === "string" && embed.title.trim()) {
        fragments.push(embed.title.trim());
      }
      if (typeof embed?.description === "string" && embed.description.trim()) {
        fragments.push(embed.description.trim());
      }
      if (typeof embed?.url === "string" && embed.url.trim()) {
        fragments.push(embed.url.trim());
      }
      if (Array.isArray(embed?.fields)) {
        for (const field of embed.fields) {
          if (typeof field?.value === "string" && field.value.trim()) {
            fragments.push(field.value.trim());
          }
        }
      }
    }
  }

  return fragments.join("\n");
}

async function applyModerationAction({
  message,
  member,
  action,
  timeoutMinutes,
  reason,
}) {
  const result = {
    deleted: false,
    actionApplied: "delete_only",
    moderationStatus: "ok",
    moderationDetail: null,
  };

  try {
    await message.delete();
    result.deleted = true;
  } catch (error) {
    result.moderationStatus = "warn";
    result.moderationDetail =
      error instanceof Error ? error.message : "falha ao apagar mensagem";
    console.warn(
      `[AntiLink] falha ao apagar mensagem em guild ${message.guildId} canal ${message.channelId}: ${result.moderationDetail}`,
    );
  }

  if (action === "delete_only") {
    return result;
  }

  if (!member) {
    result.moderationStatus = "warn";
    result.moderationDetail = "membro nao encontrado para aplicar punicao";
    return result;
  }

  if (action === "timeout") {
    result.actionApplied = "timeout";
    if (!member.moderatable) {
      result.moderationStatus = "warn";
      result.moderationDetail = "bot sem permissao para silenciar este usuario";
      return result;
    }

    try {
      await member.timeout(timeoutMinutes * 60 * 1000, reason);
      return result;
    } catch (error) {
      result.moderationStatus = "warn";
      result.moderationDetail =
        error instanceof Error ? error.message : "falha ao silenciar usuario";
      console.warn(
        `[AntiLink] falha ao aplicar timeout em guild ${message.guildId}: ${result.moderationDetail}`,
      );
      return result;
    }
  }

  if (action === "kick") {
    result.actionApplied = "kick";
    if (!member.kickable) {
      result.moderationStatus = "warn";
      result.moderationDetail = "bot sem permissao para expulsar este usuario";
      return result;
    }

    try {
      await member.kick(reason);
      return result;
    } catch (error) {
      result.moderationStatus = "warn";
      result.moderationDetail =
        error instanceof Error ? error.message : "falha ao expulsar usuario";
      console.warn(
        `[AntiLink] falha ao expulsar membro em guild ${message.guildId}: ${result.moderationDetail}`,
      );
      return result;
    }
  }

  result.actionApplied = "ban";
  if (!member.bannable) {
    result.moderationStatus = "warn";
    result.moderationDetail = "bot sem permissao para banir este usuario";
    return result;
  }

  try {
    await member.ban({ reason, deleteMessageSeconds: 0 });
    return result;
  } catch (error) {
    result.moderationStatus = "warn";
    result.moderationDetail =
      error instanceof Error ? error.message : "falha ao banir usuario";
    console.warn(
      `[AntiLink] falha ao banir membro em guild ${message.guildId}: ${result.moderationDetail}`,
    );
    return result;
  }
}

async function sendAntiLinkLog({
  message,
  settings,
  action,
  timeoutMinutes,
  detection,
  moderation,
}) {
  if (!settings.log_channel_id) return;

  const logChannel = await resolveTextChannel(message.guild, settings.log_channel_id);
  if (!logChannel) return;

  const moderationSummary =
    moderation.moderationStatus === "ok"
      ? "Executado com sucesso."
      : `Executado com alerta: ${moderation.moderationDetail || "sem detalhes"}.`;

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## Seguranca: AntiLink bloqueou uma mensagem",
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Usuario: <@${message.author.id}>\n-# Canal: <#${message.channelId}>\n-# Regra: ${detection.reason}\n-# Acao configurada: ${resolveActionLabel(action, timeoutMinutes)}\n-# Resultado: ${moderationSummary}`,
          ),
        )
        .addSeparatorComponents(
          new SeparatorBuilder()
            .setSpacing(SeparatorSpacingSize.Large)
            .setDivider(true),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### Trecho da mensagem\n\`\`\`\n${formatSnippet(message.content)}\n\`\`\``,
          ),
        ),
    ],
  };

  const sent = await logChannel.send(payload).catch(() => null);
  if (sent) return;

  const fallbackEmbed = new EmbedBuilder()
    .setColor(0x7a1212)
    .setTitle("Seguranca: AntiLink bloqueou uma mensagem")
    .setDescription(
      [
        `Usuario: <@${message.author.id}>`,
        `Canal: <#${message.channelId}>`,
        `Regra: ${detection.reason}`,
        `Acao configurada: ${resolveActionLabel(action, timeoutMinutes)}`,
        `Resultado: ${moderationSummary}`,
      ].join("\n"),
    )
    .addFields({
      name: "Trecho da mensagem",
      value: `\`\`\`\n${formatSnippet(message.content)}\n\`\`\``,
    })
    .setTimestamp(new Date());

  await logChannel
    .send({
      allowedMentions: { parse: [] },
      embeds: [fallbackEmbed],
    })
    .catch((error) => {
      const detail =
        error instanceof Error ? error.message : "falha ao enviar log";
      console.warn(
        `[AntiLink] falha ao enviar log em guild ${message.guildId} canal ${settings.log_channel_id}: ${detail}`,
      );
      return null;
    });
}

async function sendAntiLinkNotice({ message, detection, action, timeoutMinutes }) {
  if (!message?.channel?.isTextBased?.()) return;

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## Mensagem removida pelo AntiLink",
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Motivo: ${detection.reason}\n-# Acao: ${resolveActionLabel(action, timeoutMinutes)}`,
          ),
        ),
    ],
  };

  let sent = await message.channel.send(payload).catch(() => null);
  if (!sent) {
    const fallbackEmbed = new EmbedBuilder()
      .setColor(0x7a1212)
      .setTitle("Mensagem removida pelo AntiLink")
      .setDescription(
        `Motivo: ${detection.reason}\nAcao: ${resolveActionLabel(action, timeoutMinutes)}`,
      )
      .setTimestamp(new Date());

    sent = await message.channel
      .send({
        allowedMentions: { parse: [] },
        embeds: [fallbackEmbed],
      })
      .catch(() => null);
  }

  if (!sent) return;

  setTimeout(() => {
    sent.delete().catch(() => null);
  }, 8000);
}

async function handleAntiLinkMessage(message) {
  if (!message || !message.inGuild()) return false;
  if (message.author?.bot || message.webhookId) return false;
  if (!message.guildId) return false;

  const runtime = await resolveRuntime(message.guildId);
  if (!runtime?.settings) return false;

  const settings = runtime.settings;
  if (!settings.enabled) return false;

  const member = await resolveMember(message);

  const ignoredRoleIds = Array.isArray(settings.ignored_role_ids)
    ? settings.ignored_role_ids
    : [];
  if (
    member &&
    ignoredRoleIds.length &&
    member.roles?.cache?.some((role) => ignoredRoleIds.includes(role.id))
  ) {
    return false;
  }

  const textForDetection = resolveMessageTextForDetection(message);
  const detection = detectViolation(textForDetection, settings);
  if (!detection) return false;

  const action = normalizeAction(settings.enforcement_action);
  const timeoutMinutes = normalizeTimeoutMinutes(settings.timeout_minutes);
  const reason = `[AntiLink] ${detection.reason}`;
  const moderation = await applyModerationAction({
    message,
    member,
    action,
    timeoutMinutes,
    reason,
  });

  await sendAntiLinkNotice({
    message,
    detection,
    action,
    timeoutMinutes,
  });

  await sendAntiLinkLog({
    message,
    settings,
    action,
    timeoutMinutes,
    detection,
    moderation,
  });

  return true;
}

module.exports = {
  handleAntiLinkMessage,
};
