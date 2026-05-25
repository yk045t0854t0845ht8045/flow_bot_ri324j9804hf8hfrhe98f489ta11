const { Collection, ComponentType } = require("discord.js");
const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function formatTranscriptTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function getAuthorDisplayName(message) {
  return (
    message?.member?.displayName ||
    message?.author?.globalName ||
    message?.author?.username ||
    message?.author?.tag ||
    "Usuario desconhecido"
  );
}

function getAuthorAvatarUrl(message) {
  const url =
    message?.author?.displayAvatarURL?.({ extension: "png", size: 64 }) ||
    message?.author?.avatarURL?.({ extension: "png", size: 64 }) ||
    "";
  return safeHttpUrl(url);
}

function renderMarkdownText(value) {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/(https?:\/\/[^\s<>"']+)/g, (match) => {
      const url = safeHttpUrl(match);
      return url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(match)}</a>`
        : escapeHtml(match);
    })
    .replace(/\n/g, "<br>");
}

function renderAttachment(attachment) {
  const url = safeHttpUrl(attachment?.url || attachment?.proxyURL || attachment?.attachment);
  if (!url) return "";

  const name = escapeHtml(attachment?.name || "Anexo");
  const contentType = normalizeContentType(attachment?.contentType);
  const image =
    SAFE_INLINE_IMAGE_TYPES.has(contentType)
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="${name}" loading="lazy"></a>`
      : "";

  return [
    '<div class="fd-attachment">',
    image,
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${name}</a>`,
    contentType ? `<span>${escapeHtml(contentType)}</span>` : "",
    "</div>",
  ].join("");
}

function getEmbedData(embed) {
  return embed?.data && typeof embed.data === "object" ? embed.data : embed || {};
}

function renderEmbed(embed) {
  const data = getEmbedData(embed);
  const title = String(data.title || "").trim();
  const description = String(data.description || "").trim();
  const fields = Array.isArray(data.fields) ? data.fields : [];

  if (!title && !description && !fields.length) return "";

  return [
    '<div class="fd-embed">',
    title ? `<strong>${escapeHtml(title)}</strong>` : "",
    description ? `<p>${renderMarkdownText(description)}</p>` : "",
    ...fields.slice(0, 25).map((field) => {
      const fieldName = String(field?.name || "").trim();
      const fieldValue = String(field?.value || "").trim();
      if (!fieldName && !fieldValue) return "";
      return `<div class="fd-embed-field"><b>${escapeHtml(fieldName)}</b><span>${renderMarkdownText(fieldValue)}</span></div>`;
    }),
    "</div>",
  ].join("");
}

function renderComponentRow(row) {
  const components = Array.isArray(row?.components) ? row.components : [];
  const buttons = components
    .map((component) => {
      const url = safeHttpUrl(component?.url);
      const label = escapeHtml(component?.label || "Acao");
      return url
        ? `<a class="fd-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : `<span class="fd-button fd-button-disabled">${label}</span>`;
    })
    .filter(Boolean);

  return buttons.length ? `<div class="fd-components">${buttons.join("")}</div>` : "";
}

function buildFallbackTranscriptHtml(channel, messages, renderError) {
  const channelName = channel?.name ? `#${channel.name}` : "ticket";
  const guildName = channel?.guild?.name || "Flowdesk";
  const generatedAt = formatTranscriptTimestamp(new Date());
  const errorMessage = renderError instanceof Error ? renderError.message : String(renderError || "");
  const rows = messages.map((message) => {
    const avatar = getAuthorAvatarUrl(message);
    const content = String(message?.content || "").trim();
    const attachments = Array.from(message?.attachments?.values?.() || []);
    const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
    const components = Array.isArray(message?.components) ? message.components : [];
    const authorName = escapeHtml(getAuthorDisplayName(message));
    const authorId = escapeHtml(message?.author?.id || "");
    const timestamp = escapeHtml(formatTranscriptTimestamp(message?.createdAt));

    return [
      '<article class="fd-message">',
      avatar ? `<img class="fd-avatar" src="${escapeHtml(avatar)}" alt="">` : '<div class="fd-avatar fd-avatar-fallback"></div>',
      '<div class="fd-message-body">',
      `<header><strong>${authorName}</strong>${authorId ? `<span>${authorId}</span>` : ""}<time>${timestamp}</time></header>`,
      content ? `<div class="fd-content">${renderMarkdownText(content)}</div>` : "",
      attachments.length ? `<div class="fd-attachments">${attachments.map(renderAttachment).join("")}</div>` : "",
      embeds.length ? embeds.map(renderEmbed).join("") : "",
      components.length ? components.map(renderComponentRow).join("") : "",
      "</div>",
      "</article>",
    ].join("");
  });

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Transcript ${escapeHtml(channelName)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101114; color: #eef2f7; }
    body { margin: 0; background: #101114; }
    main { max-width: 1080px; margin: 0 auto; padding: 28px 18px 48px; }
    .fd-header { border-bottom: 1px solid rgba(255,255,255,.12); margin-bottom: 20px; padding-bottom: 18px; }
    .fd-header h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.25; }
    .fd-header p { margin: 0; color: #aeb8c7; font-size: 13px; }
    .fd-warning { margin-top: 12px; color: #f7d97c; font-size: 12px; }
    .fd-message { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
    .fd-avatar { width: 42px; height: 42px; border-radius: 50%; background: #2b3442; object-fit: cover; }
    .fd-avatar-fallback { border-radius: 50%; }
    header { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; color: #aeb8c7; font-size: 12px; }
    header strong { color: #f8fafc; font-size: 14px; }
    .fd-content { margin-top: 6px; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
    a { color: #8fd3ff; }
    .fd-attachments { display: grid; gap: 8px; margin-top: 10px; }
    .fd-attachment { border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 10px; background: rgba(255,255,255,.04); }
    .fd-attachment img { display: block; max-width: min(520px, 100%); max-height: 360px; border-radius: 6px; margin-bottom: 8px; }
    .fd-attachment span { display: block; color: #94a3b8; font-size: 12px; margin-top: 4px; }
    .fd-embed { border-left: 4px solid #60a5fa; margin-top: 10px; padding: 10px 12px; background: rgba(96,165,250,.09); border-radius: 0 8px 8px 0; }
    .fd-embed p { margin: 6px 0 0; }
    .fd-embed-field { margin-top: 8px; display: grid; gap: 3px; }
    .fd-components { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .fd-button { border: 1px solid rgba(255,255,255,.16); border-radius: 6px; padding: 6px 10px; color: #f8fafc; text-decoration: none; background: rgba(255,255,255,.08); font-size: 13px; }
    .fd-button-disabled { color: #94a3b8; }
  </style>
</head>
<body>
  <main>
    <section class="fd-header">
      <h1>${escapeHtml(guildName)} - ${escapeHtml(channelName)}</h1>
      <p>Transcript gerado em ${escapeHtml(generatedAt)} com ${messages.length} mensagem(ns).</p>
      ${errorMessage ? `<p class="fd-warning">Renderizador principal indisponivel; fallback seguro usado. Erro: ${escapeHtml(errorMessage).slice(0, 240)}</p>` : ""}
    </section>
    ${rows.join("\n")}
  </main>
</body>
</html>`;
}

async function generateTranscriptHtml(channel) {
  if (!channel || !channel.isTextBased?.()) {
    throw new Error("Canal invalido para geracao de transcript.");
  }

  const messages = await fetchAllMessages(channel);
  const normalizedMessages = messages.map((message) =>
    normalizeMessageForTranscript(message),
  );

  return buildFallbackTranscriptHtml(channel, normalizedMessages, null);
}

module.exports = { generateTranscriptHtml };
