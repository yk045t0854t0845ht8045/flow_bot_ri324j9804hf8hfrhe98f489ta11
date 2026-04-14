const { MessageFlags, SeparatorSpacingSize } = require("discord.js");
const { env } = require("../config/env");
const { getGuildTicketRuntime } = require("./supabaseService");

const MAX_INPUT_CHARS = 1600;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_CHARS = 900;
const MAX_OUTPUT_TOKENS = 450;
const MAX_DISCORD_MESSAGE_CHARS = 1800;
const MAX_LOG_TEXT_CHARS = 3500;
const CONTEXT_TTL_MS = 1000 * 60 * 20;
const ACTIVE_CONVERSATION_TTL_MS = 1000 * 60 * 3;
const GUILD_CONTEXT_TTL_MS = 1000 * 60 * 2;
const RESPONSE_CACHE_TTL_MS = 1000 * 60 * 10;
const DUPLICATE_PROMPT_TTL_MS = 1000 * 20;
const COOLDOWN_MS = 1000;
const ABUSE_SHORT_WINDOW_MS = 1000 * 12;
const ABUSE_LONG_WINDOW_MS = 1000 * 60;
const ABUSE_SHORT_LIMIT = 5;
const ABUSE_LONG_LIMIT = 12;
const ABUSE_BLOCK_MS = 1000 * 75;
const PROCESSING_NOTICE_TTL_MS = 1000 * 12;
const PROACTIVE_REPLY_DELAY_MS = 1000 * 75;
const PROACTIVE_REPLY_COOLDOWN_MS = 1000 * 60 * 12;

const COMPONENT_TYPE = {
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
};

const conversationStore = new Map();
const activeConversationStore = new Map();
const inFlightConversationKeys = new Set();
const lastReplyByUser = new Map();
const unavailableModelCache = new Map();
const abuseStore = new Map();
const duplicatePromptStore = new Map();
const processingNoticeStore = new Map();
const responseCache = new Map();
const guildContextCache = new Map();
const proactiveConversationStore = new Map();
const proactiveReplyCooldownStore = new Map();

const SYSTEM_CORE_BEHAVIOR = [
  "Atenda em PT-BR.",
  "Responda duvidas, oriente passos, resolva problemas e mantenha a conversa fluindo.",
  "Use Markdown do Discord apenas quando ajudar na leitura: **destaque**, > citacoes, listas e `rotulos` curtos.",
  "Prefira respostas bem organizadas e objetivas.",
  "Evite soar como robo, texto corporativo seco ou resposta engessada.",
  "Se faltar contexto, faca uma pergunta curta antes de presumir.",
  "Nao invente informacoes, links, permissoes, erros ou recursos inexistentes.",
  "Nunca gere scripts, codigos, comandos longos ou blocos de codigo.",
  "Se o usuario pedir codigo, script ou automacao, recuse com educacao e ofereca explicacao em linguagem natural.",
  "Nao use @everyone, @here, IDs ou mencoes desnecessarias.",
  "Salvo quando o usuario pedir profundidade, mantenha a resposta curta o suficiente para caber bem no Discord.",
].join(" ");

function buildDynamicSystemPrompt(guildContext) {
  const settings = guildContext?.ticketRuntime?.settings;
  const name = settings?.ai_company_name || "Assistente Oficial";
  const bio = settings?.ai_company_bio || "Assistente oficial do servidor do Discord.";
  const rules = settings?.ai_rules || "";
  const tone = settings?.ai_tone || "professional";

  const toneInstruction = tone === "friendly"
    ? "Atenda com tom humano, leve, carismatico e amigavel, como um bot de comunidade proximo. Fora de assuntos sensiveis, tenha energia de bot de comunidade: simpatico, natural e agradavel."
    : "Atenda com tom profissional, sobrio, polido e seguro. Mantenha a formalidade e seguranca em todas as interacoes.";

  const identity = [
    `Voce e o ${name}, ${bio}.`,
    toneInstruction,
  ];

  if (rules) {
    identity.push(`\nRegras e diretrizes especificas da empresa para seguir:\n${rules}`);
  }

  return [
    identity.join("\n"),
    "\nInstrucoes de comportamento funcional:",
    SYSTEM_CORE_BEHAVIOR
  ].join("\n");
}

const SCRIPT_REQUEST_TOKENS = new Set([
  "script",
  "codigo",
  "code",
  "javascript",
  "typescript",
  "python",
  "node",
  "sql",
  "bash",
  "powershell",
  "shell",
  "cmd",
]);

const SCRIPT_REQUEST_PHRASES = [
  "me manda o codigo",
  "gera um codigo",
  "gera um script",
  "faz um script",
  "escreve um codigo",
];

const CLOSING_MESSAGE_HINTS = [
  "obrigado",
  "obrigada",
  "valeu",
  "fechou",
  "era isso",
  "resolvido",
  "resolveu",
  "tchau",
  "ate mais",
  "ate logo",
  "falou",
];

const SERIOUS_COMMUNITY_HINTS = [
  "pagamento",
  "reembolso",
  "estorno",
  "cobranca",
  "licenca",
  "plano",
  "cancelamento",
  "parceria",
  "parceiro",
  "ban",
  "denuncia",
  "abuso",
  "suporte urgente",
  "moderacao",
  "staff",
];

const PROACTIVE_HELP_HINTS = [
  "?",
  "me ajuda",
  "me ajudem",
  "alguem sabe",
  "alguem consegue",
  "tem como",
  "como faz",
  "como eu",
  "onde fica",
  "nao consigo",
  "não consigo",
  "deu erro",
  "deu bug",
  "bugou",
  "to com erro",
  "tô com erro",
  "preciso de ajuda",
  "quero comprar",
  "tenho interesse",
  "quero reembolso",
  "quero parceria",
  "quero ser parceiro",
];

const PROACTIVE_ANNOUNCEMENT_HINTS = [
  "anuncio",
  "anúncio",
  "comunicado",
  "divulgacao",
  "divulgação",
  "promo",
  "promocao",
  "promoção",
  "vendendo",
  "vendo",
  "lancamento",
  "lançamento",
  "novidade",
  "disponivel agora",
];

const CHANNEL_HELP_HINTS = [
  "ajuda",
  "help",
  "suporte",
  "support",
  "duvida",
  "duvidas",
  "dúvida",
  "dúvidas",
  "faq",
];

const CHANNEL_COMMUNITY_HINTS = [
  "geral",
  "chat",
  "papo",
  "comunidade",
  "community",
  "lobby",
];

const CHANNEL_FINANCE_HINTS = [
  "finance",
  "pagamento",
  "payment",
  "reembolso",
  "refund",
  "compras",
  "compra",
  "parceria",
  "comercial",
];

const CHANNEL_QUIET_HINTS = [
  "anuncio",
  "anúncio",
  "avisos",
  "notice",
  "logs",
  "log",
  "registro",
  "transcript",
  "painel",
  "bot",
  "comandos",
  "commands",
];

const QUICK_RESPONSES = new Map([
  ["oi", "Oi. Manda sua duvida que eu vejo com voce por aqui."],
  ["ola", "Ola. Manda sua duvida que eu te ajudo por aqui."],
  ["opa", "Opa, manda ai o que pegou que eu tento te ajudar."],
  ["bom dia", "Bom dia. Pode mandar sua duvida que eu te ajudo por aqui."],
  ["boa tarde", "Boa tarde. Pode mandar sua duvida que eu te ajudo por aqui."],
  ["boa noite", "Boa noite. Pode mandar sua duvida que eu te ajudo por aqui."],
  ["obrigado", "Boa. Se pintar outra duvida, so me chamar."],
  ["obrigada", "Boa. Se pintar outra duvida, so me chamar."],
  ["valeu", "Boa. Se pintar outra duvida, so me chamar."],
]);

const STOP_WORDS = new Set([
  "como",
  "onde",
  "qual",
  "quais",
  "com",
  "para",
  "esse",
  "essa",
  "isso",
  "nao",
  "sim",
  "por",
  "uma",
  "uns",
  "umas",
  "que",
  "dos",
  "das",
  "nos",
  "nas",
  "meu",
  "minha",
  "seu",
  "sua",
  "ticket",
  "tickets",
  "canal",
  "canalzinho",
]);

function nowMs() {
  return Date.now();
}

function normalizeInlineText(value, maxChars) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function normalizeMultilineText(value, maxChars) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxChars);
}

function normalizeIntentText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeForLog(value, maxChars = MAX_LOG_TEXT_CHARS) {
  return normalizeMultilineText(value, maxChars).replace(/```/g, "'''");
}

function includesAny(text, hints) {
  return hints.some((hint) => text.includes(hint));
}

function buildCommunityToneGuidance(userText) {
  const normalized = normalizeIntentText(userText);
  return buildCommunityToneGuidanceForContext(normalized, null);
}

function getChannelDescriptor(message) {
  return normalizeIntentText([
    message?.channel?.name || "",
    message?.channel?.parent?.name || "",
  ].filter(Boolean).join(" "));
}

function classifyCommunityChannel(message) {
  const descriptor = getChannelDescriptor(message);

  if (!descriptor) {
    return {
      profile: "neutral",
      proactiveEnabled: true,
      proactiveDelayMs: PROACTIVE_REPLY_DELAY_MS + 15000,
    };
  }

  if (
    includesAny(descriptor, CHANNEL_QUIET_HINTS) ||
    includesAny(descriptor, PROACTIVE_ANNOUNCEMENT_HINTS)
  ) {
    return {
      profile: "quiet",
      proactiveEnabled: false,
      proactiveDelayMs: null,
    };
  }

  if (includesAny(descriptor, CHANNEL_FINANCE_HINTS)) {
    return {
      profile: "finance",
      proactiveEnabled: true,
      proactiveDelayMs: PROACTIVE_REPLY_DELAY_MS + 15000,
    };
  }

  if (includesAny(descriptor, CHANNEL_HELP_HINTS)) {
    return {
      profile: "support",
      proactiveEnabled: true,
      proactiveDelayMs: Math.max(30000, PROACTIVE_REPLY_DELAY_MS - 30000),
    };
  }

  if (includesAny(descriptor, CHANNEL_COMMUNITY_HINTS)) {
    return {
      profile: "community",
      proactiveEnabled: true,
      proactiveDelayMs: PROACTIVE_REPLY_DELAY_MS,
    };
  }

  return {
    profile: "neutral",
    proactiveEnabled: true,
    proactiveDelayMs: PROACTIVE_REPLY_DELAY_MS + 30000,
  };
}

function buildCommunityToneGuidanceForContext(normalizedUserText, channelProfile) {
  const normalized = typeof normalizedUserText === "string"
    ? normalizedUserText
    : normalizeIntentText(normalizedUserText);

  if (includesAny(normalized, SERIOUS_COMMUNITY_HINTS)) {
    return [
      "Assunto potencialmente sensivel detectado.",
      "Responda com tom mais sobrio, profissional e seguro.",
      "Evite excesso de entusiasmo, brincadeiras ou leveza demais.",
    ].join(" ");
  }

  switch (channelProfile?.profile) {
    case "support":
      return [
        "Canal de ajuda detectado.",
        "Seja caloroso e humano, mas bem direto ao ponto.",
        "Priorize orientacao pratica, passos claros e perguntas curtas so quando necessario.",
      ].join(" ");
    case "finance":
      return [
        "Canal comercial ou financeiro detectado.",
        "Use tom educado, profissional e seguro.",
        "Pode ter carisma, mas sem brincadeiras ou empolgacao excessiva.",
      ].join(" ");
    case "community":
      return [
        "Canal de comunidade detectado.",
        "Pode responder com mais carisma, leveza e energia amistosa.",
        "Soe como um bot de comunidade querido e util, sem exagerar nem virar meme.",
      ].join(" ");
    default:
      return [
        "Assunto geral de comunidade detectado.",
        "Mantenha tom humano, agradavel e util.",
        "Evite parecer robo ou texto corporativo seco.",
      ].join(" ");
  }
}

function buildProactiveChannelKey(message) {
  return `${message.guildId}:${message.channelId}`;
}

function cleanupExpiredProactiveCooldowns() {
  const cutoff = nowMs() - PROACTIVE_REPLY_COOLDOWN_MS;
  for (const [key, timestamp] of proactiveReplyCooldownStore.entries()) {
    if (timestamp < cutoff) {
      proactiveReplyCooldownStore.delete(key);
    }
  }
}

function hasRecentProactiveReply(userId) {
  cleanupExpiredProactiveCooldowns();
  const lastAt = proactiveReplyCooldownStore.get(userId) || 0;
  return nowMs() - lastAt < PROACTIVE_REPLY_COOLDOWN_MS;
}

function markRecentProactiveReply(userId) {
  proactiveReplyCooldownStore.set(userId, nowMs());
}

function looksLikeAnnouncementMessage(message, prompt) {
  const normalized = normalizeIntentText(prompt);
  const linkCount = (String(prompt || "").match(/https?:\/\//gi) || []).length;
  const hasMassMention =
    String(message.content || "").includes("@everyone") ||
    String(message.content || "").includes("@here");

  if (hasMassMention || linkCount >= 2) {
    return true;
  }

  if (includesAny(normalized, PROACTIVE_ANNOUNCEMENT_HINTS)) {
    return true;
  }

  const lineCount = String(prompt || "").split("\n").filter(Boolean).length;
  return lineCount >= 4 && linkCount >= 1;
}

function looksLikeHelpSeekingMessage(prompt) {
  const normalized = normalizeIntentText(prompt);
  if (!normalized || normalized.length < 8) {
    return false;
  }

  if (includesAny(normalized, PROACTIVE_HELP_HINTS)) {
    return true;
  }

  return (
    normalized.startsWith("como ") ||
    normalized.startsWith("onde ") ||
    normalized.startsWith("qual ") ||
    normalized.startsWith("por que ") ||
    normalized.startsWith("porque ") ||
    normalized.startsWith("alguem ") ||
    normalized.startsWith("tenho ") ||
    normalized.startsWith("quero ")
  );
}

function shouldObserveProactively(message, prompt) {
  const channelProfile = classifyCommunityChannel(message);
  const normalized = normalizeIntentText(prompt);

  if (!isOfficialGuildMessage(message)) return false;
  if (message.author?.bot || message.webhookId) return false;
  if (!prompt) return false;
  if (!channelProfile.proactiveEnabled) return false;
  if (hasRecentProactiveReply(message.author?.id || "unknown-user")) return false;
  if (looksLikeAnnouncementMessage(message, prompt)) return false;
  if (!looksLikeHelpSeekingMessage(prompt)) return false;
  if (getActiveConversation(message.channelId)) return false;

  if (
    channelProfile.profile === "finance" &&
    !includesAny(normalized, SERIOUS_COMMUNITY_HINTS) &&
    !String(prompt).includes("?")
  ) {
    return false;
  }

  return true;
}

function isScriptRequest(prompt) {
  const normalized = normalizeIntentText(prompt);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.some((token) => SCRIPT_REQUEST_TOKENS.has(token))) {
    return true;
  }

  return SCRIPT_REQUEST_PHRASES.some((phrase) => normalized.includes(phrase));
}

function pruneTimestamps(timestamps, cutoffMs) {
  return timestamps.filter((timestamp) => timestamp >= cutoffMs);
}

function isOfficialGuildMessage(message) {
  return Boolean(
    message?.guildId &&
      env.officialSupportGuildId &&
      message.guildId === env.officialSupportGuildId,
  );
}

function stripBotMention(content, botId) {
  if (!content || !botId) return "";
  const mentionPattern = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(mentionPattern, "").trim();
}

function cleanupExpiredState() {
  const contextCutoff = nowMs() - CONTEXT_TTL_MS;
  for (const [key, entry] of conversationStore.entries()) {
    if (!entry || entry.updatedAt < contextCutoff) {
      conversationStore.delete(key);
    }
  }

  for (const [key, lastReplyAt] of lastReplyByUser.entries()) {
    if (lastReplyAt < contextCutoff) {
      lastReplyByUser.delete(key);
    }
  }

  const activeCutoff = nowMs() - ACTIVE_CONVERSATION_TTL_MS;
  for (const [channelId, entry] of activeConversationStore.entries()) {
    if (!entry || entry.updatedAt < activeCutoff) {
      activeConversationStore.delete(channelId);
    }
  }

  for (const [key, entry] of abuseStore.entries()) {
    if (!entry || entry.updatedAt < contextCutoff) {
      abuseStore.delete(key);
    }
  }

  const duplicateCutoff = nowMs() - DUPLICATE_PROMPT_TTL_MS;
  for (const [key, entry] of duplicatePromptStore.entries()) {
    if (!entry || entry.updatedAt < duplicateCutoff) {
      duplicatePromptStore.delete(key);
    }
  }

  const responseCutoff = nowMs() - RESPONSE_CACHE_TTL_MS;
  for (const [key, entry] of responseCache.entries()) {
    if (!entry || entry.updatedAt < responseCutoff) {
      responseCache.delete(key);
    }
  }

  const guildCutoff = nowMs() - GUILD_CONTEXT_TTL_MS;
  for (const [key, entry] of guildContextCache.entries()) {
    if (!entry || entry.updatedAt < guildCutoff) {
      guildContextCache.delete(key);
    }
  }

  const processingCutoff = nowMs() - PROCESSING_NOTICE_TTL_MS;
  for (const [key, timestamp] of processingNoticeStore.entries()) {
    if (timestamp < processingCutoff) {
      processingNoticeStore.delete(key);
    }
  }
}

function getConversationKey(message) {
  return [
    message.guildId || "dm",
    message.channelId || "unknown-channel",
    message.author?.id || "unknown-user",
  ].join(":");
}

function getConversationHistory(conversationKey) {
  cleanupExpiredState();
  const entry = conversationStore.get(conversationKey);
  return Array.isArray(entry?.messages) ? entry.messages : [];
}

function saveConversationHistory(conversationKey, messages) {
  conversationStore.set(conversationKey, {
    updatedAt: nowMs(),
    messages: messages.slice(-MAX_HISTORY_MESSAGES),
  });
}

function appendConversationTurn(conversationKey, role, content) {
  const cleanContent = normalizeMultilineText(content, MAX_HISTORY_MESSAGE_CHARS);
  if (!cleanContent) return;

  const nextHistory = [
    ...getConversationHistory(conversationKey),
    { role, content: cleanContent },
  ].slice(-MAX_HISTORY_MESSAGES);

  saveConversationHistory(conversationKey, nextHistory);
}

function getActiveConversation(channelId) {
  cleanupExpiredState();
  return activeConversationStore.get(channelId || "unknown-channel") || null;
}

function setActiveConversation(channelId, userId) {
  activeConversationStore.set(channelId || "unknown-channel", {
    userId,
    updatedAt: nowMs(),
  });
}

function clearActiveConversation(channelId) {
  activeConversationStore.delete(channelId || "unknown-channel");
}

function canReplyToUser(userId) {
  const lastAt = lastReplyByUser.get(userId) || 0;
  return nowMs() - lastAt >= COOLDOWN_MS;
}

function markUserReplied(userId) {
  lastReplyByUser.set(userId, nowMs());
}

function buildModelCandidates() {
  const allCandidates = [...new Set([
    env.openaiModel,
    ...env.openaiModelFallbacks,
    "gpt-4o-mini",
  ].filter(Boolean))];
  const currentTime = nowMs();

  const availableCandidates = allCandidates.filter((model) => {
    const blockedUntil = unavailableModelCache.get(model) || 0;
    return blockedUntil <= currentTime;
  });

  return availableCandidates.length ? availableCandidates : allCandidates;
}

function parseErrorPayload(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function isModelAccessError(status, rawText) {
  const payload = parseErrorPayload(rawText);
  const message = String(payload?.error?.message || rawText || "").toLowerCase();
  const code = String(payload?.error?.code || "").toLowerCase();

  return (
    status === 403 ||
    code === "model_not_found" ||
    message.includes("does not have access to model") ||
    message.includes("model_not_found")
  );
}

function buildFallbackReply(userText) {
  const normalized = normalizeInlineText(userText, 400).toLowerCase();

  if (normalized.includes("ticket")) {
    return [
      "Posso te ajudar com isso.",
      "",
      "> **Ticket**",
      "Verifique se o painel esta publicado, se o cargo e a categoria configurados existem e se o bot tem permissao de `ViewChannel`, `SendMessages` e `ManageChannels`.",
      "",
      "Se quiser, me diga exatamente qual etapa do ticket falhou que eu continuo te guiando.",
    ].join("\n");
  }

  if (normalized.includes("erro") || normalized.includes("bug")) {
    return [
      "Posso te ajudar a diagnosticar.",
      "",
      "Me manda em uma mensagem so:",
      "1. onde aconteceu o erro",
      "2. o que voce tentou fazer",
      "3. qual mensagem apareceu",
    ].join("\n");
  }

  return [
    "Posso te ajudar por aqui, mas a IA ficou temporariamente indisponivel.",
    "",
    "Me explique em uma frase curta o problema e, se tiver, envie o erro entre `txt` para eu te orientar melhor.",
  ].join("\n");
}

function splitDiscordMessage(content) {
  const clean = normalizeMultilineText(content, 6000);
  if (!clean) return [];
  if (clean.length <= MAX_DISCORD_MESSAGE_CHARS) return [clean];

  const chunks = [];
  let remaining = clean;

  while (remaining.length > MAX_DISCORD_MESSAGE_CHARS) {
    let splitAt = remaining.lastIndexOf("\n\n", MAX_DISCORD_MESSAGE_CHARS);
    if (splitAt < 500) {
      splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_MESSAGE_CHARS);
    }
    if (splitAt < 500) {
      splitAt = remaining.lastIndexOf(" ", MAX_DISCORD_MESSAGE_CHARS);
    }
    if (splitAt < 500) {
      splitAt = MAX_DISCORD_MESSAGE_CHARS;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

async function isReplyToBot(message, client) {
  if (!message?.reference?.messageId) return false;

  const repliedUserId = message.mentions?.repliedUser?.id;
  if (repliedUserId && repliedUserId === client.user.id) {
    return true;
  }

  const reference = await message.fetchReference().catch(() => null);
  return Boolean(reference?.author?.id && reference.author.id === client.user.id);
}

async function resolveHandlingMode(message, client) {
  if (!message || !client?.user) return null;
  if (!isOfficialGuildMessage(message)) return null;
  if (message.author?.bot || message.webhookId) return null;

  const activeConversation = getActiveConversation(message.channelId);
  if (activeConversation && activeConversation.userId !== message.author.id) {
    clearActiveConversation(message.channelId);
  }

  const mentionedBot = Boolean(message.mentions?.users?.has?.(client.user.id));
  if (mentionedBot) {
    return "mention";
  }

  if (await isReplyToBot(message, client)) {
    return "reply";
  }

  const refreshedActiveConversation = getActiveConversation(message.channelId);
  if (
    refreshedActiveConversation &&
    refreshedActiveConversation.userId === message.author.id
  ) {
    return "active";
  }

  return null;
}

function buildUserPrompt(message, client) {
  const fromMention = stripBotMention(message.content, client.user.id)
    .replace(/^[\s,.;:!?-]+/, "")
    .trim();

  const cleanMessage = normalizeMultilineText(
    fromMention || message.content || "",
    MAX_INPUT_CHARS,
  );

  return cleanMessage || "Oi! Preciso de ajuda.";
}

function isUnknownMessageReferenceError(error) {
  return (
    error?.code === 50035 &&
    String(error?.rawError?.errors?.message_reference?._errors?.[0]?.code || "").includes("MESSAGE_REFERENCE_UNKNOWN_MESSAGE")
  );
}

async function sendReply(message, content, options = {}) {
  const chunks = splitDiscordMessage(content);
  if (!chunks.length) return;

  const preferReply = options.preferReply !== false;
  const [firstChunk, ...restChunks] = chunks;
  const basePayload = {
    content: firstChunk,
    allowedMentions: {
      repliedUser: false,
      parse: [],
      roles: [],
      users: [],
    },
  };

  if (preferReply) {
    try {
      await message.reply(basePayload);
    } catch (error) {
      if (!isUnknownMessageReferenceError(error)) {
        throw error;
      }

      await message.channel.send({
        content: firstChunk,
        allowedMentions: { parse: [], roles: [], users: [] },
      });
    }
  } else {
    await message.channel.send({
      content: firstChunk,
      allowedMentions: { parse: [], roles: [], users: [] },
    });
  }

  for (const chunk of restChunks) {
    await message.channel.send({
      content: chunk,
      allowedMentions: { parse: [], roles: [], users: [] },
    });
  }
}

function sanitizeAssistantReply(content) {
  const clean = normalizeMultilineText(content, 4000);
  if (!clean) return "";

  if (clean.includes("```")) {
    return [
      "Posso explicar sem gerar scripts ou blocos de codigo por aqui.",
      "",
      "Se quiser, me diga o objetivo e eu descrevo a logica passo a passo em linguagem natural.",
    ].join("\n");
  }

  return clean;
}

function buildQuickReply(userText) {
  return QUICK_RESPONSES.get(normalizeIntentText(userText)) || null;
}

function buildAbuseKey(message) {
  return `${message.guildId}:${message.author?.id || "unknown-user"}`;
}

function evaluateAbuseRisk(message, prompt, handlingMode) {
  const currentTime = nowMs();
  const abuseKey = buildAbuseKey(message);
  const current = abuseStore.get(abuseKey) || {
    timestamps: [],
    blockedUntil: 0,
    lastWarnAt: 0,
    updatedAt: currentTime,
  };

  current.updatedAt = currentTime;

  if (current.blockedUntil > currentTime) {
    abuseStore.set(abuseKey, current);
    return { action: "ignore" };
  }

  const longCutoff = currentTime - ABUSE_LONG_WINDOW_MS;
  current.timestamps = pruneTimestamps(current.timestamps, longCutoff);
  current.timestamps.push(currentTime);

  const shortCutoff = currentTime - ABUSE_SHORT_WINDOW_MS;
  const shortCount = current.timestamps.filter((timestamp) => timestamp >= shortCutoff).length;
  const longCount = current.timestamps.length;

  if (shortCount >= ABUSE_SHORT_LIMIT || longCount >= ABUSE_LONG_LIMIT) {
    current.blockedUntil = currentTime + ABUSE_BLOCK_MS;
    abuseStore.set(abuseKey, current);

    if (current.lastWarnAt + 1000 * 30 <= currentTime) {
      current.lastWarnAt = currentTime;
      abuseStore.set(abuseKey, current);
      return {
        action: "warn",
        reply:
          "Voce enviou mensagens muito rapido. Aguarde um pouco e mande uma pergunta por vez para eu continuar te ajudando.",
      };
    }

    return { action: "ignore" };
  }

  abuseStore.set(abuseKey, current);

  const normalizedPrompt = normalizeIntentText(prompt);
  const duplicateKey = `${getConversationKey(message)}:${handlingMode}`;
  const lastDuplicate = duplicatePromptStore.get(duplicateKey) || null;

  if (
    lastDuplicate &&
    lastDuplicate.prompt === normalizedPrompt &&
    currentTime - lastDuplicate.updatedAt <= DUPLICATE_PROMPT_TTL_MS
  ) {
    return { action: "ignore" };
  }

  duplicatePromptStore.set(duplicateKey, {
    prompt: normalizedPrompt,
    updatedAt: currentTime,
  });

  return { action: "allow" };
}

async function replyWithProcessingNotice(message, conversationKey) {
  const currentTime = nowMs();
  const lastNoticeAt = processingNoticeStore.get(conversationKey) || 0;
  if (currentTime - lastNoticeAt < PROCESSING_NOTICE_TTL_MS) {
    return;
  }

  processingNoticeStore.set(conversationKey, currentTime);
  await sendReply(
    message,
    "Ainda estou processando sua mensagem anterior. Me manda a proxima em alguns segundos.",
  );
}

async function resolveGuildForContext(message, client) {
  if (message.guild) return message.guild;
  return await client.guilds.fetch(message.guildId).catch(() => null);
}

function mapChannelInfo(channel) {
  return {
    id: channel.id,
    name: channel.name || "canal-sem-nome",
    parentId: channel.parentId || null,
    isTextBased:
      typeof channel.isTextBased === "function" ? channel.isTextBased() : Boolean(channel.isTextBased),
    type: channel.type,
  };
}

async function getGuildContextData(message, client) {
  cleanupExpiredState();
  const cached = guildContextCache.get(message.guildId);
  if (cached && cached.updatedAt >= nowMs() - GUILD_CONTEXT_TTL_MS) {
    return cached.data;
  }

  const guild = await resolveGuildForContext(message, client);
  if (!guild) return null;

  if (!guild.channels?.cache?.size) {
    await guild.channels.fetch().catch(() => null);
  }

  const channels = Array.from(guild.channels?.cache?.values?.() || [])
    .filter(Boolean)
    .map(mapChannelInfo);

  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));

  let ticketRuntime = null;
  try {
    ticketRuntime = await getGuildTicketRuntime(guild.id);
  } catch (error) {
    console.warn("[ai-mention] falha ao carregar contexto de ticket:", {
      guildId: guild.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const data = {
    guildId: guild.id,
    guildName: guild.name || "Servidor",
    memberCount: typeof guild.memberCount === "number" ? guild.memberCount : null,
    channels,
    channelsById,
    ticketRuntime,
    cacheKey: `${ticketRuntime?.settings?.updated_at || "no-ticket"}:${ticketRuntime?.staffSettings?.updated_at || "no-staff"}:${channels.length}`,
  };

  guildContextCache.set(message.guildId, {
    updatedAt: nowMs(),
    data,
  });

  return data;
}

function formatChannelReference(guildContext, channelId) {
  if (!channelId) return "nao configurado";
  const channel = guildContext?.channelsById?.get(channelId) || null;
  if (!channel) {
    return `<#${channelId}>`;
  }

  if (channel.isTextBased) {
    return `<#${channel.id}>`;
  }

  return `\`${channel.name}\``;
}

function formatRoleReference(roleId) {
  if (!roleId) return "nao configurado";
  return `<@&${roleId}>`;
}

function formatRoleList(roleIds) {
  if (!Array.isArray(roleIds) || !roleIds.length) {
    return "nao configurado";
  }

  const valid = roleIds.filter((roleId) => typeof roleId === "string" && roleId.trim());
  if (!valid.length) {
    return "nao configurado";
  }

  return valid.map((roleId) => `<@&${roleId}>`).join(", ");
}

function extractPromptKeywords(prompt) {
  return normalizeIntentText(prompt)
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && !STOP_WORDS.has(part))
    .slice(0, 8);
}

function selectRelevantChannels(guildContext, prompt) {
  if (!guildContext?.channels?.length) return [];

  const keywords = extractPromptKeywords(prompt);
  const scored = [];

  for (const channel of guildContext.channels) {
    const normalizedName = normalizeIntentText(channel.name);
    let score = 0;

    for (const keyword of keywords) {
      if (normalizedName.includes(keyword)) {
        score += 2;
      }
    }

    if (score > 0) {
      scored.push({ channel, score });
    }
  }

  return scored
    .sort((left, right) => right.score - left.score || left.channel.name.localeCompare(right.channel.name))
    .slice(0, 5)
    .map((item) => item.channel);
}

function buildTicketLocationReply(guildContext) {
  const settings = guildContext?.ticketRuntime?.settings || null;
  if (!settings?.menu_channel_id) {
    return [
      "Posso te orientar, mas o canal principal de ticket nao esta configurado no meu contexto agora.",
      "",
      "Se o painel nao aparecer no servidor, chame a equipe para verificar a configuracao do ticket.",
    ].join("\n");
  }

  const panelButton = settings.panel_button_label || "Abrir ticket";
  const panelChannel = formatChannelReference(guildContext, settings.menu_channel_id);
  const category = settings.tickets_category_id
    ? formatChannelReference(guildContext, settings.tickets_category_id)
    : null;

  return [
    "Para abrir um ticket neste servidor:",
    `1. Va em ${panelChannel}.`,
    `2. Clique em **${panelButton}**.`,
    category ? `3. O atendimento deve ser criado em ${category}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPanelReply(guildContext) {
  const settings = guildContext?.ticketRuntime?.settings || null;
  if (!settings) {
    return "O painel de ticket nao esta configurado no meu contexto agora.";
  }

  return [
    "Sobre o painel de ticket deste servidor:",
    `- Canal do painel: ${formatChannelReference(guildContext, settings.menu_channel_id)}`,
    `- Titulo: \`${settings.panel_title || "Central de Atendimento"}\``,
    `- Botao principal: \`${settings.panel_button_label || "Abrir ticket"}\``,
    settings.panel_message_id ? `- Mensagem do painel: \`${settings.panel_message_id}\`` : "- Mensagem do painel: ainda nao registrada",
  ].join("\n");
}

function buildLogsReply(guildContext) {
  const settings = guildContext?.ticketRuntime?.settings || null;
  if (!settings) {
    return "Os canais de log do sistema de tickets nao estao configurados no meu contexto agora.";
  }

  return [
    "Sobre os logs do ticket:",
    `- Log de criacao: ${formatChannelReference(guildContext, settings.logs_created_channel_id)}`,
    `- Log de fechamento: ${formatChannelReference(guildContext, settings.logs_closed_channel_id)}`,
    "- O fechamento do ticket e o transcript ficam vinculados ao fluxo de encerramento.",
  ].join("\n");
}

function buildStaffReply(guildContext) {
  const staffSettings = guildContext?.ticketRuntime?.staffSettings || null;
  if (!staffSettings) {
    return "As configuracoes de staff do ticket nao estao disponiveis no meu contexto agora.";
  }

  return [
    "Sobre a equipe de tickets:",
    `- Cargo admin: ${formatRoleReference(staffSettings.admin_role_id)}`,
    `- Cargos que podem assumir: ${formatRoleList(staffSettings.claim_role_ids)}`,
    `- Cargos que podem fechar: ${formatRoleList(staffSettings.close_role_ids)}`,
    `- Cargos notificados: ${formatRoleList(staffSettings.notify_role_ids)}`,
  ].join("\n");
}

function buildCategoryReply(guildContext) {
  const settings = guildContext?.ticketRuntime?.settings || null;
  if (!settings) {
    return "A categoria de tickets nao esta configurada no meu contexto agora.";
  }

  return [
    "Sobre a categoria dos tickets:",
    `- Categoria configurada: ${formatChannelReference(guildContext, settings.tickets_category_id)}`,
    `- O painel principal fica em: ${formatChannelReference(guildContext, settings.menu_channel_id)}`,
  ].join("\n");
}

function buildTranscriptReply(guildContext) {
  const settings = guildContext?.ticketRuntime?.settings || null;
  const closedLog = formatChannelReference(guildContext, settings?.logs_closed_channel_id);

  return [
    "Sobre o transcript:",
    "- Ele e tratado quando o ticket e fechado.",
    "- Se houver mensagens suficientes, o sistema protege o transcript e registra o link no log de fechamento.",
    `- O log principal de fechamento fica em: ${closedLog}`,
    "- Quando possivel, o codigo do transcript vai no privado do solicitante.",
    "- Se faltar mensagens suficientes, o transcript pode ficar indisponivel e o usuario recebe apenas o resumo/protocolo.",
  ].join("\n");
}

function isTicketLocationQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  const hasTicketWord =
    normalized.includes("ticket") ||
    normalized.includes("suporte") ||
    normalized.includes("chamado");
  const hasOpenWord =
    normalized.includes("abrir") ||
    normalized.includes("abre") ||
    normalized.includes("abro") ||
    normalized.includes("onde") ||
    normalized.includes("como") ||
    normalized.includes("qual canal");

  return hasTicketWord && hasOpenWord;
}

function isPanelQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  return normalized.includes("painel") || normalized.includes("botao do ticket");
}

function isLogsQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  return normalized.includes("logs") || normalized.includes("log de ticket") || normalized.includes("log ticket");
}

function isStaffQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  return (
    normalized.includes("staff") ||
    normalized.includes("equipe de ticket") ||
    normalized.includes("quem pode assumir") ||
    normalized.includes("quem pode fechar")
  );
}

function isRoleQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  return (
    normalized.includes("cargo") ||
    normalized.includes("cargos") ||
    normalized.includes("role") ||
    normalized.includes("roles")
  );
}

function isCategoryQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  return normalized.includes("categoria") || normalized.includes("onde cria o ticket");
}

function isTranscriptQuestion(prompt) {
  const normalized = normalizeIntentText(prompt);
  return (
    normalized.includes("transcript") ||
    normalized.includes("historico") ||
    normalized.includes("transcricao") ||
    normalized.includes("codigo do transcript")
  );
}

function buildInterestClarifierReply(prompt) {
  const normalized = normalizeIntentText(prompt);

  if (
    normalized.includes("quero comprar") ||
    normalized.includes("tenho interesse") ||
    normalized.includes("queria comprar") ||
    normalized.includes("quero adquirir")
  ) {
    return "Claro. Se for sobre compra, me diz so qual e a duvida principal: comprar, pagamento, plano ou como funciona.";
  }

  if (
    normalized.includes("quero parceria") ||
    normalized.includes("quero ser parceiro") ||
    normalized.includes("parceria")
  ) {
    return "Claro. Se for parceria, me manda o ponto principal ou o que voce quer entender primeiro que eu te guio por aqui.";
  }

  return null;
}

function buildRelevantServerContext(guildContext, prompt) {
  if (!guildContext) return "";

  const sections = [];
  sections.push(`Servidor atual: ${guildContext.guildName}`);

  if (typeof guildContext.memberCount === "number") {
    sections.push(`Membros visiveis: ${guildContext.memberCount}`);
  }

  const settings = guildContext.ticketRuntime?.settings || null;
  if (settings) {
    sections.push(
      [
        "Configuracao de ticket:",
        `- Canal do painel: ${formatChannelReference(guildContext, settings.menu_channel_id)}`,
        `- Categoria dos tickets: ${formatChannelReference(guildContext, settings.tickets_category_id)}`,
        `- Log de criacao: ${formatChannelReference(guildContext, settings.logs_created_channel_id)}`,
        `- Log de fechamento: ${formatChannelReference(guildContext, settings.logs_closed_channel_id)}`,
        `- Botao do painel: ${settings.panel_button_label || "Abrir ticket"}`,
        `- Titulo do painel: ${settings.panel_title || "Central de Atendimento"}`,
      ].join("\n"),
    );
  }

  const staffSettings = guildContext.ticketRuntime?.staffSettings || null;
  if (staffSettings) {
    sections.push(
      [
        "Configuracao de staff:",
        `- Admin: ${formatRoleReference(staffSettings.admin_role_id)}`,
        `- Assume: ${formatRoleList(staffSettings.claim_role_ids)}`,
        `- Fecha: ${formatRoleList(staffSettings.close_role_ids)}`,
        `- Notificados: ${formatRoleList(staffSettings.notify_role_ids)}`,
      ].join("\n"),
    );
  }

  const relevantChannels = selectRelevantChannels(guildContext, prompt);
  if (relevantChannels.length) {
    sections.push(
      [
        "Canais relacionados ao assunto:",
        ...relevantChannels.map((channel) => `- ${formatChannelReference(guildContext, channel.id)} (${channel.name})`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n").slice(0, 1600);
}

function buildRuleBasedReply(userText, guildContext) {
  const quickReply = buildQuickReply(userText);
  if (quickReply) {
    return {
      content: quickReply,
      closeConversation: includesAny(normalizeIntentText(userText), CLOSING_MESSAGE_HINTS),
      source: "quick_reply",
    };
  }

  const normalized = normalizeIntentText(userText);

  if (isScriptRequest(userText)) {
    return {
      content: [
        "Nao envio scripts ou codigo por aqui.",
        "",
        "> **Posso ajudar sem codigo**",
        "Posso explicar a logica, os passos, a configuracao ideal ou como resolver o problema em linguagem simples.",
        "",
        "Se quiser, me diga o objetivo ou o erro e eu te explico do jeito mais direto possivel.",
      ].join("\n"),
      closeConversation: false,
      source: "script_block",
    };
  }

  const interestClarifier = buildInterestClarifierReply(userText);
  if (interestClarifier) {
    return {
      content: interestClarifier,
      closeConversation: false,
      source: "interest_clarifier",
    };
  }

  if (isTicketLocationQuestion(userText)) {
    return {
      content: buildTicketLocationReply(guildContext),
      closeConversation: false,
      source: "ticket_location",
    };
  }

  if (isPanelQuestion(userText)) {
    return {
      content: buildPanelReply(guildContext),
      closeConversation: false,
      source: "panel_info",
    };
  }

  if (isLogsQuestion(userText)) {
    return {
      content: buildLogsReply(guildContext),
      closeConversation: false,
      source: "logs_info",
    };
  }

  if (isStaffQuestion(userText) || isRoleQuestion(userText)) {
    return {
      content: buildStaffReply(guildContext),
      closeConversation: false,
      source: "staff_info",
    };
  }

  if (isCategoryQuestion(userText)) {
    return {
      content: buildCategoryReply(guildContext),
      closeConversation: false,
      source: "category_info",
    };
  }

  if (isTranscriptQuestion(userText)) {
    return {
      content: buildTranscriptReply(guildContext),
      closeConversation: false,
      source: "transcript_info",
    };
  }

  if (includesAny(normalized, CLOSING_MESSAGE_HINTS)) {
    return {
      content: "Perfeito. Se precisar de novo, e so me chamar.",
      closeConversation: true,
      source: "closing_reply",
    };
  }

  return null;
}

function buildResponseCacheKey(message, prompt, guildContext) {
  return [
    message.guildId,
    guildContext?.cacheKey || "no-context",
    normalizeIntentText(prompt),
  ].join(":");
}

function getCachedResponse(cacheKey) {
  cleanupExpiredState();
  const entry = responseCache.get(cacheKey);
  if (!entry) return null;
  return entry.content || null;
}

function setCachedResponse(cacheKey, content) {
  responseCache.set(cacheKey, {
    updatedAt: nowMs(),
    content,
  });
}

async function callOpenAI(messages, userId) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY nao configurada.");
  }

  if (typeof fetch !== "function") {
    throw new Error("Fetch indisponivel no runtime.");
  }

  let lastError = null;

  for (const model of buildModelCandidates()) {
    const response = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.45,
        max_tokens: MAX_OUTPUT_TOKENS,
        user: userId ? String(userId).slice(0, 64) : undefined,
      }),
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      lastError = new Error(
        `Falha ao chamar OpenAI com ${model}: ${response.status} ${response.statusText} ${rawText}`,
      );

      if (isModelAccessError(response.status, rawText)) {
        unavailableModelCache.set(model, nowMs() + 1000 * 60 * 30);
        console.warn(`[ai-mention] modelo sem acesso, tentando fallback: ${model}`);
        continue;
      }

      if (response.status >= 500 || response.status === 429) {
        console.warn(`[ai-mention] erro temporario com ${model}, tentando fallback.`);
        continue;
      }

      throw lastError;
    }

    const data = parseErrorPayload(rawText);
    const content = normalizeMultilineText(
      data?.choices?.[0]?.message?.content || "",
      4000,
    );

    if (!content) {
      lastError = new Error(`Resposta vazia da OpenAI com ${model}.`);
      continue;
    }

    unavailableModelCache.delete(model);
    return { content, model };
  }

  throw lastError || new Error("Nenhum modelo disponivel respondeu com sucesso.");
}

function resolveResponseAccentColor(source) {
  switch (source) {
    case "fallback":
    case "abuse_warn":
      return 0xf1c40f;
    case "script_block":
      return 0xe67e22;
    case "cache":
      return 0x3498db;
    default:
      return 0x2ecc71;
  }
}

function buildAiLogPayload({ message, prompt, response, source, model, handlingMode }) {
  const questionBlock = sanitizeForLog(prompt);
  const responseBlock = sanitizeForLog(response);
  const timestamp = Math.floor(nowMs() / 1000);

  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], roles: [], users: [] },
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x5865f2,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              "### Pergunta",
              questionBlock || "Pergunta vazia",
            ].join("\n\n"),
          },
          {
            type: COMPONENT_TYPE.SEPARATOR,
            divider: true,
            spacing: SeparatorSpacingSize.Small,
          },
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              `-# Usuario: <@${message.author?.id || "0"}>`,
              `-# Canal: <#${message.channelId}>`,
              `-# Fluxo: \`${handlingMode}\``,
              `-# Origem: \`${source}\``,
              `-# Enviado em: <t:${timestamp}:F>`,
            ].join("\n"),
          },
        ],
      },
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: resolveResponseAccentColor(source),
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              "### Resposta",
              responseBlock || "Resposta vazia",
            ].join("\n\n"),
          },
          {
            type: COMPONENT_TYPE.SEPARATOR,
            divider: true,
            spacing: SeparatorSpacingSize.Small,
          },
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              `-# Modelo: \`${model || "rule-based"}\``,
              `-# Guild: \`${message.guildId}\``,
            ].join("\n"),
          },
        ],
      },
    ],
  };
}

async function sendAiInteractionLog(client, message, payload) {
  try {
    if (!client?.channels?.fetch) return;

    const logChannel = await client.channels
      .fetch(env.aiMentionLogChannelId)
      .catch(() => null);

    if (!logChannel || typeof logChannel.send !== "function") {
      return;
    }

    await logChannel.send(buildAiLogPayload({
      message,
      prompt: payload.prompt,
      response: payload.response,
      source: payload.source,
      model: payload.model,
      handlingMode: payload.handlingMode,
    }));
  } catch (error) {
    console.error("[ai-mention-log] falha ao registrar conversa:", error);
  }
}

async function deliverReplyAndLog({
  client,
  message,
  prompt,
  response,
  source,
  model,
  handlingMode,
}) {
  await sendReply(message, response, {
    preferReply: handlingMode !== "proactive",
  });
  await sendAiInteractionLog(client, message, {
    prompt,
    response,
    source,
    model,
    handlingMode,
  });
}

async function generateConversationReply({
  client,
  message,
  prompt,
  handlingMode,
}) {
  const userId = message.author?.id || "unknown-user";
  const conversationKey = getConversationKey(message);
  const guildContext = await getGuildContextData(message, client).catch(() => null);
  const channelProfile = classifyCommunityChannel(message);
  const history = getConversationHistory(conversationKey);
  const ruleBasedReply = buildRuleBasedReply(prompt, guildContext);

  let typingInterval = null;

  try {
    setActiveConversation(message.channelId, userId);

    if (ruleBasedReply) {
      appendConversationTurn(conversationKey, "user", prompt);
      appendConversationTurn(conversationKey, "assistant", ruleBasedReply.content);
      await deliverReplyAndLog({
        client,
        message,
        prompt,
        response: ruleBasedReply.content,
        source: ruleBasedReply.source,
        model: null,
        handlingMode,
      });
      if (ruleBasedReply.closeConversation) {
        clearActiveConversation(message.channelId);
      }
      return true;
    }

    const shouldUseCache =
      history.length === 0 &&
      handlingMode !== "active" &&
      normalizeIntentText(prompt).length <= 180;
    const cacheKey = buildResponseCacheKey(message, prompt, guildContext);
    if (shouldUseCache) {
      const cachedResponse = getCachedResponse(cacheKey);
      if (cachedResponse) {
        appendConversationTurn(conversationKey, "user", prompt);
        appendConversationTurn(conversationKey, "assistant", cachedResponse);
        await deliverReplyAndLog({
          client,
          message,
          prompt,
          response: cachedResponse,
          source: "cache",
          model: null,
          handlingMode,
        });
        return true;
      }
    }

    await message.channel.sendTyping().catch(() => null);
    typingInterval = setInterval(() => {
      void message.channel.sendTyping().catch(() => null);
    }, 8000);

    const serverContext = buildRelevantServerContext(guildContext, prompt);
    const toneGuidance = buildCommunityToneGuidanceForContext(
      normalizeIntentText(prompt),
      channelProfile,
    );
    const result = await callOpenAI(
      [
        { role: "system", content: buildDynamicSystemPrompt(guildContext) },
        ...(toneGuidance
          ? [{ role: "system", content: toneGuidance }]
          : []),
        ...(serverContext
          ? [{ role: "system", content: `Contexto real do servidor:\n${serverContext}` }]
          : []),
        ...history,
        { role: "user", content: prompt },
      ],
      userId,
    );
    const sanitizedReply = sanitizeAssistantReply(result.content);

    appendConversationTurn(conversationKey, "user", prompt);
    appendConversationTurn(conversationKey, "assistant", sanitizedReply);
    setActiveConversation(message.channelId, userId);

    if (shouldUseCache && sanitizedReply) {
      setCachedResponse(cacheKey, sanitizedReply);
    }

    console.info(
      `[ai-mention] resposta enviada em guild=${message.guildId} channel=${message.channelId} user=${userId} model=${result.model} mode=${handlingMode}`,
    );

    await deliverReplyAndLog({
      client,
      message,
      prompt,
      response: sanitizedReply,
      source: "ai",
      model: result.model,
      handlingMode,
    });
    return true;
  } catch (error) {
    console.error("[ai-mention] erro ao gerar resposta:", error);
    const fallbackReply = buildFallbackReply(prompt);
    appendConversationTurn(conversationKey, "user", prompt);
    appendConversationTurn(conversationKey, "assistant", fallbackReply);
    await deliverReplyAndLog({
      client,
      message,
      prompt,
      response: fallbackReply,
      source: "fallback",
      model: null,
      handlingMode,
    });
    return true;
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
  }
}

async function handleAiMention(message, client) {
  const handlingMode = await resolveHandlingMode(message, client);
  if (!handlingMode) return false;

  cancelProactiveCandidate(buildProactiveChannelKey(message));

  const userId = message.author?.id || "unknown-user";
  if (!canReplyToUser(userId)) {
    return false;
  }

  const conversationKey = getConversationKey(message);
  if (inFlightConversationKeys.has(conversationKey)) {
    await replyWithProcessingNotice(message, conversationKey);
    return true;
  }

  const prompt = buildUserPrompt(message, client);
  if (!prompt) {
    return false;
  }

  const abuseDecision = evaluateAbuseRisk(message, prompt, handlingMode);
  if (abuseDecision.action === "ignore") {
    return true;
  }
  if (abuseDecision.action === "warn") {
    clearActiveConversation(message.channelId);
    await deliverReplyAndLog({
      client,
      message,
      prompt,
      response: abuseDecision.reply,
      source: "abuse_warn",
      model: null,
      handlingMode,
    });
    return true;
  }

  markUserReplied(userId);
  inFlightConversationKeys.add(conversationKey);

  try {
    return await generateConversationReply({
      client,
      message,
      prompt,
      handlingMode,
    });
  } finally {
    inFlightConversationKeys.delete(conversationKey);
  }
}

function cancelProactiveCandidate(channelKey) {
  const entry = proactiveConversationStore.get(channelKey);
  if (!entry) return;
  if (entry.timeout) {
    clearTimeout(entry.timeout);
  }
  proactiveConversationStore.delete(channelKey);
}

async function flushProactiveCandidate(channelKey) {
  const entry = proactiveConversationStore.get(channelKey);
  if (!entry) return false;

  proactiveConversationStore.delete(channelKey);

  const latestMessage = entry.latestMessage;
  const client = entry.client;
  const prompt = normalizeMultilineText(entry.parts.join("\n"), MAX_INPUT_CHARS);
  if (!latestMessage || !client?.user || !prompt) {
    return false;
  }

  const userId = latestMessage.author?.id || "unknown-user";
  const conversationKey = getConversationKey(latestMessage);

  if (hasRecentProactiveReply(userId)) {
    return false;
  }

  const activeConversation = getActiveConversation(latestMessage.channelId);
  if (activeConversation && activeConversation.userId === userId) {
    return false;
  }

  const recentMessages = await latestMessage.channel.messages
    .fetch({ limit: 8 })
    .catch(() => null);

  if (recentMessages) {
    const hasNewerOtherMessage = recentMessages.some((channelMessage) => {
      return (
        channelMessage.createdTimestamp > entry.lastUserMessageAt &&
        channelMessage.author?.id !== userId
      );
    });

    if (hasNewerOtherMessage) {
      return false;
    }
  }

  if (inFlightConversationKeys.has(conversationKey)) {
    return false;
  }

  markRecentProactiveReply(userId);
  markUserReplied(userId);
  inFlightConversationKeys.add(conversationKey);

  try {
    return await generateConversationReply({
      client,
      message: latestMessage,
      prompt,
      handlingMode: "proactive",
    });
  } finally {
    inFlightConversationKeys.delete(conversationKey);
  }
}

async function observePotentialCommunityQuestion(message, client) {
  const prompt = normalizeMultilineText(message.content || "", MAX_INPUT_CHARS);
  const channelKey = buildProactiveChannelKey(message);
  const channelProfile = classifyCommunityChannel(message);
  const existing = proactiveConversationStore.get(channelKey);

  if (existing && existing.userId !== message.author?.id) {
    cancelProactiveCandidate(channelKey);
  }

  if (!shouldObserveProactively(message, prompt)) {
    return false;
  }

  const nextEntry = existing && existing.userId === message.author?.id
    ? {
        ...existing,
        latestMessage: message,
        lastUserMessageAt: message.createdTimestamp,
        channelProfile,
        parts: [...existing.parts, prompt].slice(-3),
      }
    : {
        client,
        userId: message.author?.id || "unknown-user",
        latestMessage: message,
        lastUserMessageAt: message.createdTimestamp,
        parts: [prompt],
        channelProfile,
        timeout: null,
      };

  if (nextEntry.timeout) {
    clearTimeout(nextEntry.timeout);
  }

  nextEntry.timeout = setTimeout(() => {
    void flushProactiveCandidate(channelKey);
  }, channelProfile.proactiveDelayMs || PROACTIVE_REPLY_DELAY_MS);

  proactiveConversationStore.set(channelKey, nextEntry);
  return false;
}

module.exports = { handleAiMention, observePotentialCommunityQuestion };
