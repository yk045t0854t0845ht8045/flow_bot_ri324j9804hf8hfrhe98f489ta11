const MAX_TRANSCRIPT_MESSAGES = Math.max(
  200,
  Number.parseInt(process.env.TRANSCRIPT_MAX_MESSAGES || "4000", 10) || 4000,
);

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateTime(value) {
  if (!(value instanceof Date)) {
    return "Data indisponivel";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
    hour12: false,
  }).format(value);
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function linkifyEscapedText(escapedText) {
  const urlRegex = /(https?:\/\/[^\s<]+)/gi;
  return escapedText.replace(urlRegex, (url) => {
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>`;
  });
}

function renderMessageContent(content) {
  if (!content) return "";
  const escaped = escapeHtml(content);
  const linked = linkifyEscapedText(escaped);
  return linked.replace(/\n/g, "<br />");
}

function resolveAuthorAvatarUrl(message) {
  if (typeof message?.member?.displayAvatarURL === "function") {
    return message.member.displayAvatarURL({ extension: "png", size: 128 });
  }
  if (typeof message?.author?.displayAvatarURL === "function") {
    return message.author.displayAvatarURL({ extension: "png", size: 128 });
  }
  return "";
}

function isImageAttachment(attachment) {
  const url = String(attachment?.url || "");
  const contentType = String(attachment?.contentType || "").toLowerCase();
  return (
    contentType.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(url)
  );
}

function isVideoAttachment(attachment) {
  const url = String(attachment?.url || "");
  const contentType = String(attachment?.contentType || "").toLowerCase();
  return (
    contentType.startsWith("video/") ||
    /\.(mp4|webm|mov|mkv|avi)(\?.*)?$/i.test(url)
  );
}

function isAudioAttachment(attachment) {
  const url = String(attachment?.url || "");
  const contentType = String(attachment?.contentType || "").toLowerCase();
  return (
    contentType.startsWith("audio/") ||
    /\.(mp3|wav|ogg|m4a|flac)(\?.*)?$/i.test(url)
  );
}

function renderAttachment(attachment) {
  const name = escapeHtml(attachment?.name || "arquivo");
  const url = escapeHtml(attachment?.url || "");
  const sizeLabel = formatFileSize(attachment?.size);
  const subtitle = sizeLabel ? `<span class="fd-attachment-meta">${sizeLabel}</span>` : "";

  if (isImageAttachment(attachment)) {
    return `<figure class="fd-attachment"><img src="${url}" alt="${name}" loading="lazy" /></figure>`;
  }

  if (isVideoAttachment(attachment)) {
    return `<figure class="fd-attachment"><video controls preload="metadata" src="${url}"></video><figcaption>${name} ${subtitle}</figcaption></figure>`;
  }

  if (isAudioAttachment(attachment)) {
    return `<figure class="fd-attachment"><audio controls preload="metadata" src="${url}"></audio><figcaption>${name} ${subtitle}</figcaption></figure>`;
  }

  return `<div class="fd-file"><a href="${url}" target="_blank" rel="noopener noreferrer">${name}</a>${subtitle}</div>`;
}

function renderEmbed(embed) {
  if (!embed) return "";
  const title = escapeHtml(embed.title || "");
  const description = renderMessageContent(embed.description || "");
  const url = escapeHtml(embed.url || "");
  const footer = escapeHtml(embed.footer?.text || "");
  const author = escapeHtml(embed.author?.name || "");
  const fields = Array.isArray(embed.fields)
    ? embed.fields
        .map((field) => {
          const fieldName = escapeHtml(field?.name || "Campo");
          const fieldValue = renderMessageContent(field?.value || "");
          return `<div class="fd-embed-field"><strong>${fieldName}</strong><span>${fieldValue || "-"}</span></div>`;
        })
        .join("")
    : "";
  const thumbnailUrl = escapeHtml(embed.thumbnail?.url || "");
  const imageUrl = escapeHtml(embed.image?.url || "");

  return `
    <div class="fd-embed">
      ${author ? `<div class="fd-embed-author">${author}</div>` : ""}
      ${
        title
          ? `<div class="fd-embed-title">${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</div>`
          : ""
      }
      ${description ? `<div class="fd-embed-description">${description}</div>` : ""}
      ${fields ? `<div class="fd-embed-fields">${fields}</div>` : ""}
      ${
        thumbnailUrl
          ? `<img class="fd-embed-thumb" src="${thumbnailUrl}" alt="thumbnail" loading="lazy" />`
          : ""
      }
      ${
        imageUrl
          ? `<img class="fd-embed-image" src="${imageUrl}" alt="embed image" loading="lazy" />`
          : ""
      }
      ${footer ? `<div class="fd-embed-footer">${footer}</div>` : ""}
    </div>
  `;
}

function renderReactions(message) {
  const reactions = [...(message?.reactions?.cache?.values?.() || [])];
  if (!reactions.length) return "";

  const rendered = reactions
    .map((reaction) => {
      const emoji = reaction.emoji;
      const count = reaction.count || 0;
      let emojiHtml = escapeHtml(emoji?.name || "?");
      if (emoji?.id) {
        const extension = emoji.animated ? "gif" : "png";
        const emojiUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.${extension}?size=48`;
        emojiHtml = `<img src="${emojiUrl}" alt="${escapeHtml(emoji.name || "emoji")}" loading="lazy" />`;
      }
      return `<span class="fd-reaction">${emojiHtml}<b>${count}</b></span>`;
    })
    .join("");

  return `<div class="fd-reactions">${rendered}</div>`;
}

function renderStickers(message) {
  const stickers = [...(message?.stickers?.values?.() || [])];
  if (!stickers.length) return "";

  return `<div class="fd-stickers">${stickers
    .map((sticker) => {
      const name = escapeHtml(sticker?.name || "Sticker");
      const url = escapeHtml(sticker?.url || "");
      if (!url) return `<span class="fd-sticker-label">${name}</span>`;
      return `<a class="fd-sticker" href="${url}" target="_blank" rel="noopener noreferrer"><img src="${url}" alt="${name}" loading="lazy" /><span>${name}</span></a>`;
    })
    .join("")}</div>`;
}

function renderReference(message, messagesById) {
  const referenceId = message?.reference?.messageId;
  if (!referenceId) return "";

  const referenced = messagesById.get(referenceId);
  if (!referenced) {
    return `<blockquote class="fd-reference">Resposta a uma mensagem anterior.</blockquote>`;
  }

  const author = escapeHtml(referenced?.member?.displayName || referenced?.author?.username || "Usuario");
  const content = renderMessageContent(referenced?.cleanContent || referenced?.content || "");
  return `<blockquote class="fd-reference"><strong>${author}</strong>${content ? `<div>${content}</div>` : ""}</blockquote>`;
}

function resolveMessageSenderKey(message) {
  const authorId = String(message?.author?.id || "").trim();
  if (authorId) {
    return `author:${authorId}`;
  }

  const webhookId = String(message?.webhookId || "").trim();
  if (webhookId) {
    return `webhook:${webhookId}`;
  }

  const fallbackName = String(
    message?.author?.username || message?.member?.displayName || "",
  )
    .trim()
    .toLowerCase();
  if (fallbackName) {
    return `name:${fallbackName}`;
  }

  return "";
}

function renderMessage(message, messagesById, options = {}) {
  const { isContinuation = false } = options;
  const authorName = escapeHtml(
    message?.member?.displayName || message?.author?.globalName || message?.author?.username || "Usuario",
  );
  const authorTag = escapeHtml(
    message?.author?.username && message?.author?.discriminator && message.author.discriminator !== "0"
      ? `${message.author.username}#${message.author.discriminator}`
      : message?.author?.username || "",
  );
  const avatarUrl = escapeHtml(resolveAuthorAvatarUrl(message));
  const fallbackInitial = escapeHtml(
    String(
      message?.member?.displayName || message?.author?.globalName || message?.author?.username || "U",
    )
      .trim()
      .charAt(0)
      .toUpperCase() || "U",
  );
  const messageId = escapeHtml(message?.id || "");
  const timestamp = formatDateTime(message?.createdAt || null);
  const editedLabel = message?.editedTimestamp ? " (editado)" : "";

  const contentHtml = renderMessageContent(message?.cleanContent || message?.content || "");
  const attachments = [...(message?.attachments?.values?.() || [])]
    .map((attachment) => renderAttachment(attachment))
    .join("");
  const embeds = [...(message?.embeds || [])].map((embed) => renderEmbed(embed)).join("");
  const reactions = renderReactions(message);
  const stickers = renderStickers(message);
  const referenceHtml = renderReference(message, messagesById);
  const avatarNode = isContinuation
    ? `<span class="fd-avatar-spacer" aria-hidden="true"></span>`
    : avatarUrl
      ? `<img class="fd-avatar" src="${avatarUrl}" alt="${authorName}" loading="lazy" />`
      : `<span class="fd-avatar fd-avatar-fallback" aria-hidden="true">${fallbackInitial}</span>`;

  return `
    <article class="fd-message${isContinuation ? " fd-message-continuation" : ""}" id="message-${messageId}">
      ${avatarNode}
      <div class="fd-bubble">
        ${
          isContinuation
            ? ""
            : `<header class="fd-meta">
          <span class="fd-author">${authorName}</span>
          ${authorTag ? `<span class="fd-tag">${authorTag}</span>` : ""}
          <time datetime="${escapeHtml(message?.createdAt?.toISOString?.() || "")}">${escapeHtml(timestamp)}${editedLabel}</time>
        </header>`
        }
        ${referenceHtml}
        ${contentHtml ? `<div class="fd-content">${contentHtml}</div>` : ""}
        ${attachments}
        ${embeds}
        ${stickers}
        ${reactions}
      </div>
    </article>
  `;
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

function buildTranscriptHtmlDocument({ guildName, channelName, generatedAt, messagesHtml }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Transcript - ${escapeHtml(channelName)}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: #070707;
      color: #dcddde;
      font: 500 14px/1.55 "gg sans", "Inter", "Segoe UI", Roboto, Arial, sans-serif;
    }
    a { color: #c6d3ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .fd-shell {
      width: 100%;
      margin: 0;
      padding: 14px 18px 44px;
    }
    .fd-head {
      position: sticky;
      top: 0;
      z-index: 5;
      margin: 0 0 8px;
      padding: 10px 0 12px;
      background: linear-gradient(180deg, rgba(7,7,7,0.97), rgba(7,7,7,0.84));
      backdrop-filter: blur(6px);
      border-bottom: 1px solid #1a1a1a;
    }
    .fd-head h1 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: #f2f3f5;
      letter-spacing: 0.01em;
    }
    .fd-head p { margin: 4px 0 0; color: #9fa1a6; font-size: 12px; }
    .fd-stream {
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .fd-message {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr);
      gap: 12px;
      align-items: flex-start;
      padding: 4px 12px 10px;
      border: none;
      border-radius: 8px;
      background: transparent;
      transition: background 0.14s ease;
    }
    .fd-message:hover { background: rgba(255,255,255,0.03); }
    .fd-message-continuation { padding-top: 0; }
    .fd-avatar {
      width: 40px;
      height: 40px;
      border-radius: 999px;
      object-fit: cover;
      border: none;
      background: #111111;
    }
    .fd-avatar-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 700;
      color: #d5d7dc;
    }
    .fd-avatar-spacer {
      width: 40px;
      display: block;
    }
    .fd-bubble { min-width: 0; padding-top: 1px; }
    .fd-message-continuation .fd-bubble { padding-top: 0; }
    .fd-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 2px;
    }
    .fd-author { font-size: 15px; font-weight: 600; color: #ffffff; }
    .fd-tag { font-size: 12px; color: #9fa1a6; }
    .fd-meta time { font-size: 12px; color: #949ba4; }
    .fd-content { color: #dbdde1; word-break: break-word; }
    .fd-reference {
      margin: 4px 0 8px;
      padding: 8px 10px;
      border-left: 2px solid #4a4a4a;
      background: rgba(255,255,255,0.04);
      border-radius: 0 8px 8px 0;
      color: #adb0b6;
      font-size: 12px;
    }
    .fd-reference strong { display: block; color: #e4e6ea; margin-bottom: 4px; }
    .fd-attachment {
      margin: 8px 0 0;
      padding: 8px;
      border: 1px solid #1e1e1e;
      background: #0c0c0c;
      border-radius: 12px;
      overflow: hidden;
      width: fit-content;
      max-width: min(100%, 560px);
    }
    .fd-attachment img,
    .fd-attachment video {
      max-width: 100%;
      border-radius: 10px;
      display: block;
    }
    .fd-attachment audio { width: 100%; }
    .fd-attachment figcaption {
      margin-top: 8px;
      font-size: 12px;
      color: #a5a8ad;
    }
    .fd-attachment-meta {
      margin-left: 8px;
      color: #8f9297;
    }
    .fd-file {
      margin-top: 8px;
      padding: 8px 10px;
      border: 1px solid #242424;
      border-radius: 10px;
      background: #0c0c0c;
      font-size: 13px;
      width: fit-content;
      max-width: 100%;
    }
    .fd-file a { font-weight: 700; }
    .fd-embed {
      margin-top: 8px;
      border: 1px solid #2a2a2a;
      border-left: 4px solid #4b4b4b;
      border-radius: 10px;
      padding: 10px 12px;
      background: #0f0f0f;
      max-width: min(100%, 620px);
    }
    .fd-embed-author { color: #adb0b6; font-size: 12px; margin-bottom: 4px; }
    .fd-embed-title { font-weight: 700; color: #eceef2; margin-bottom: 6px; }
    .fd-embed-description { color: #cfd1d5; font-size: 13px; }
    .fd-embed-fields {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
      margin-top: 8px;
    }
    .fd-embed-field {
      padding: 8px;
      border: 1px solid #2b2b2b;
      border-radius: 8px;
      background: #0b0b0b;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .fd-embed-field strong { font-size: 12px; color: #e0e1e4; }
    .fd-embed-field span { font-size: 12px; color: #b2b4b9; word-break: break-word; }
    .fd-embed-thumb {
      width: 90px;
      height: 90px;
      object-fit: cover;
      border-radius: 8px;
      margin-top: 8px;
      border: 1px solid #323232;
    }
    .fd-embed-image {
      max-width: 100%;
      margin-top: 8px;
      border-radius: 8px;
      border: 1px solid #323232;
    }
    .fd-embed-footer { margin-top: 8px; font-size: 11px; color: #9b9da3; }
    .fd-reactions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .fd-reaction {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #2a2a2a;
      background: #121212;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 12px;
      color: #d3d4d6;
    }
    .fd-reaction img {
      width: 16px;
      height: 16px;
      object-fit: contain;
    }
    .fd-stickers {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .fd-sticker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border: 1px solid #252525;
      border-radius: 10px;
      padding: 6px 8px;
      background: #101010;
      color: #d0d2d6;
      font-size: 12px;
    }
    .fd-sticker img {
      width: 42px;
      height: 42px;
      object-fit: contain;
      border-radius: 8px;
      background: #080808;
    }
    .fd-empty {
      border: 1px dashed #2d2d2d;
      border-radius: 14px;
      padding: 16px;
      text-align: center;
      color: #9a9a9a;
      background: #0e0e0e;
    }
    @media (max-width: 640px) {
      .fd-shell { padding: 12px 10px 28px; }
      .fd-head h1 { font-size: 12px; }
      .fd-message {
        grid-template-columns: 36px minmax(0, 1fr);
        gap: 10px;
        padding: 4px 6px 10px;
      }
      .fd-avatar { width: 36px; height: 36px; }
      .fd-avatar-spacer { width: 36px; }
    }
  </style>
</head>
<body>
  <main class="fd-shell">
    <header class="fd-head">
      <h1>Transcript de #${escapeHtml(channelName)} - ${escapeHtml(guildName)}</h1>
      <p>Gerado em ${escapeHtml(generatedAt)} | Mensagens: ${messagesHtml.count}</p>
    </header>
    <section class="fd-stream">
      ${messagesHtml.body || '<div class="fd-empty">Nenhuma mensagem encontrada para gerar transcript.</div>'}
    </section>
  </main>
</body>
</html>`;
}

async function generateTranscriptHtml(channel) {
  if (!channel || !channel.isTextBased?.()) {
    throw new Error("Canal invalido para geracao de transcript.");
  }

  const guildName = channel?.guild?.name || "Servidor";
  const channelName = channel?.name || "ticket";
  const messages = await fetchAllMessages(channel);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  let previousSenderKey = "";
  const renderedMessages = messages.map((message) => {
    const senderKey = resolveMessageSenderKey(message);
    const isContinuation = Boolean(senderKey) && senderKey === previousSenderKey;
    previousSenderKey = senderKey;
    return renderMessage(message, messagesById, { isContinuation });
  });

  return buildTranscriptHtmlDocument({
    guildName,
    channelName,
    generatedAt: formatDateTime(new Date()),
    messagesHtml: {
      count: messages.length,
      body: renderedMessages.join(""),
    },
  });
}

module.exports = { generateTranscriptHtml };
