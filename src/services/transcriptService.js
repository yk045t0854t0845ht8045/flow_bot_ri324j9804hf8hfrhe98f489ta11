const { Collection, ComponentType } = require("discord.js");
const discordHtmlTranscripts = require("discord-html-transcripts");

const { ExportReturnType } = discordHtmlTranscripts;

const MAX_TRANSCRIPT_MESSAGES = Math.max(
  200,
  Number.parseInt(process.env.TRANSCRIPT_MAX_MESSAGES || "4000", 10) || 4000,
);

const CONTENT_TYPE_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  pdf: "application/pdf",
};

function normalizeContentType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "";
}

function inferAttachmentContentType(attachment) {
  const explicitType = normalizeContentType(attachment?.contentType);
  if (explicitType) {
    return explicitType;
  }

  const candidates = [
    attachment?.name,
    attachment?.url,
    attachment?.proxyURL,
    attachment?.attachment,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const sanitized = candidate.split("?")[0].split("#")[0];
    const match = sanitized.match(/\.([a-z0-9]+)$/i);
    const extension = match?.[1]?.toLowerCase() || "";
    if (extension && CONTENT_TYPE_BY_EXTENSION[extension]) {
      return CONTENT_TYPE_BY_EXTENSION[extension];
    }
  }

  return "";
}

function pushUniqueText(target, value) {
  const normalized = String(value || "").trim();
  if (!normalized) return;
  if (!target.includes(normalized)) {
    target.push(normalized);
  }
}

function getComponentType(component) {
  return Number(component?.type ?? component?.data?.type ?? 0);
}

function getComponentChildren(component) {
  if (Array.isArray(component?.components)) {
    return component.components;
  }

  if (Array.isArray(component?.data?.components)) {
    return component.data.components;
  }

  return [];
}

function getComponentAccessory(component) {
  return component?.accessory ?? component?.data?.accessory ?? null;
}

function getTextDisplayContent(component) {
  return String(component?.content ?? component?.data?.content ?? "").trim();
}

function createTranscriptButton(component) {
  if (getComponentType(component) !== ComponentType.Button) {
    return null;
  }

  const label = String(component?.label ?? component?.data?.label ?? "").trim();
  const url = String(component?.url ?? component?.data?.url ?? "").trim();

  return {
    type: ComponentType.Button,
    style: component?.style ?? component?.data?.style ?? (url ? 5 : 2),
    label: label || (url ? "Abrir" : "Acao"),
    url: url || undefined,
    emoji: component?.emoji ?? component?.data?.emoji ?? undefined,
  };
}

function createActionRowSignature(row) {
  const components = Array.isArray(row?.components) ? row.components : [];
  return JSON.stringify(
    components.map((component) => ({
      type: component?.type ?? null,
      style: component?.style ?? null,
      label: component?.label ?? "",
      url: component?.url ?? "",
      emojiId: component?.emoji?.id ?? null,
      emojiName: component?.emoji?.name ?? null,
    })),
  );
}

function collectTranscriptComponentData(components, state = null) {
  const draft = state || { textBlocks: [], actionRows: [], actionRowKeys: new Set() };

  for (const component of Array.isArray(components) ? components : []) {
    if (!component) continue;

    const type = getComponentType(component);

    if (type === ComponentType.TextDisplay) {
      pushUniqueText(draft.textBlocks, getTextDisplayContent(component));
      continue;
    }

    if (type === ComponentType.ActionRow) {
      const buttons = getComponentChildren(component)
        .map((child) => createTranscriptButton(child))
        .filter(Boolean);

      if (buttons.length) {
        const row = {
          type: ComponentType.ActionRow,
          components: buttons,
        };
        const signature = createActionRowSignature(row);
        if (!draft.actionRowKeys.has(signature)) {
          draft.actionRows.push(row);
          draft.actionRowKeys.add(signature);
        }
      }
      continue;
    }

    if (type === ComponentType.Button) {
      const button = createTranscriptButton(component);
      if (button) {
        const row = {
          type: ComponentType.ActionRow,
          components: [button],
        };
        const signature = createActionRowSignature(row);
        if (!draft.actionRowKeys.has(signature)) {
          draft.actionRows.push(row);
          draft.actionRowKeys.add(signature);
        }
      }
      continue;
    }

    const nestedChildren = getComponentChildren(component);
    if (nestedChildren.length) {
      collectTranscriptComponentData(nestedChildren, draft);
    }

    const accessory = getComponentAccessory(component);
    if (accessory) {
      collectTranscriptComponentData([accessory], draft);
    }
  }

  return draft;
}

function normalizeMessageAttachments(message) {
  const attachments = new Collection();

  for (const attachment of message?.attachments?.values?.() || []) {
    attachments.set(attachment.id, {
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      proxyURL: attachment.proxyURL || attachment.url,
      attachment: attachment.attachment || attachment.url,
      size: attachment.size,
      width: attachment.width ?? undefined,
      height: attachment.height ?? undefined,
      contentType: inferAttachmentContentType(attachment) || undefined,
    });
  }

  return attachments;
}

function normalizeMessageForTranscript(message) {
  const extracted = collectTranscriptComponentData(message?.components);
  const contentBlocks = [];

  pushUniqueText(contentBlocks, message?.content);
  for (const block of extracted.textBlocks) {
    pushUniqueText(contentBlocks, block);
  }

  return {
    id: message.id,
    system: message.system,
    type: message.type,
    reference: message.reference ?? null,
    guild: message.guild ?? null,
    member: message.member ?? null,
    author: message.author,
    channel: message.channel,
    createdAt: message.createdAt,
    editedAt: message.editedAt ?? null,
    content: contentBlocks.join("\n\n").trim(),
    attachments: normalizeMessageAttachments(message),
    embeds: Array.isArray(message.embeds) ? message.embeds : [],
    components: extracted.actionRows,
    reactions: message.reactions,
    hasThread: Boolean(message.hasThread),
    thread: message.thread ?? null,
    interaction: message.interaction ?? null,
    webhookId: message.webhookId ?? null,
    mentions: message.mentions ?? { everyone: false },
  };
}

async function fetchAllMessages(channel) {
  const allMessages = [];
  let before = null;

  while (allMessages.length < MAX_TRANSCRIPT_MESSAGES) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const batch = await channel.messages.fetch(options);
    if (!batch.size) break;

    allMessages.push(...batch.values());
    if (batch.size < 100) break;

    before = batch.last().id;
  }

  return allMessages
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .slice(0, MAX_TRANSCRIPT_MESSAGES);
}

function buildTranscriptCallbacks(channel) {
  const resolvedChannels = new Map();
  const resolvedUsers = new Map();
  const resolvedRoles = new Map();

  return {
    resolveChannel: async (channelId) => {
      if (resolvedChannels.has(channelId)) {
        return resolvedChannels.get(channelId);
      }

      const resolved =
        channel?.guild?.channels?.cache?.get?.(channelId) ||
        channel?.client?.channels?.cache?.get?.(channelId) ||
        (await channel?.client?.channels?.fetch?.(channelId).catch(() => null)) ||
        null;

      resolvedChannels.set(channelId, resolved);
      return resolved;
    },
    resolveUser: async (userId) => {
      if (resolvedUsers.has(userId)) {
        return resolvedUsers.get(userId);
      }

      const resolved =
        channel?.client?.users?.cache?.get?.(userId) ||
        (await channel?.client?.users?.fetch?.(userId).catch(() => null)) ||
        null;

      resolvedUsers.set(userId, resolved);
      return resolved;
    },
    resolveRole: async (roleId) => {
      if (resolvedRoles.has(roleId)) {
        return resolvedRoles.get(roleId);
      }

      const resolved =
        channel?.guild?.roles?.cache?.get?.(roleId) ||
        (await channel?.guild?.roles?.fetch?.(roleId).catch(() => null)) ||
        null;

      resolvedRoles.set(roleId, resolved);
      return resolved;
    },
  };
}

async function generateTranscriptHtml(channel) {
  if (!channel || !channel.isTextBased?.()) {
    throw new Error("Canal invalido para geracao de transcript.");
  }

  const messages = await fetchAllMessages(channel);
  const normalizedMessages = messages.map((message) =>
    normalizeMessageForTranscript(message),
  );

  return discordHtmlTranscripts.generateFromMessages(normalizedMessages, channel, {
    returnType: ExportReturnType.String,
    saveImages: true,
    poweredBy: false,
    hydrate: true,
    favicon: "guild",
    footerText: "Exportado {number} mensagem{s}.",
    callbacks: buildTranscriptCallbacks(channel),
  });
}

module.exports = { generateTranscriptHtml };
