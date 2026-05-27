const {
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const { canClaimTicket, canCloseTicket } = require("../utils/staff");
const { sendRefundProcessedEmail } = require("./emailNotificationService");
const { processDirectMessageQueue } = require("./directMessageQueueService");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const REFUND_PREFIX = "ticket:refund:";
const DEFAULT_OFFICIAL_SUPPORT_GUILD_ID = "1353259338759671838";
const DEFAULT_REFUND_DAYS = 7;
const ORDER_LOOKUP_TIMEOUT_MS = 12_000;
const REFUND_CONTEXT_TTL_MS = 1000 * 60 * 60;
const REFUND_PROMPT_COOLDOWN_MS = 1000 * 35;
const REFUND_LOGIN_LINK_TTL_MS = 1000 * 60 * 15;
const REFUND_LOGIN_POLL_MS = 5000;
const REFUND_LOGIN_POLL_MAX_MS = 1000 * 60 * 5;
const REFUND_LOOKUP_RATE_LIMIT_WINDOW_MS = 1000 * 60 * 10;
const REFUND_LOOKUP_RATE_LIMIT_MAX = 5;
const COMPONENTS_V2_FLAG = MessageFlags.IsComponentsV2 || 32768;

const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
};

const pendingRefundActions = new Set();
const activeLoginPollers = new Map();
const lookupBuckets = new Map();

function isOfficialSupportGuild(guildId) {
  const configuredOfficialGuildId =
    String(env.officialSupportGuildId || "").trim() || DEFAULT_OFFICIAL_SUPPORT_GUILD_ID;
  return String(guildId || "").trim() === configuredOfficialGuildId;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, maxLength = 1800) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeIntentText(value) {
  return normalizeText(value, 2200)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textDisplay(content) {
  return {
    type: COMPONENT_TYPE.TEXT_DISPLAY,
    content: truncateText(content, 3900),
  };
}

function separator() {
  return {
    type: COMPONENT_TYPE.SEPARATOR,
    divider: true,
    spacing: 1,
  };
}

function actionRow(components) {
  return {
    type: COMPONENT_TYPE.ACTION_ROW,
    components,
  };
}

function linkButton({ label, url }) {
  return {
    type: COMPONENT_TYPE.BUTTON,
    style: ButtonStyle.Link,
    label: truncateText(label, 80),
    url,
  };
}

function button({ customId, label, style = ButtonStyle.Secondary, disabled = false }) {
  return {
    type: COMPONENT_TYPE.BUTTON,
    style,
    custom_id: customId,
    label: truncateText(label, 80),
    disabled,
  };
}

function selectMenu({ customId, placeholder, options }) {
  return {
    type: COMPONENT_TYPE.STRING_SELECT,
    custom_id: customId,
    placeholder: truncateText(placeholder, 100),
    min_values: 1,
    max_values: 1,
    options,
  };
}

function v2Message(components, extra = {}) {
  const extraFlags = Number(extra.flags || 0);
  return {
    ...extra,
    flags: extraFlags | COMPONENTS_V2_FLAG,
    allowedMentions: extra.allowedMentions || { parse: [] },
    components,
  };
}

function resolveRefundToneColor(tone) {
  switch (tone) {
    case "success":
      return 0x2ecc71;
    case "warning":
      return 0xf1c40f;
    case "error":
      return 0xe74c3c;
    case "processing":
      return 0x3498db;
    default:
      return 0x2b2d31;
  }
}

function buildRefundV2Payload({ title, message, tone = "neutral", footer = "", actions = [] }) {
  const containerComponents = [
    textDisplay(
      [
        title ? `### ${title}` : "",
        normalizeText(message || "", 3600),
      ].filter(Boolean).join("\n\n"),
    ),
  ];

  if (footer) {
    containerComponents.push(separator());
    containerComponents.push(textDisplay(`-# ${normalizeText(footer, 700)}`));
  }

  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: resolveRefundToneColor(tone),
      components: containerComponents,
    },
  ];

  if (actions.length) {
    components.push(actionRow(actions));
  }

  return v2Message(components);
}

function buildAppUrl(path) {
  const base = String(env.appUrl || "https://www.flwdesk.com").replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function createSecureToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSecureToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || "").trim(), "utf8")
    .digest("hex");
}

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractEmail(text) {
  const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function normalizeLookupToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^#+/, "")
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function extractOrderCandidates(text, options = {}) {
  const raw = String(text || "");
  const withoutEmails = raw.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  const normalized = normalizeIntentText(withoutEmails);
  const candidates = [];

  const pushCandidate = (value, explicit = false) => {
    const token = normalizeLookupToken(value);
    if (!token || !/\d/.test(token)) return;
    if (token.length < 2) return;
    if (!explicit && token.length < (options.allowShortGeneric ? 2 : 4)) return;
    if (candidates.includes(token)) return;
    candidates.push(token);
  };

  const explicitPattern =
    /(?:#|pedido|ordem|order|compra|numero|num|n|id|codigo|cod|protocolo|e o|eh o)\s*(?:do|da|n|numero|pedido)?\s*[:#-]?\s*([a-z0-9][a-z0-9_-]{1,63})/gi;
  for (const match of normalized.matchAll(explicitPattern)) {
    pushCandidate(match[1], true);
  }

  for (const match of withoutEmails.matchAll(/#\s*([a-z0-9][a-z0-9_-]{1,63})/gi)) {
    pushCandidate(match[1], true);
  }

  const genericPattern = options.allowShortGeneric
    ? /\b(?:[a-z]{2,}-)?[a-z0-9]{2,64}\b/gi
    : /\b(?:[a-z]{2,}-)?[a-z0-9]{4,64}\b/gi;
  for (const match of withoutEmails.matchAll(genericPattern)) {
    const candidate = match[0];
    if (candidate.includes("@")) continue;
    pushCandidate(candidate, false);
  }

  return candidates.slice(0, 6);
}

function includesAny(normalized, hints) {
  return hints.some((hint) => normalized.includes(hint));
}

function isRefundOrOrderIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "reembolso",
    "estorno",
    "refund",
    "devolver dinheiro",
    "cancelar compra",
    "cancelamento da compra",
    "cancelar meu pedido",
    "cancelar meu produto",
    "devolver o valor",
    "dinheiro de volta",
    "quero meu dinheiro",
  ]);
}

function isRefundProceedIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "quero reembolso",
    "quero o reembolso",
    "quero meu reembolso",
    "preciso de reembolso",
    "preciso do reembolso",
    "prefiro reembolso",
    "prefiro o reembolso",
    "so quero reembolso",
    "so o reembolso",
    "pode seguir com reembolso",
    "pode seguir com o reembolso",
    "pode fazer o reembolso",
    "faz o reembolso",
    "fazer reembolso",
    "reembolso mesmo",
    "o reembolso mesmo",
    "quero reembolso mesmo",
    "quero o reembolso mesmo",
    "quero seguir com reembolso",
    "quero seguir com o reembolso",
    "seguir com reembolso",
    "seguir com o reembolso",
    "continuar com reembolso",
    "continuar com o reembolso",
    "quero continuar com reembolso",
    "quero continuar com o reembolso",
    "prosseguir com reembolso",
    "prosseguir com o reembolso",
    "prosseguir reembolso",
    "sim quero reembolso",
    "sim quero o reembolso",
    "sim pode seguir",
    "sim pode fazer",
    "ja decidi",
    "decidi pelo reembolso",
    "quero mesmo",
    "seguir com estorno",
    "seguir com o estorno",
    "quero estorno mesmo",
    "estorno mesmo",
    "pode estornar",
    "estorna",
    "nao quero ajuda",
    "nao da",
    "nao deu",
    "nao resolveu",
    "sem solucao",
    "nao tem como resolver",
  ]);
}

function isRefundIntakeConfirmation(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  const mentionsRefund = /\b(reembolso|estorno|refund)\b/.test(normalized);
  if (!mentionsRefund) return false;
  const confirmationSignals = [
    "mesmo",
    "seguir",
    "continuar",
    "prosseguir",
    "pode",
    "quero",
    "sim",
    "decidi",
    "fazer",
  ];
  return confirmationSignals.some((signal) => normalized.includes(signal));
}

function isRefundHardProceedIntent(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  if (
    includesAny(normalized, [
      "reembolso mesmo",
      "o reembolso mesmo",
      "estorno mesmo",
      "quero seguir com reembolso",
      "quero seguir com o reembolso",
      "seguir com reembolso",
      "seguir com o reembolso",
      "quero continuar com reembolso",
      "quero continuar com o reembolso",
      "continuar com reembolso",
      "continuar com o reembolso",
      "prosseguir com reembolso",
      "prosseguir com o reembolso",
      "decidi pelo reembolso",
      "ja decidi",
      "nao quero ajuda",
    ])
  ) {
    return true;
  }

  return /\b(reembolso|estorno|refund)\b/.test(normalized) && /\b(mesmo|seguir|continuar|prosseguir|decidi)\b/.test(normalized);
}

function isRefundSupportConversationIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "qual problema",
    "posso explicar",
    "vou explicar",
    "me ajuda",
    "preciso de ajuda",
    "problema",
    "erro",
    "nao recebi",
    "nao chegou",
    "nao funciona",
    "duvida",
  ]);
}

function isOrderInfoIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "ajuda com meu pedido",
    "ajuda com pedido",
    "meu pedido",
    "me ajuda com a compra",
    "me ajuda com minha compra",
    "consultar pedido",
    "ver pedido",
    "verificar pedido",
    "status do pedido",
    "informacoes do pedido",
    "info do pedido",
    "data da compra",
    "dia da compra",
    "quando foi comprado",
    "quando comprei",
    "que dia foi comprado",
    "qual dia foi comprado",
    "qual foi o dia da compra",
    "em que dia foi comprado",
    "quando esse pedido foi comprado",
    "quando o pedido foi comprado",
    "nao recebi",
    "nao chegou",
  ]);
}

function assistantAskedForOrderNumber(historyRows) {
  const lastAssistant = [...(historyRows || [])]
    .reverse()
    .find((row) => row?.author_type === "assistant" || row?.author_type === "system");
  const normalized = normalizeIntentText(lastAssistant?.content || "");
  return Boolean(
    normalized &&
      includesAny(normalized, [
        "numero do pedido",
        "informe o numero",
        "me informe o numero",
        "envie o numero",
        "mande o numero",
        "pedido para verificar",
        "vou verificar",
      ]),
  );
}

async function getReferencedAuthorMessageContent(message) {
  const referencedId = message?.reference?.messageId;
  if (!referencedId || typeof message?.channel?.messages?.fetch !== "function") return "";
  const referenced = await message.channel.messages.fetch(referencedId).catch(() => null);
  if (!referenced || referenced.author?.id !== message.author?.id) return "";
  return String(referenced.content || "");
}

function isCancelRefundIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "esquece",
    "deixa pra la",
    "deixa quieto",
    "cancela isso",
    "cancelar isso",
    "cancelar reembolso",
    "outro assunto",
    "outra coisa",
    "nao quero mais",
  ]);
}

function isChangeAccountIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "trocar de conta",
    "mudar de conta",
    "outra conta",
    "mudar conta",
    "trocar a conta",
    "conta errada",
    "nao e essa",
    "vincular outra",
    "nova conta",
    "painel de vinculacao",
    "link de vinculacao",
    "tela de vinculacao",
    "vincular novamente",
    "mandar a vinculacao",
    "mandar o painel",
    "mandar o link de login",
    "login novamente",
    "logar de novo",
    "manda o login",
    "manda o botao de login",
    "deslogar",
    "painel de login",
    "vincular a conta",
    "vincular conta",
    "vincular novamente"
  ]);
}

function isResendEmbedIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "manda o embed",
    "manda de novo",
    "mandar novamente",
    "nao vi",
    "cade o embed",
    "cade o menu",
    "manda o menu",
    "recolocar",
    "apareceu nao",
    "nao apareceu"
  ]);
}

function isWaitingFiller(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return includesAny(normalized, [
    "pera",
    "perai",
    "vou ver",
    "vou procurar",
    "to procurando",
    "estou procurando",
    "nao achei",
    "n achei",
    "nao sei",
    "n sei",
    "calma",
    "um minuto",
    "so um minuto",
    "to no aguardo",
    "vou pegar",
    "ja mando",
    "ja envio",
    "aguardando",
    "ficar aguardando",
    "fico aguardando",
    "vou aguardar",
    "to aguardando",
    "estou aguardando",
    "obrigado",
    "muito obrigado",
    "valeu",
    "tudo certo",
    "entendido",
    "ok entendi",
    "ta certo",
    "ta bom",
    "fechou"
  ]);
}

function isOrderHelpQuestion(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "como vejo",
    "onde vejo",
    "onde acho",
    "onde encontro",
    "como acho",
    "nao sei o numero",
    "nao sei o pedido",
    "qual numero",
  ]);
}

function isTimingQuestion(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "demora",
    "quanto tempo",
    "prazo",
    "quando cai",
    "quando volta",
    "estorno demora",
  ]);
}

function isCasualGreetingIntent(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return includesAny(normalized, [
    "eae", "eai", "beleza", "opa", "oi", "ola", "olá", "tudo bem", "tudo bom", "bom dia", "boa tarde", "boa noite", "fala tu", "coé", "koe"
  ]) && normalized.length < 18;
}

function isThankYouIntent(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return includesAny(normalized, [
    "obrigado", "obrigada", "valeu", "obg", "agradecido", "agradecida", "tamo junto", "tmj", "perfeito", "show", "tks", "thanks", "vlw"
  ]) && normalized.length < 25;
}

function isHumanSupportIntent(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "falar com humano",
    "atendente",
    "suporte humano",
    "chamar staff",
    "chama a equipe",
    "preciso da equipe",
    "quero falar com alguem",
    "moderador",
  ]);
}

function isListOrdersIntent(text) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;
  return includesAny(normalized, [
    "tem algum pedido", "tem pedido", "tenho pedido", "meus pedidos", "minhas compras", "qual pedido",
    "quais compras", "listar pedidos", "ver compras", "ver pedidos", "tenho compra", "tem compra", "algum pedido meu",
    "manda novamente o menu", "manda o menu de novo", "manda o menu", "mostra o menu de novo", "mostra o menu",
    "quero ver o menu", "manda de novo o menu", "manda de novo", "estornar outro pedido", "reembolsar outro pedido",
    "quero fazer reembolso de outro pedido", "outro pedido", "mesmo pedido novamente", "reembolso do mesmo pedido"
  ]);
}

function containsManipulationAttempt(text) {
  const normalized = normalizeIntentText(text);
  return includesAny(normalized, [
    "ignore as regras",
    "ignora as regras",
    "burlar",
    "aprova sem validar",
    "aprovar sem validar",
    "finge que",
    "sou admin",
    "sem verificacao",
    "nao verifica",
  ]);
}

function createDefaultRefundState() {
  return {
    version: 2,
    intent: false,
    stage: null,
    authStatus: "unknown",
    authUserId: null,
    authLinkId: null,
    authConfirmedAt: null,
    loginMessageId: null,
    orderCandidates: [],
    failedOrderCandidates: [],
    availableOrderKeys: [],
    selectedOrderKey: null,
    lookupCount: 0,
    lastPromptKind: null,
    lastPromptAt: null,
    lastLookupAt: null,
    lastActionAt: null,
    riskScore: null,
  };
}

function coerceNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeRefundState(state) {
  const base = createDefaultRefundState();
  const merged = {
    ...base,
    ...(state && typeof state === "object" ? state : {}),
    version: 2,
  };

  merged.intent = merged.intent === true;
  merged.stage = typeof merged.stage === "string" ? merged.stage : null;
  merged.authStatus = typeof merged.authStatus === "string" ? merged.authStatus : "unknown";
  merged.authUserId = coerceNumberOrNull(merged.authUserId);
  merged.authLinkId = typeof merged.authLinkId === "string" ? merged.authLinkId : null;
  merged.authConfirmedAt =
    typeof merged.authConfirmedAt === "string" ? merged.authConfirmedAt : null;
  merged.loginMessageId =
    typeof merged.loginMessageId === "string" ? merged.loginMessageId : null;
  merged.orderCandidates = Array.isArray(merged.orderCandidates)
    ? merged.orderCandidates.map(normalizeLookupToken).filter(Boolean).slice(0, 8)
    : [];
  merged.failedOrderCandidates = Array.isArray(merged.failedOrderCandidates)
    ? merged.failedOrderCandidates.map(normalizeLookupToken).filter(Boolean).slice(0, 12)
    : [];
  merged.availableOrderKeys = Array.isArray(merged.availableOrderKeys)
    ? merged.availableOrderKeys.map((key) => String(key || "").slice(0, 90)).filter(Boolean).slice(0, 10)
    : [];
  merged.selectedOrderKey =
    typeof merged.selectedOrderKey === "string" ? merged.selectedOrderKey.slice(0, 90) : null;
  merged.lookupCount = Math.max(0, Number(merged.lookupCount || 0));
  merged.lastPromptKind =
    typeof merged.lastPromptKind === "string" ? merged.lastPromptKind : null;
  merged.lastPromptAt =
    typeof merged.lastPromptAt === "string" ? merged.lastPromptAt : null;
  merged.lastLookupAt =
    typeof merged.lastLookupAt === "string" ? merged.lastLookupAt : null;
  merged.lastActionAt =
    typeof merged.lastActionAt === "string" ? merged.lastActionAt : null;
  merged.riskScore = coerceNumberOrNull(merged.riskScore);
  return merged;
}

function isActiveRefundState(state) {
  return [
    "refund_intake",
    "awaiting_auth",
    "awaiting_order",
    "lookup_failed",
    "selecting_order",
  ].includes(String(state?.stage || ""));
}

function readRefundMemory(historyRows) {
  let state = createDefaultRefundState();

  for (const row of historyRows || []) {
    const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const refund = metadata.refund && typeof metadata.refund === "object" ? metadata.refund : {};
    if (!Object.keys(refund).length) continue;

    state = sanitizeRefundState({
      ...state,
      ...refund,
      intent: state.intent || refund.intent === true,
      orderCandidates:
        Array.isArray(refund.orderCandidates) && refund.orderCandidates.length
          ? refund.orderCandidates
          : refund.orderNumber
            ? [refund.orderNumber]
            : state.orderCandidates,
      failedOrderCandidates:
        Array.isArray(refund.failedOrderCandidates) && refund.failedOrderCandidates.length
          ? refund.failedOrderCandidates
          : state.failedOrderCandidates,
      lastActionAt: refund.lastActionAt || row.created_at || state.lastActionAt,
    });
  }

  const lastActionMs = parseTimestampMs(state.lastActionAt);
  if (
    lastActionMs > 0 &&
    Date.now() - lastActionMs > REFUND_CONTEXT_TTL_MS &&
    !["manual_review", "completed"].includes(String(state.stage || ""))
  ) {
    return createDefaultRefundState();
  }

  if (state.stage === "cancelled") {
    return createDefaultRefundState();
  }

  return state;
}

function buildRefundMemoryPatch(content, historyRows) {
  const previousState = readRefundMemory(historyRows);
  const currentIntent = isRefundOrOrderIntent(content);
  const cancelIntent = isCancelRefundIntent(content);
  const active = isActiveRefundState(previousState);
  const orderCandidates = extractOrderCandidates(content, {
    allowShortGeneric: active && !cancelIntent,
  });
  const email = extractEmail(content);

  if (cancelIntent && active) {
    return sanitizeRefundState({
      ...previousState,
      intent: false,
      stage: "cancelled",
      lastActionAt: nowIso(),
      currentIntent,
      cancelIntent: true,
      orderCandidates: previousState.orderCandidates,
    });
  }

  const intent = previousState.intent || currentIntent || (active && orderCandidates.length > 0);
  const nextOrderCandidates = intent && orderCandidates.length
    ? [...new Set([...orderCandidates, ...previousState.orderCandidates])].slice(0, 8)
    : previousState.orderCandidates;

  return sanitizeRefundState({
    ...previousState,
    intent,
    stage: previousState.stage || (intent ? "refund_intake" : null),
    orderCandidates: nextOrderCandidates,
    orderNumber: nextOrderCandidates[0] || null,
    currentIntent,
    cancelIntent: false,
    justProvidedEmail: Boolean(email && !orderCandidates.length),
    chatEmailProvided: Boolean(email),
    lastActionAt: nowIso(),
  });
}

function formatMoney(value, currency = "BRL") {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: currency || "BRL",
    }).format(Number(value || 0));
  } catch {
    return `R$ ${Number(value || 0).toFixed(2).replace(".", ",")}`;
  }
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Data indisponivel";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function resolveProductTitle(items) {
  const titles = (items || [])
    .map((item) => {
      const snapshot =
        item?.product_snapshot && typeof item.product_snapshot === "object"
          ? item.product_snapshot
          : {};
      return normalizeText(snapshot.title || snapshot.name || "Produto", 80);
    })
    .filter(Boolean);
  if (!titles.length) return "Produto";
  if (titles.length === 1) return titles[0];
  return `${titles[0]} +${titles.length - 1}`;
}

function resolvePurchaseDate(order) {
  return order.purchaseDate || order.paid_at || order.created_at || order.updated_at || null;
}

function encodeOrderKey(source, id) {
  return `${source === "payment" ? "p" : "s"}_${String(id || "").replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function decodeOrderKey(value) {
  const normalized = String(value || "").trim();
  const match = normalized.match(/^([sp])_([a-zA-Z0-9_-]{1,80})$/);
  if (!match) return null;
  return {
    source: match[1] === "p" ? "payment" : "sales",
    id: match[2],
  };
}

function buildOrderTokens(order) {
  const raw = order.raw || {};
  return [
    order.id,
    order.key,
    raw.order_number,
    raw.order_public_id,
    raw.cart_public_id,
    raw.provider_payment_id,
    raw.provider_external_reference,
    raw.checkout_token_hash,
    raw.plan_code,
    raw.id,
  ]
    .map((value) => normalizeLookupToken(value))
    .filter(Boolean);
}

function scoreOrderMatch(order, candidates) {
  const tokens = buildOrderTokens(order);
  let best = 0;
  for (const candidate of candidates || []) {
    const normalizedCandidate = normalizeLookupToken(candidate);
    const candidateDigits = normalizeDigits(normalizedCandidate);
    if (!normalizedCandidate) continue;

    for (const token of tokens) {
      const tokenDigits = normalizeDigits(token);
      if (token === normalizedCandidate) best = Math.max(best, 100);
      if (candidateDigits && tokenDigits && tokenDigits === candidateDigits) best = Math.max(best, 96);
      if (normalizedCandidate.length >= 4 && token.endsWith(normalizedCandidate)) {
        best = Math.max(best, 82);
      }
      if (candidateDigits.length >= 4 && tokenDigits.endsWith(candidateDigits)) {
        best = Math.max(best, 84);
      }
      if (normalizedCandidate.length >= 2 && token.endsWith(normalizedCandidate)) {
        best = Math.max(best, 58);
      }
      if (candidateDigits.length >= 2 && tokenDigits.endsWith(candidateDigits)) {
        best = Math.max(best, 60);
      }
      if (normalizedCandidate.length >= 4 && token.includes(normalizedCandidate)) {
        best = Math.max(best, 48);
      }
    }
  }
  return best;
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} excedeu o tempo limite.`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function isMissingTableError(error, tableName) {
  const message = String(error?.message || "").toLowerCase();
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    message.includes(String(tableName || "").toLowerCase()) ||
    message.includes("schema cache")
  );
}

function createCorrelationId(prefix = "refund") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

function serializeDiscordError(error) {
  return {
    message: normalizeText(error?.message || String(error || "Erro desconhecido."), 500),
    code: error?.code || error?.rawError?.code || null,
    status: error?.status || null,
    method: error?.method || null,
    url: error?.url || null,
  };
}

async function acknowledgeComponent(interaction, correlationId) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferUpdate();
    return true;
  } catch (error) {
    console.warn("[ticket-refund] interaction ack failed", {
      correlationId,
      interactionId: interaction?.id || null,
      customId: interaction?.customId || null,
      error: serializeDiscordError(error),
    });
    return false;
  }
}

async function updateComponentMessage(interaction, payload, correlationId) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.update(payload);
    }
    return { ok: true };
  } catch (error) {
    console.warn("[ticket-refund] discord message update failed", {
      correlationId,
      interactionId: interaction?.id || null,
      customId: interaction?.customId || null,
      error: serializeDiscordError(error),
    });
    return { ok: false, error };
  }
}

async function sendInteractionNotice(interaction, payload, correlationId) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
    return { ok: true };
  } catch (error) {
    console.warn("[ticket-refund] interaction notice failed", {
      correlationId,
      interactionId: interaction?.id || null,
      customId: interaction?.customId || null,
      error: serializeDiscordError(error),
    });
    return { ok: false, error };
  }
}

async function logRefundAuditEvent(input) {
  const metadata = {
    ...(input.metadata || {}),
    correlation_id: input.correlationId || input.metadata?.correlation_id || createCorrelationId("audit"),
  };
  const payload = {
    ticket_id: input.ticket?.id || null,
    guild_id: input.ticket?.guild_id || input.guildId || null,
    channel_id: input.ticket?.channel_id || null,
    discord_user_id: input.ticket?.user_id || input.discordUserId || null,
    auth_user_id: input.authUserId || null,
    event_type: input.eventType,
    outcome: input.outcome || "recorded",
    order_key: input.orderKey || null,
    risk_score: Number.isFinite(Number(input.riskScore)) ? Number(input.riskScore) : null,
    metadata,
  };

  try {
    const result = await supabase.from("ticket_refund_audit_events").insert(payload);
    if (result.error && !isMissingTableError(result.error, "ticket_refund_audit_events")) {
      console.warn("[ticket-refund] falha ao registrar auditoria:", result.error.message);
      return { ok: false, error: result.error };
    }
    return { ok: true };
  } catch (error) {
    console.warn("[ticket-refund] excecao ao registrar auditoria:", error?.message || error);
    return { ok: false, error };
  }
}

async function fetchRecentAiMessages(ticketId) {
  const result = await supabase
    .from("ticket_ai_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(30);
  return result.error ? [] : (result.data || []).reverse();
}

async function persistRefundStateDirectly(ticket, state, extra = {}) {
  const baseState = state && typeof state === "object" ? state : {};
  const safeState = sanitizeRefundState({
    ...baseState,
    ...extra,
    lastActionAt: extra.lastActionAt || baseState.lastActionAt || nowIso(),
  });

  try {
    const result = await supabase.from("ticket_ai_messages").insert({
      ticket_id: ticket.id,
      protocol: ticket.protocol,
      guild_id: ticket.guild_id,
      channel_id: ticket.channel_id,
      author_id: null,
      author_type: "system",
      source: "ticket_refund_state",
      content: `refund-state:${safeState.stage || "idle"}`,
      metadata: {
        refund: safeState,
      },
    });

    if (result.error) {
      console.warn("[ticket-refund] falha ao persistir estado diretamente:", result.error.message);
      return { ok: false, error: result.error };
    }

    return { ok: true, state: safeState };
  } catch (error) {
    console.warn("[ticket-refund] excecao ao persistir estado diretamente:", error?.message || error);
    return { ok: false, error };
  }
}

function coercePersistedBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function coerceRefundLimitDays(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(365, Math.max(0, parsed));
}

function normalizeDiscordSnowflake(value) {
  const normalized = String(value || "").trim();
  return /^[0-9]{10,25}$/.test(normalized) ? normalized : null;
}

async function getTicketRefundSettings(guildId, runtime) {
  const defaultSettings = {
    enabled: true,
    refundLimitDays: DEFAULT_REFUND_DAYS,
    rules: "",
    autoProcessEnabled: false,
    manualApprovalRequired: true,
    approvalChannelId: null,
    approverRoleIds: [],
    successMessage:
      "Reembolso concluido. O prazo de estorno ou compensacao depende do provedor de pagamento e do banco emissor.",
    errorMessage:
      "Nao consegui concluir o reembolso automaticamente. Encaminhei o caso para a equipe responsavel analisar.",
    source: "schema_defaults",
    loadedAt: nowIso(),
    persisted: false,
    updatedAt: null,
    modeConflict: false,
  };

  const result = await supabase
    .from("guild_ticket_refund_settings")
    .select(
      "guild_id, enabled, refund_limit_days, refund_rules, auto_process_enabled, manual_approval_required, approval_channel_id, approver_role_ids, success_message, error_message, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  if (result.error) {
    if (isMissingTableError(result.error, "guild_ticket_refund_settings")) {
      return {
        ...defaultSettings,
        source: "missing_guild_ticket_refund_settings_table",
      };
    }
    console.warn("[ticket-refund] falha ao ler configuracao:", result.error.message);
    return {
      ...defaultSettings,
      source: "read_error",
      readError: result.error.message,
    };
  }

  if (!result.data) {
    return {
      ...defaultSettings,
      source: "missing_guild_ticket_refund_settings_row",
    };
  }

  const row = result.data;
  const enabled = coercePersistedBoolean(row.enabled, true);
  const autoProcessEnabled = coercePersistedBoolean(row.auto_process_enabled, false);
  const manualApprovalRequired = coercePersistedBoolean(row.manual_approval_required, true);
  const modeConflict =
    (autoProcessEnabled && manualApprovalRequired) ||
    (!autoProcessEnabled && !manualApprovalRequired);

  return {
    enabled,
    refundLimitDays: coerceRefundLimitDays(row.refund_limit_days, defaultSettings.refundLimitDays),
    rules: normalizeText(row.refund_rules || "", 1200),
    autoProcessEnabled,
    manualApprovalRequired,
    approvalChannelId: normalizeDiscordSnowflake(row.approval_channel_id),
    approverRoleIds: Array.isArray(row.approver_role_ids)
      ? [...new Set(row.approver_role_ids.map(normalizeDiscordSnowflake).filter(Boolean))]
      : [],
    successMessage: normalizeText(row.success_message || "", 500) || defaultSettings.successMessage,
    errorMessage: normalizeText(row.error_message || "", 500) || defaultSettings.errorMessage,
    source: "guild_ticket_refund_settings",
    loadedAt: nowIso(),
    persisted: true,
    updatedAt: parseTimestampMs(row.updated_at) ? row.updated_at : null,
    modeConflict,
    conservativeManualMode: modeConflict ? true : manualApprovalRequired,
  };
}

async function persistRefundState(persist, state, extra = {}) {
  if (typeof persist !== "function") return;
  const safeState = sanitizeRefundState({
    ...state,
    ...extra,
    lastActionAt: extra.lastActionAt || state.lastActionAt || nowIso(),
  });
  await persist({
    authorId: null,
    authorType: "system",
    source: "ticket_refund_state",
    content: `refund-state:${safeState.stage || "idle"}`,
    metadata: {
      refund: safeState,
    },
  }).catch((error) => {
    console.warn("[ticket-refund] falha ao persistir estado:", error.message);
  });
}

function shouldPrompt(state, kind, cooldownMs = REFUND_PROMPT_COOLDOWN_MS) {
  if (state.lastPromptKind !== kind) return true;
  const lastPromptMs = parseTimestampMs(state.lastPromptAt);
  return !lastPromptMs || Date.now() - lastPromptMs >= cooldownMs;
}

function markPrompt(state, kind) {
  return sanitizeRefundState({
    ...state,
    lastPromptKind: kind,
    lastPromptAt: nowIso(),
    lastActionAt: nowIso(),
  });
}

async function getAuthUserByDiscordUserId(discordUserId) {
  const normalizedDiscordUserId = String(discordUserId || "").trim();
  if (!normalizedDiscordUserId) return null;
  const result = await supabase
    .from("auth_users")
    .select("id, email, discord_user_id, display_name, username")
    .eq("discord_user_id", normalizedDiscordUserId)
    .maybeSingle();
  if (result.error) {
    console.warn("[ticket-refund] falha ao consultar usuario vinculado:", result.error.message);
    return null;
  }
  return result.data || null;
}

async function createTicketRefundAuthLink(ticket) {
  const token = createSecureToken();
  const expiresAt = new Date(Date.now() + REFUND_LOGIN_LINK_TTL_MS).toISOString();
  const insert = await supabase
    .from("ticket_refund_auth_links")
    .insert({
      ticket_id: ticket.id,
      guild_id: ticket.guild_id,
      channel_id: ticket.channel_id,
      discord_user_id: ticket.user_id,
      token_hash: hashSecureToken(token),
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .maybeSingle();

  if (insert.error) {
    if (!isMissingTableError(insert.error, "ticket_refund_auth_links")) {
      console.warn("[ticket-refund] falha ao criar link de login:", insert.error.message);
    }
    return {
      linkId: null,
      url: buildAppUrl("/api/auth/discord"),
      expiresAt,
    };
  }

  return {
    linkId: insert.data?.id || null,
    url: buildAppUrl(`/support/discord-auth/${encodeURIComponent(token)}`),
    expiresAt,
  };
}

async function readTicketRefundAuthLink(linkId) {
  if (!linkId) return null;
  const result = await supabase
    .from("ticket_refund_auth_links")
    .select("id, ticket_id, guild_id, discord_user_id, status, auth_user_id, expires_at, confirmed_at")
    .eq("id", linkId)
    .maybeSingle();
  if (result.error) {
    if (!isMissingTableError(result.error, "ticket_refund_auth_links")) {
      console.warn("[ticket-refund] falha ao ler link de login:", result.error.message);
    }
    return null;
  }
  return result.data || null;
}

async function getAuthUserById(userId) {
  if (!Number.isFinite(Number(userId))) return null;
  const result = await supabase
    .from("auth_users")
    .select("id, email, discord_user_id, display_name, username")
    .eq("id", Number(userId))
    .maybeSingle();
  return result.error ? null : result.data || null;
}

function buildLoginPromptPayload(url, authUser, options = {}) {
  const requireConfirmation = options.requireConfirmation === true;
  if (authUser && requireConfirmation) {
    return v2Message([
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x8fdbff,
        components: [
          textDisplay(
            [
              "## Confirme sua conta segura",
              `Encontrei uma conta Flowdesk associada a este Discord${authUser.email ? ` (**${authUser.email}**)` : ""}, mas antes de consultar qualquer pedido preciso confirmar o acesso nesta sessao.`,
              "",
              "Clique em **Confirmar / Trocar Conta**. Depois da confirmacao, envie novamente o numero do pedido para eu consultar com seguranca.",
            ].join("\n"),
          ),
        ],
      },
      actionRow([linkButton({ label: "Confirmar / Trocar Conta", url })]),
    ]);
  }

  if (authUser) {
    return v2Message([
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x8fdbff,
        components: [
          textDisplay(
            [
              "## Conta ja vinculada",
              `Sua conta segura${authUser.discord_user_id ? ` <@${authUser.discord_user_id}>` : ""}${authUser.email ? ` (**${authUser.email}**)` : ""} ja esta vinculada. Se a compra foi feita nesta conta, **basta enviar o numero do pedido abaixo**.`,
              "",
              "Se voce precisa verificar a compra de **outra conta**, clique em **Login / Trocar Conta**.",
            ].join("\n"),
          ),
        ],
      },
      actionRow([linkButton({ label: "Login / Trocar Conta", url })]),
    ]);
  }

  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay(
          [
            "## Login seguro necessario",
            "Para verificar reembolso eu preciso confirmar que este Discord pertence a uma conta Flowdesk. Nao envie senha ou dados sensiveis no chat.",
            "",
            "Clique em **Login** para entrar ou vincular sua conta. Assim que a vinculacao terminar, eu atualizo esta mensagem e continuo por aqui pedindo apenas o numero do pedido.",
          ].join("\n"),
        ),
      ],
    },
    actionRow([linkButton({ label: "Login", url })]),
  ]);
}

function buildLoginConfirmedPayload() {
  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x2ecc71,
      components: [
        textDisplay(
          [
            "## Conta vinculada com sucesso",
            "A verificacao segura foi concluida. Pode voltar ao ticket; vou continuar usando a conta vinculada, sem pedir email ou senha no chat.",
          ].join("\n"),
        ),
      ],
    },
  ]);
}

async function startLoginPolling({ client, ticket, linkId, authMessage, persist, state }) {
  const key = `${ticket.id}:${linkId || ticket.user_id}`;
  if (activeLoginPollers.has(key)) return;

  const startedAt = Date.now();
  const interval = setInterval(async () => {
    try {
      if (Date.now() - startedAt > REFUND_LOGIN_POLL_MAX_MS) {
        clearInterval(interval);
        activeLoginPollers.delete(key);
        return;
      }

      const link = await readTicketRefundAuthLink(linkId);
      let authUser = null;

      // O login so e considerado confirmado se o link seguro gerado para esta sessao foi expressamente logado e confirmado!
      if (link?.status === "confirmed" && link.auth_user_id) {
        authUser = await getAuthUserById(link.auth_user_id);
      }

      if (!authUser) return;

      clearInterval(interval);
      activeLoginPollers.delete(key);

      await authMessage?.edit(buildLoginConfirmedPayload()).catch(() => null);
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      await channel?.send?.({
        content:
          "Conta vinculada com sucesso. Agora me envie o numero do pedido para eu consultar a compra com seguranca.",
        allowedMentions: { parse: [] },
      });
      await persistRefundState(persist, state, {
        stage: "awaiting_order",
        authStatus: "linked",
        authUserId: authUser.id,
        authConfirmedAt: nowIso(),
        lastPromptKind: "order_after_auth",
        lastPromptAt: nowIso(),
      });
      await logRefundAuditEvent({
        ticket,
        authUserId: authUser.id,
        eventType: "auth_link_confirmed",
        outcome: "success",
      });
    } catch (error) {
      console.warn("[ticket-refund] poll de login falhou:", error.message);
    }
  }, REFUND_LOGIN_POLL_MS);

  activeLoginPollers.set(key, interval);
}

async function sendSecureLoginPrompt({ message, client, ticket, persist, state, authUser, requireConfirmation = false }) {
  const link = await createTicketRefundAuthLink(ticket);
  const payload = buildLoginPromptPayload(link.url, authUser, { requireConfirmation });
  const sent = await message.channel.send(payload);
  const isAlreadyConfirmed = Boolean(authUser && !requireConfirmation);
  const nextState = markPrompt(
    {
      ...state,
      intent: true,
      stage: isAlreadyConfirmed ? "awaiting_order" : "awaiting_auth",
      authStatus: isAlreadyConfirmed ? "linked" : "pending",
      authUserId: authUser?.id || state.authUserId || null,
      authLinkId: link.linkId,
      loginMessageId: sent?.id || null,
    },
    authUser ? "confirm_account" : "login",
  );
  await persistRefundState(persist, nextState);
  await logRefundAuditEvent({
    ticket,
    eventType: "auth_link_created",
    outcome: link.linkId ? "success" : "fallback",
    metadata: { expiresAt: link.expiresAt },
  });
  await startLoginPolling({
    client,
    ticket,
    linkId: link.linkId,
    authMessage: sent,
    persist,
    state: nextState,
  });
}

async function fetchSalesCartItems(cartIds) {
  if (!cartIds.length) return new Map();
  const result = await supabase
    .from("guild_sales_cart_items")
    .select("id, cart_id, product_id, quantity, unit_price_amount, total_amount, product_snapshot")
    .in("cart_id", cartIds);

  const byCart = new Map();
  for (const item of result.error ? [] : result.data || []) {
    const current = byCart.get(item.cart_id) || [];
    current.push(item);
    byCart.set(item.cart_id, current);
  }
  return byCart;
}

async function fetchSalesDeliveries(cartIds) {
  if (!cartIds.length) return new Map();
  const result = await supabase
    .from("guild_sales_order_deliveries")
    .select("*")
    .in("cart_id", cartIds);

  const byCart = new Map();
  for (const delivery of result.error ? [] : result.data || []) {
    const current = byCart.get(delivery.cart_id) || [];
    current.push(delivery);
    byCart.set(delivery.cart_id, current);
  }
  return byCart;
}

async function fetchSalesEvents(cartIds) {
  if (!cartIds.length) return new Map();
  const result = await supabase
    .from("guild_sales_order_events")
    .select("*")
    .in("cart_id", cartIds)
    .order("created_at", { ascending: false });

  const byCart = new Map();
  for (const event of result.error ? [] : result.data || []) {
    const current = byCart.get(event.cart_id) || [];
    current.push(event);
    byCart.set(event.cart_id, current);
  }
  return byCart;
}

async function fetchPaymentEvents(orderIds) {
  if (!orderIds.length) return new Map();
  const result = await supabase
    .from("payment_order_events")
    .select("*")
    .in("payment_order_id", orderIds)
    .order("created_at", { ascending: false });

  const byOrder = new Map();
  for (const event of result.error ? [] : result.data || []) {
    const current = byOrder.get(event.payment_order_id) || [];
    current.push(event);
    byOrder.set(event.payment_order_id, current);
  }
  return byOrder;
}

async function fetchSalesOrdersForContext({ guildId, authUserId, discordUserId, limit = 80 }) {
  const cartRows = new Map();
  const normalizedGuildId = String(guildId || "").trim();

  if (authUserId) {
    const authCartResult = await supabase
      .from("guild_sales_carts")
      .select("*")
      .eq("guild_id", normalizedGuildId)
      .eq("auth_user_id", authUserId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!authCartResult.error) {
      for (const cart of authCartResult.data || []) cartRows.set(cart.id, cart);
    } else if (!isMissingTableError(authCartResult.error, "guild_sales_carts")) {
      console.warn("[ticket-refund] falha ao consultar vendas por usuario:", authCartResult.error.message);
    }
  }

  if (discordUserId) {
    const discordCartResult = await supabase
      .from("guild_sales_carts")
      .select("*")
      .eq("guild_id", normalizedGuildId)
      .eq("discord_user_id", discordUserId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (!discordCartResult.error) {
      for (const cart of discordCartResult.data || []) cartRows.set(cart.id, cart);
    } else if (!isMissingTableError(discordCartResult.error, "guild_sales_carts")) {
      console.warn("[ticket-refund] falha ao consultar vendas por Discord:", discordCartResult.error.message);
    }
  }

  const carts = Array.from(cartRows.values());
  const cartIds = carts.map((cart) => cart.id);
  const [itemsByCart, deliveriesByCart, eventsByCart] = await Promise.all([
    fetchSalesCartItems(cartIds),
    fetchSalesDeliveries(cartIds),
    fetchSalesEvents(cartIds),
  ]);

  return carts.map((cart) =>
    toUnifiedSalesOrder(
      cart,
      itemsByCart.get(cart.id) || [],
      deliveriesByCart.get(cart.id) || [],
      eventsByCart.get(cart.id) || [],
    ),
  );
}

async function fetchGlobalSalesOrdersForGuild({ guildId, limit = 250 }) {
  const cartResult = await supabase
    .from("guild_sales_carts")
    .select("*")
    .eq("guild_id", guildId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cartResult.error) {
    if (!isMissingTableError(cartResult.error, "guild_sales_carts")) {
      console.warn("[ticket-refund] falha ao consultar pedidos globais da loja:", cartResult.error.message);
    }
    return [];
  }

  const carts = cartResult.data || [];
  const cartIds = carts.map((cart) => cart.id);
  const [itemsByCart, deliveriesByCart, eventsByCart] = await Promise.all([
    fetchSalesCartItems(cartIds),
    fetchSalesDeliveries(cartIds),
    fetchSalesEvents(cartIds),
  ]);

  return carts.map((cart) =>
    toUnifiedSalesOrder(
      cart,
      itemsByCart.get(cart.id) || [],
      deliveriesByCart.get(cart.id) || [],
      eventsByCart.get(cart.id) || [],
    ),
  );
}

async function fetchActiveAccountViolations(authUserId) {
  if (!Number.isFinite(Number(authUserId))) return [];
  const result = await supabase
    .from("account_violations")
    .select("id, type, category_id, reason, expires_at, updated_at")
    .eq("user_id", Number(authUserId))
    .order("updated_at", { ascending: false })
    .limit(20);
  if (result.error) {
    if (!isMissingTableError(result.error, "account_violations")) {
      console.warn("[ticket-refund] falha ao ler violacoes da conta:", result.error.message);
    }
    return [];
  }
  const now = Date.now();
  return (result.data || []).filter((violation) => {
    const expiresAt = Date.parse(String(violation.expires_at || ""));
    return !Number.isFinite(expiresAt) || expiresAt > now;
  });
}

function toUnifiedSalesOrder(cart, items = [], deliveries = [], events = []) {
  const productTitle = resolveProductTitle(items);
  return {
    source: "sales",
    id: cart.id,
    key: encodeOrderKey("sales", cart.id),
    productTitle,
    amount: Number(cart.total_amount || 0),
    currency: cart.currency || "BRL",
    status: cart.status,
    provider: cart.provider || "mercado_pago",
    providerPaymentId: cart.provider_payment_id || null,
    providerStatus: cart.provider_status || null,
    providerStatusDetail: cart.provider_status_detail || null,
    purchaseDate: cart.paid_at || cart.created_at || cart.updated_at || null,
    authUserId: Number.isFinite(Number(cart.auth_user_id)) ? Number(cart.auth_user_id) : null,
    discordUserId: cart.discord_user_id || null,
    items,
    deliveries,
    events,
    raw: cart,
  };
}

function toUnifiedPaymentOrder(order, events = []) {
  const productTitle =
    normalizeText(order.plan_name || "", 90) ||
    normalizeText(order.plan_code || "", 90) ||
    `Pedido #${order.order_number || order.id}`;
  return {
    source: "payment",
    id: order.id,
    key: encodeOrderKey("payment", order.id),
    productTitle,
    amount: Number(order.amount || 0),
    currency: order.currency || "BRL",
    status: order.status,
    provider: order.provider || "mercado_pago",
    providerPaymentId: order.provider_payment_id || null,
    providerStatus: order.provider_status || null,
    providerStatusDetail: order.provider_status_detail || null,
    purchaseDate: order.paid_at || order.created_at || order.updated_at || null,
    authUserId: Number.isFinite(Number(order.user_id)) ? Number(order.user_id) : null,
    discordUserId: null,
    items: [],
    deliveries: [],
    events,
    raw: order,
  };
}

async function findMatchingOrders({ guildId, authUserId, discordUserId, orderCandidates }) {
  if (isOfficialSupportGuild(guildId)) {
    if (!authUserId && !discordUserId) return [];

    const [paymentOrders, salesOrders] = await Promise.all([
      authUserId
        ? supabase
            .from("payment_orders")
            .select("*")
            .eq("user_id", authUserId)
            .order("created_at", { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [], error: null }),
      fetchSalesOrdersForContext({
        guildId,
        authUserId,
        discordUserId,
        limit: 120,
      }),
    ]);

    if (paymentOrders.error) {
      console.warn("[ticket-refund] falha ao consultar historico de pagamentos:", paymentOrders.error.message);
    }

    const paymentRows = paymentOrders.data || [];
    const eventsByOrder = await fetchPaymentEvents(paymentRows.map((order) => order.id));
    const officialOrders = [
      ...paymentRows.map((order) => toUnifiedPaymentOrder(order, eventsByOrder.get(order.id) || [])),
      ...salesOrders,
    ];

    return officialOrders
      .map((order) => ({
        ...order,
        matchScore: scoreOrderMatch(order, orderCandidates),
      }))
      .filter((order) => order.matchScore > 0)
      .sort((left, right) => {
        if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
        return parseTimestampMs(resolvePurchaseDate(right)) - parseTimestampMs(resolvePurchaseDate(left));
      })
      .slice(0, 10);
  }

  const salesOrders = await fetchSalesOrdersForContext({
    guildId,
    authUserId,
    discordUserId,
    limit: 80,
  });

  return [...salesOrders]
    .map((order) => ({
      ...order,
      matchScore: scoreOrderMatch(order, orderCandidates),
    }))
    .filter((order) => order.matchScore > 0)
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
      return parseTimestampMs(resolvePurchaseDate(right)) - parseTimestampMs(resolvePurchaseDate(left));
    })
    .slice(0, 10);
}

async function findAnyMatchingSalesOrders({ guildId, orderCandidates }) {
  if (isOfficialSupportGuild(guildId)) {
    const [orderResult, salesOrders] = await Promise.all([
      supabase
        .from("payment_orders")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500),
      fetchGlobalSalesOrdersForGuild({ guildId, limit: 300 }),
    ]);

    if (orderResult.error) {
      console.warn("[ticket-refund] falha ao consultar historico global de pagamentos:", orderResult.error.message);
    }

    const paymentOrders = orderResult.data || [];
    const eventsByOrder = await fetchPaymentEvents(paymentOrders.map((order) => order.id));
    return [
      ...paymentOrders.map((order) => toUnifiedPaymentOrder(order, eventsByOrder.get(order.id) || [])),
      ...salesOrders,
    ]
      .map((order) => ({
        ...order,
        matchScore: scoreOrderMatch(order, orderCandidates),
      }))
      .filter((order) => order.matchScore >= 48)
      .sort((left, right) => right.matchScore - left.matchScore)
      .slice(0, 3);
  }

  return (await fetchGlobalSalesOrdersForGuild({ guildId, limit: 200 }))
    .map((order) => ({
      ...order,
      matchScore: scoreOrderMatch(order, orderCandidates),
    }))
    .filter((order) => order.matchScore >= 48)
    .sort((left, right) => right.matchScore - left.matchScore)
    .slice(0, 3);
}

function resolveOrderPublicId(order) {
  return (
    order.raw?.order_number ||
    order.raw?.order_public_id ||
    order.raw?.cart_public_id ||
    String(order.id || "").slice(0, 8)
  );
}

function formatOrderSafeStatus(order) {
  const status = String(order.status || "").toLowerCase();
  const providerStatus = String(order.providerStatus || "").toLowerCase();
  if (isRefundTerminalStatus(status) || isRefundTerminalStatus(providerStatus)) return "Reembolsado";
  if (status === "paid" || status === "approved" || providerStatus === "approved") return "Pagamento confirmado";
  if (status === "delivered") return "Entregue";
  if (status === "pending") return "Pendente";
  if (status === "cancelled" || status === "canceled") return "Cancelado";
  if (status === "expired") return "Expirado";
  if (status === "rejected" || status === "failed") return "Nao aprovado";
  return order.status ? normalizeText(order.status, 60) : "Status indisponivel";
}

function isOrderOwnedByTicketContext(order, context = {}) {
  const orderAuthUserId = coerceNumberOrNull(order?.authUserId);
  const contextAuthUserId = coerceNumberOrNull(context.authUserId);
  if (orderAuthUserId) {
    return Boolean(contextAuthUserId) && Number(orderAuthUserId) === Number(contextAuthUserId);
  }
  return Boolean(context.discordUserId && order?.discordUserId === context.discordUserId);
}

async function listUserRecentOrders({ guildId, authUserId, discordUserId }) {
  if (isOfficialSupportGuild(guildId)) {
    if (!authUserId && !discordUserId) return [];

    const [orderResult, salesOrders] = await Promise.all([
      authUserId
        ? supabase
            .from("payment_orders")
            .select("*")
            .eq("user_id", authUserId)
            .order("created_at", { ascending: false })
            .limit(500)
        : Promise.resolve({ data: [], error: null }),
      fetchSalesOrdersForContext({
        guildId,
        authUserId,
        discordUserId,
        limit: 120,
      }),
    ]);

    if (orderResult.error) {
      console.warn("[ticket-refund] falha ao listar historico de pagamentos:", orderResult.error.message);
    }

    const paymentOrders = orderResult.data || [];
    const eventsByOrder = await fetchPaymentEvents(paymentOrders.map((order) => order.id));
    return [
      ...paymentOrders.map((order) =>
        toUnifiedPaymentOrder(order, eventsByOrder.get(order.id) || []),
      ),
      ...salesOrders,
    ].sort(
      (left, right) =>
        parseTimestampMs(resolvePurchaseDate(right)) - parseTimestampMs(resolvePurchaseDate(left)),
    );
  }

  return fetchSalesOrdersForContext({ guildId, authUserId, discordUserId, limit: 80 });
}

async function getOrderByKey(guildId, orderKey, options = {}) {
  const parsed = decodeOrderKey(orderKey);
  if (!parsed) return null;

  if (parsed.source === "payment") {
    if (!isOfficialSupportGuild(guildId)) return null;

    const orderResult = await supabase
      .from("payment_orders")
      .select("*")
      .eq("id", parsed.id)
      .maybeSingle();
    if (orderResult.error || !orderResult.data) return null;
    const order = orderResult.data;
    if (
      options.authUserId &&
      order.user_id &&
      Number(order.user_id) !== Number(options.authUserId)
    ) {
      return null;
    }
    const eventsByOrder = await fetchPaymentEvents([order.id]);
    return toUnifiedPaymentOrder(order, eventsByOrder.get(order.id) || []);
  }

  if (parsed.source === "sales") {
    const cartResult = await supabase
      .from("guild_sales_carts")
      .select("*")
      .eq("guild_id", guildId)
      .eq("id", parsed.id)
      .maybeSingle();
    if (cartResult.error || !cartResult.data) return null;
    const cart = cartResult.data;
    if (
      options.authUserId &&
      cart.auth_user_id &&
      Number(cart.auth_user_id) !== Number(options.authUserId)
    ) {
      return null;
    }
    if (options.discordUserId && cart.discord_user_id !== options.discordUserId && !cart.auth_user_id) {
      return null;
    }
    const [itemsByCart, deliveriesByCart, eventsByCart] = await Promise.all([
      fetchSalesCartItems([cart.id]),
      fetchSalesDeliveries([cart.id]),
      fetchSalesEvents([cart.id]),
    ]);
    return toUnifiedSalesOrder(
      cart,
      itemsByCart.get(cart.id) || [],
      deliveriesByCart.get(cart.id) || [],
      eventsByCart.get(cart.id) || [],
    );
  }

  return null;
}

function countRefundEvents(events) {
  return (events || []).filter((event) => {
    const type = String(event.event_type || "").toLowerCase();
    const payload = JSON.stringify(event.event_payload || {}).toLowerCase();
    return type.includes("refund") || payload.includes("refund") || payload.includes("reembols");
  }).length;
}

function isRefundTerminalStatus(value) {
  return ["refunded", "partially_refunded", "charged_back", "chargeback"].includes(
    String(value || "").toLowerCase(),
  );
}

function evaluateRefundEligibility(order, settings, context = {}) {
  const purchaseDate = resolvePurchaseDate(order);
  const purchaseMs = purchaseDate ? Date.parse(purchaseDate) : Number.NaN;
  const refundDays = Math.max(0, Number(settings.refundLimitDays || DEFAULT_REFUND_DAYS));

  let insideWindow = false;
  let deadlineMs = Number.NaN;

  if (Number.isFinite(purchaseMs)) {
    deadlineMs = purchaseMs + refundDays * 24 * 60 * 60 * 1000;
    insideWindow = Date.now() <= deadlineMs;
  }
  const status = String(order.status || "").toLowerCase();
  const providerStatus = String(order.providerStatus || "").toLowerCase();
  const providerDetail = String(order.providerStatusDetail || "").toLowerCase();
  const alreadyRefunded =
    isRefundTerminalStatus(status) ||
    isRefundTerminalStatus(providerStatus) ||
    providerDetail.includes("refund") ||
    providerDetail.includes("chargeback") ||
    providerDetail.includes("reembols");
  const isSalesOrder = order.source === "sales";
  const isPaymentOrder = order.source === "payment";
  const paid =
    order.source === "sales"
      ? ["paid", "delivered", "delivery_failed"].includes(status)
      : ["approved", "settled"].includes(status) ||
        providerStatus === "approved" ||
        providerDetail === "accredited";
  const hasProviderPayment = Boolean(order.providerPaymentId);
  const ownershipOk =
    context.authUserId && order.authUserId
      ? Number(context.authUserId) === Number(order.authUserId)
      : isSalesOrder && context.discordUserId && order.discordUserId === context.discordUserId;
  const deliveredOrConsumed =
    isSalesOrder &&
    (order.deliveries?.length > 0 || ["delivered", "delivery_failed"].includes(status));
  const previousRefundEvents = countRefundEvents(order.events);
  const discountSnapshot = order.raw?.discount_snapshot || order.raw?.provider_payload?.discount || null;
  const discountAmount = Number(order.raw?.discount_amount || discountSnapshot?.amount || 0);
  const suspiciousInput = context.suspiciousInput === true;
  const repeatedLookups = Number(context.lookupCount || 0) >= 3;
  const accountViolations = Array.isArray(context.accountViolations)
    ? context.accountViolations
    : [];
  const financialViolation = accountViolations.some((violation) => {
    const type = normalizeIntentText(`${violation.type || ""} ${violation.category_id || ""}`);
    return (
      type.includes("fraude") ||
      type.includes("estorno") ||
      type.includes("contestacao") ||
      type.includes("pagamento") ||
      type.includes("blacklist") ||
      type.includes("burla")
    );
  });

  const reasons = [];
  if (!ownershipOk) reasons.push("ownership_mismatch");
  if (!paid) reasons.push("not_paid_status");
  if (!hasProviderPayment) reasons.push("missing_provider_payment");
  if (!insideWindow) reasons.push("outside_refund_window");
  if (alreadyRefunded) reasons.push("already_refunded");
  if (deliveredOrConsumed) reasons.push("delivered_or_consumed");
  if (previousRefundEvents > 0) reasons.push("previous_refund_events");
  if (discountAmount > 0) reasons.push("discount_used");
  if (suspiciousInput) reasons.push("manipulation_attempt");
  if (repeatedLookups) reasons.push("repeated_lookup_attempts");
  if (accountViolations.length > 0) reasons.push("active_account_violations");
  if (financialViolation) reasons.push("financial_risk_violation");
  if (!isSalesOrder && !isPaymentOrder) reasons.push("unsupported_order_source");

  let riskScore = 0;
  if (!ownershipOk) riskScore += 45;
  if (!paid || !hasProviderPayment) riskScore += 30;
  if (!insideWindow) riskScore += 25;
  if (alreadyRefunded) riskScore += 45;
  if (deliveredOrConsumed) riskScore += 20;
  if (previousRefundEvents > 0) riskScore += 25;
  if (discountAmount > 0) riskScore += 8;
  if (suspiciousInput) riskScore += 35;
  if (repeatedLookups) riskScore += 12;
  if (accountViolations.length > 0) riskScore += 20;
  if (financialViolation) riskScore += 35;
  if (!isSalesOrder && !isPaymentOrder) riskScore += 20;
  riskScore = Math.min(100, riskScore);

  const validationsComplete =
    Boolean(context.authUserId) &&
    ownershipOk &&
    Boolean(purchaseDate) &&
    Boolean(order.status) &&
    hasProviderPayment;

  const financiallyRefundable =
    validationsComplete &&
    paid &&
    hasProviderPayment &&
    !alreadyRefunded &&
    previousRefundEvents === 0 &&
    (isSalesOrder || isPaymentOrder);

  const eligible = financiallyRefundable && insideWindow;
  const persistedManualRequired = settings.manualApprovalRequired === true;
  const persistedAutoEnabled = settings.autoProcessEnabled === true;
  const configurationAllowsAutomatic =
    settings.enabled !== false &&
    persistedAutoEnabled &&
    !persistedManualRequired &&
    settings.modeConflict !== true;
  const canAutoRefund =
    financiallyRefundable &&
    insideWindow &&
    configurationAllowsAutomatic;

  const manualRequired =
    !canAutoRefund &&
    financiallyRefundable &&
    (persistedManualRequired || !insideWindow || settings.modeConflict === true || !persistedAutoEnabled);

  return {
    eligible,
    financiallyRefundable,
    configurationAllowsAutomatic,
    canAutoRefund,
    manualRequired,
    paid,
    hasProviderPayment,
    alreadyRefunded,
    insideWindow,
    refundDays,
    deadline: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
    ownershipOk,
    validationsComplete,
    deliveredOrConsumed,
    previousRefundEvents,
    riskScore,
    reasons,
  };
}

function buildOrderSelectionMessage(ticket, orders) {
  const options = orders.slice(0, 10).map((order) => ({
    label: truncateText(order.productTitle || "Produto", 100),
    description: `${formatMoney(order.amount, order.currency)} | ${formatDate(resolvePurchaseDate(order))}`.slice(0, 100),
    value: order.key,
  }));

  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay(
          [
            "Encontrei compra(s) compativeis na conta vinculada.",
            "Selecione qual compra voce quer verificar para reembolso. Se nenhuma for a correta, use **Cancelar**.",
          ].join("\n"),
        ),
      ],
    },
    actionRow([
      selectMenu({
        customId: `${REFUND_PREFIX}select:${ticket.id}`,
        placeholder: "Selecionar compra",
        options,
      }),
    ]),
    actionRow([
      button({
        customId: `${REFUND_PREFIX}cancel:${ticket.id}`,
        label: "Cancelar",
        style: ButtonStyle.Secondary,
      }),
    ]),
  ]);
}

function resolveRefundRoute(eligibility, settings) {
  if (!eligibility.financiallyRefundable) {
    return {
      route: "blocked",
      reason: eligibility.reasons[0] || "not_refundable",
    };
  }

  if (!eligibility.insideWindow) {
    return {
      route: "manual",
      reason: "outside_refund_window",
    };
  }

  if (settings.enabled === false) {
    return {
      route: "manual",
      reason: "refund_module_disabled",
    };
  }

  if (settings.modeConflict === true) {
    return {
      route: "manual",
      reason: "refund_settings_mode_conflict",
    };
  }

  if (settings.manualApprovalRequired === true) {
    return {
      route: "manual",
      reason: "manual_approval_required",
    };
  }

  if (settings.autoProcessEnabled === true) {
    return {
      route: "automatic",
      reason: "inside_window_auto_enabled",
    };
  }

  return {
    route: "manual",
    reason: "auto_process_disabled",
  };
}

function describeRefundRouteReason(reason) {
  switch (reason) {
    case "manual_approval_required":
      return "Aprovacao manual esta ativada no painel.";
    case "auto_process_disabled":
      return "Processamento automatico esta desativado no painel.";
    case "refund_settings_mode_conflict":
      return "As regras financeiras persistidas estao em modo conflitante; a rota conservadora e analise manual.";
    case "refund_module_disabled":
      return "O modulo de reembolso esta desativado no painel.";
    case "outside_refund_window":
      return "Pedido fora do prazo configurado pelo vendedor.";
    default:
      return "Analise manual exigida pelas regras financeiras.";
  }
}

function hasRefundApprovalPermission(member, settings, runtime) {
  if (!member) return false;
  if (canCloseTicket(member, runtime?.staffSettings) || canClaimTicket(member, runtime?.staffSettings)) {
    return true;
  }
  const roles = new Set(settings.approverRoleIds || []);
  return member.roles?.cache?.some((role) => roles.has(role.id)) || false;
}

async function callInternalSalesRefund(cartId, guildId, reason) {
  const endpoint =
    env.salesInternalRefundApiUrl ||
    `${String(env.appUrl || "").replace(/\/+$/, "")}/api/internal/sales/refund`;
  if (!endpoint || !env.salesInternalApiToken) {
    throw new Error("API interna de reembolso nao configurada.");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.salesInternalApiToken}`,
      "x-sales-internal-token": env.salesInternalApiToken,
    },
    body: JSON.stringify({ cartId, guildId, reason }),
    signal: AbortSignal.timeout?.(45_000),
  });
  const payload = await response.json().catch(() => null);
  if (payload?.financialRefunded === true || payload?.alreadyRefunded === true) {
    return {
      ...payload,
      ok: true,
      recoveredFromHttpError: !response.ok || payload?.ok === false,
    };
  }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.message || `Falha HTTP ${response.status} ao reembolsar.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function isInternalRefundPayloadContractError(payload) {
  const message = normalizeIntentText(
    `${payload?.message || ""} ${payload?.error || ""} ${Array.isArray(payload?.issues) ? payload.issues.join(" ") : ""}`,
  );
  return (
    message.includes("campo protocol nao permitido") ||
    message.includes("campo actoruserid nao permitido") ||
    message.includes("campo actorlabel nao permitido") ||
    message.includes("campo accessaction nao permitido") ||
    message.includes("campo riskscore nao permitido") ||
    message.includes("campo riskflags nao permitido") ||
    message.includes("nao permitido nesta requisicao")
  );
}

async function postInternalPaymentRefundRequest(endpoint, body, input = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.salesInternalApiToken}`,
      "x-flowdesk-internal-token": env.salesInternalApiToken,
      "x-payments-internal-token": env.salesInternalApiToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout?.(45_000),
  });
  const payload = await response.json().catch(() => null);

  if (payload?.financialRefunded === true || payload?.alreadyRefunded === true) {
    return {
      ...payload,
      ok: true,
      recoveredFromHttpError: !response.ok || payload?.ok === false,
      recoveredFromLegacyPayload: input.legacyPayload === true,
    };
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.message || `Falha HTTP ${response.status} ao reembolsar pagamento.`);
    error.status = response.status;
    error.payload = payload;
    error.legacyPayload = input.legacyPayload === true;
    throw error;
  }

  return {
    ...payload,
    recoveredFromLegacyPayload: input.legacyPayload === true,
  };
}

async function callInternalPaymentRefund(orderId, reason, context = {}) {
  const endpoint =
    env.paymentsInternalRefundApiUrl ||
    `${String(env.appUrl || "").replace(/\/+$/, "")}/api/internal/payments/refund`;
  if (!endpoint || !env.salesInternalApiToken) {
    throw new Error("API interna de reembolso de pagamentos nao configurada.");
  }

  const fullPayload = {
    orderId,
    reason,
    protocol: context.protocol || undefined,
    actorUserId: context.actorUserId || undefined,
    actorLabel: context.actorUserId ? `Discord ${context.actorUserId}` : undefined,
    accessAction: context.accessAction || "revoke_immediately",
    riskScore: Number.isFinite(Number(context.riskScore))
      ? Number(context.riskScore)
      : undefined,
    riskFlags: Array.isArray(context.riskFlags)
      ? context.riskFlags.slice(0, 20)
      : undefined,
  };

  try {
    return await postInternalPaymentRefundRequest(endpoint, fullPayload);
  } catch (error) {
    if (!isInternalRefundPayloadContractError(error.payload)) {
      throw error;
    }

    console.warn("[ticket-refund] endpoint de reembolso oficial rejeitou metadados novos; tentando payload legado", {
      orderId,
      rejectedMessage: normalizeText(error.payload?.message || error.message, 300),
    });

    return await postInternalPaymentRefundRequest(
      endpoint,
      {
        orderId,
        reason,
      },
      { legacyPayload: true },
    );
  }
}

function isProviderCommunicationUncertainty(error) {
  if (Number(error?.status || 0) >= 500) return true;
  const message = normalizeIntentText(
    `${error?.message || ""} ${error?.payload?.message || ""} ${error?.payload?.error || ""}`,
  );
  return includesAny(message, [
    "erro interno ao processar reembolso",
    "erro interno",
    "internal server error",
    "communication error",
    "communication_error",
    "timeout",
    "tempo limite",
    "falha de rede",
    "network",
    "econnreset",
    "etimedout",
    "socket hang up",
    "mercado pago",
  ]);
}

function isRefundedOrder(order) {
  const status = String(order?.status || "").toLowerCase();
  const providerStatus = String(order?.providerStatus || "").toLowerCase();
  const providerDetail = String(order?.providerStatusDetail || "").toLowerCase();
  return (
    isRefundTerminalStatus(status) ||
    isRefundTerminalStatus(providerStatus) ||
    providerDetail.includes("refund") ||
    providerDetail.includes("chargeback") ||
    providerDetail.includes("reembols") ||
    countRefundEvents(order?.events || []) > 0
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmRefundAfterUncertainError({ ticket, order, authUserId, error, attempts = 12 }) {
  if (!isProviderCommunicationUncertainty(error)) {
    return { confirmed: false, order: null, reason: "not_recoverable_error" };
  }

  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) await delay(Math.min(5000, 900 * index));
    const refreshedOrder = await getOrderByKey(ticket.guild_id, order.key, {
      authUserId,
      discordUserId: ticket.user_id,
    }).catch(() => null);
    if (isRefundedOrder(refreshedOrder)) {
      return {
        confirmed: true,
        order: refreshedOrder,
        reason: "post_error_reconciliation",
      };
    }
  }

  return { confirmed: false, order: null, reason: "not_confirmed_after_reconciliation" };
}

function summarizeEligibilityForStaff(eligibility) {
  const lines = [
    `Score de risco: ${eligibility.riskScore}/100`,
    `Titularidade: ${eligibility.ownershipOk ? "ok" : "divergente"}`,
    `Status pago: ${eligibility.paid ? "sim" : "nao"}`,
    `Prazo: ${eligibility.insideWindow ? "dentro" : "fora"} (${eligibility.refundDays} dia(s))`,
    `Pagamento externo: ${eligibility.hasProviderPayment ? "presente" : "ausente"}`,
    `Ja reembolsado: ${eligibility.alreadyRefunded ? "sim" : "nao"}`,
    `Produto entregue/usado: ${eligibility.deliveredOrConsumed ? "sim" : "nao"}`,
  ];
  if (eligibility.reasons.length) {
    lines.push(`Sinais internos: ${eligibility.reasons.join(", ")}`);
  }
  return lines.join("\n");
}

function buildRefundStaffReviewPayload({
  ticket,
  order,
  reason,
  eligibility,
  protocol,
  state = "pending",
  decidedBy = null,
  errorMessage = "",
}) {
  const stateConfig = {
    pending: {
      title: "Solicitacao de reembolso",
      tone: eligibility?.eligible ? "warning" : "error",
      status: "Aguardando analise manual",
      buttonsDisabled: false,
    },
    processing: {
      title: "Reembolso em processamento",
      tone: "processing",
      status: "Aguarde, estamos processando este reembolso...",
      buttonsDisabled: true,
    },
    approved: {
      title: "Reembolso aprovado",
      tone: "success",
      status: `Processado${decidedBy ? ` por <@${decidedBy}>` : ""}`,
      buttonsDisabled: true,
    },
    denied: {
      title: "Reembolso negado",
      tone: "error",
      status: `Negado${decidedBy ? ` por <@${decidedBy}>` : ""}`,
      buttonsDisabled: true,
    },
    failed: {
      title: "Falha ao processar reembolso",
      tone: "error",
      status: errorMessage || "A operacao nao foi concluida.",
      buttonsDisabled: true,
    },
    partial: {
      title: "Reembolso financeiro confirmado",
      tone: "warning",
      status: errorMessage || "O estorno foi confirmado, mas uma etapa posterior falhou.",
      buttonsDisabled: true,
    },
  };
  const config = stateConfig[state] || stateConfig.pending;
  const orderLine = `${order.productTitle}\n${formatMoney(order.amount, order.currency)} | ${formatDate(resolvePurchaseDate(order))}`;
  const details = [
    `**Status:** ${config.status}`,
    `**Protocolo:** \`${protocol}\``,
    `**Ticket:** ${ticket.protocol || ticket.id} | <#${ticket.channel_id}>`,
    `**Usuario:** <@${ticket.user_id}>`,
    `**Compra:** ${orderLine}`,
    `**Pedido:** \`${resolveOrderPublicId(order)}\``,
    `**Pagamento:** ${order.providerPaymentId ? `\`${order.providerPaymentId}\`` : "Nao informado"}`,
    "",
    "**Validacao**",
    summarizeEligibilityForStaff(eligibility),
    "",
    "**Motivo**",
    normalizeText(reason || "Solicitado pelo comprador no ticket.", 900),
  ].join("\n");

  const containerComponents = [textDisplay(details)];
  if (state === "pending" || state === "processing") {
    containerComponents.push(separator());
    containerComponents.push(
      actionRow([
        button({
          customId: `${REFUND_PREFIX}approve:${ticket.id}:${order.key}`,
          label: state === "processing" ? "Processando..." : "Aprovar Reembolso",
          style: ButtonStyle.Success,
          disabled: config.buttonsDisabled,
        }),
        button({
          customId: `${REFUND_PREFIX}deny:${ticket.id}:${order.key}`,
          label: "Negar Reembolso",
          style: ButtonStyle.Danger,
          disabled: config.buttonsDisabled,
        }),
      ]),
    );
  }

  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: resolveRefundToneColor(config.tone),
      components: containerComponents,
    },
  ]);
}

function buildRefundOrderInfoPayload(order) {
  return buildRefundV2Payload({
    title: "Informacoes do pedido",
    tone: "processing",
    message: [
      `**Pedido:** \`${resolveOrderPublicId(order)}\``,
      `**Status:** ${formatOrderSafeStatus(order)}`,
      `**Data da compra:** ${formatDate(resolvePurchaseDate(order))}`,
      `**Valor:** ${formatMoney(order.amount, order.currency)}`,
      `**Origem:** ${order.source === "sales" ? "Loja do servidor" : "Financeiro Flowdesk"}`,
      "",
      "Nao exibo email, dados internos, credenciais, dados de pagamento ou detalhes sensiveis do produto neste ticket.",
    ].join("\n"),
    footer: "Consulta feita apenas para o Discord vinculado a este ticket.",
  });
}

function buildRefundProcessingPayload({ protocol, order, mode }) {
  return buildRefundV2Payload({
    title: "Processando reembolso",
    tone: "processing",
    message: [
      "Aguarde, estamos processando este reembolso...",
      "",
      `**Protocolo:** \`${protocol}\``,
      order ? `**Compra:** ${order.productTitle}` : "",
      mode ? `**Modo:** ${mode}` : "",
    ].filter(Boolean).join("\n"),
    footer: "Os botoes ficam bloqueados enquanto o estorno financeiro e confirmado.",
  });
}

function buildRefundSuccessPayload({ settings, order, protocol, title = "Reembolso aprovado" }) {
  return buildRefundV2Payload({
    title,
    tone: "success",
    message: [
      settings.successMessage || "Reembolso concluido com sucesso.",
      "",
      `**Compra:** ${order.productTitle}`,
      `**Valor:** ${formatMoney(order.amount, order.currency)}`,
      `**Protocolo:** \`${protocol}\``,
      "",
      "O estorno segue o prazo do provedor de pagamento e do banco emissor.",
    ].join("\n"),
  });
}

function buildRefundFailurePayload({ protocol, order, message, title = "Falha no reembolso" }) {
  return buildRefundV2Payload({
    title,
    tone: "error",
    message: [
      normalizeText(message || "Nao foi possivel concluir esta etapa.", 900),
      "",
      protocol ? `**Protocolo:** \`${protocol}\`` : "",
      order ? `**Compra:** ${order.productTitle}` : "",
    ].filter(Boolean).join("\n"),
  });
}

function buildRefundManualQueuedPayload({ protocol, order, eligibility, reason }) {
  return buildRefundV2Payload({
    title: "Solicitacao enviada para analise",
    tone: "warning",
    message: [
      `A compra **${order.productTitle}** foi encaminhada para analise manual da equipe responsavel.`,
      "",
      `**Protocolo:** \`${protocol}\``,
      `**Prazo configurado:** ${eligibility.refundDays} dia(s)`,
      reason ? `**Motivo:** ${reason}` : "",
    ].filter(Boolean).join("\n"),
    footer: "Guarde o protocolo para acompanhar esta solicitacao.",
  });
}

function buildRefundExpiredConfirmationPayload({ ticket, order, eligibility }) {
  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: resolveRefundToneColor("warning"),
      components: [
        textDisplay(
          [
            "### Prazo de reembolso expirado",
            `Identifiquei que a compra **${order.productTitle}** foi realizada em **${formatDate(resolvePurchaseDate(order))}**.`,
            `O prazo configurado pelo vendedor e de **${eligibility.refundDays} dia(s)** e expirou em **${formatDate(eligibility.deadline)}**.`,
            "",
            "Se quiser prosseguir, a equipe fara uma analise manual excepcional.",
          ].join("\n"),
        ),
      ],
    },
    actionRow([
      button({
        customId: `${REFUND_PREFIX}confirm_expired:${ticket.id}:${order.key}`,
        label: "Enviar para analise",
        style: ButtonStyle.Danger,
      }),
      button({
        customId: `${REFUND_PREFIX}cancel_expired:${ticket.id}:${order.key}`,
        label: "Cancelar",
        style: ButtonStyle.Secondary,
      }),
    ]),
  ]);
}

function generateRefundProtocol(ticketId, orderKey) {
  const datePart = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ticketSuffix = String(ticketId || '').slice(-4).toUpperCase();
  return `RMB-${datePart}-${ticketSuffix}-${rand}`;
}

async function sendManualApprovalRequest({ client, ticket, order, settings, reason, eligibility, protocol }) {
  const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
  const channel = settings.approvalChannelId
    ? await guild?.channels.fetch(settings.approvalChannelId).catch(() => null)
    : null;
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Canal de aprovacao de reembolso nao configurado ou inacessivel.");
  }

  return await channel.send(
    buildRefundStaffReviewPayload({
      ticket,
      order,
      settings,
      reason,
      eligibility,
      protocol,
      state: "pending",
    }),
  );
}

async function enqueueRefundDirectMessage({ ticket, order, protocol, kind, content }) {
  const notificationKey = `ticket:${ticket.id}:refund:${kind}:${protocol}`;
  const payload =
    content && typeof content === "object"
      ? content
      : buildRefundV2Payload({
          title: kind === "denied" ? "Reembolso negado" : "Reembolso aprovado",
          tone: kind === "denied" ? "error" : "success",
          message: String(content || "").trim(),
        });
  try {
    const result = await supabase
      .from("ticket_dm_queue")
      .upsert(
        {
          notification_key: notificationKey,
          kind: kind === "denied" ? "ticket_refund_denied_dm" : "ticket_refund_processed_dm",
          ticket_id: ticket.id,
          protocol: ticket.protocol,
          guild_id: ticket.guild_id,
          user_id: ticket.user_id,
          payload,
          status: "pending",
          attempt_count: 0,
          max_attempts: 12,
          next_attempt_at: new Date().toISOString(),
          last_error: null,
          dm_channel_id: null,
          delivered_message_id: null,
          sent_at: null,
        },
        { onConflict: "notification_key" },
      )
      .select("id")
      .maybeSingle();

    if (result.error && !isMissingTableError(result.error, "ticket_dm_queue")) {
      console.warn("[ticket-refund] falha ao enfileirar DM de reembolso:", result.error.message);
      return { notificationKey, queued: false, error: result.error };
    }

    return {
      notificationKey,
      queued: !result.error,
    };
  } catch (error) {
    console.warn("[ticket-refund] excecao ao enfileirar DM de reembolso:", error?.message || error);
    return { notificationKey, queued: false, error };
  }
}

async function sendRefundTicketConfirmation({ client, interaction, ticket, content }) {
  const channel =
    (await client.channels.fetch(ticket.channel_id).catch(() => null)) ||
    interaction?.channel ||
    null;

  if (!channel || typeof channel.send !== "function") {
    return { ok: false, error: new Error("Canal do ticket indisponivel para confirmacao.") };
  }

  try {
    await channel.send(
      content && typeof content === "object"
        ? content
        : buildRefundV2Payload({
            title: "Reembolso aprovado",
            tone: "success",
            message: String(content || "").trim(),
          }),
    );
    return { ok: true };
  } catch (error) {
    console.warn("[ticket-refund] falha ao enviar confirmacao no ticket:", error?.message || error);
    return { ok: false, error };
  }
}

async function executeRefundProcessing({
  client,
  interaction = null,
  ticket,
  order,
  settings,
  protocol,
  actorUserId,
  authUserId = null,
  method,
  reason,
  eligibility,
  correlationId,
  updateMode = "request",
}) {
  let refundResult = null;
  let finalOrder = order;
  let recoveredFromUncertainError = false;

  await logRefundAuditEvent({
    ticket,
    authUserId,
    orderKey: order.key,
    riskScore: eligibility?.riskScore,
    eventType: "refund_processing_started",
    outcome: "started",
    correlationId,
    metadata: {
      protocol,
      method,
      actor_user_id: actorUserId || "system",
      reason: normalizeText(reason, 500),
      settings_source: settings?.source || null,
      settings_updated_at: settings?.updatedAt || null,
      settings_mode_conflict: settings?.modeConflict === true,
    },
  });

  try {
    refundResult =
      order.source === "payment"
        ? await callInternalPaymentRefund(order.id, reason, {
            protocol,
            actorUserId: actorUserId || "system",
            riskScore: eligibility?.riskScore,
            riskFlags: eligibility?.reasons,
            accessAction: "revoke_immediately",
          })
        : await callInternalSalesRefund(order.id, ticket.guild_id, reason);
  } catch (financialError) {
    const reconciliation = await confirmRefundAfterUncertainError({
      ticket,
      order,
      authUserId,
      error: financialError,
    });

    if (!reconciliation.confirmed) {
      const safeProviderError = normalizeText(financialError.message, 300);
      await logRefundAuditEvent({
        ticket,
        authUserId,
        orderKey: order.key,
        riskScore: eligibility?.riskScore,
        eventType: "refund_financial_failed",
        outcome: reconciliation.reason === "not_confirmed_after_reconciliation"
          ? "provider_result_uncertain"
          : "failed",
        correlationId,
        metadata: {
          protocol,
          method,
          actor_user_id: actorUserId || "system",
          provider_error: normalizeText(safeProviderError, 500),
          reconciliation_reason: reconciliation.reason,
        },
      });

      if (updateMode !== "staff") {
        const fallbackProtocol = protocol || generateRefundProtocol(ticket.id, order.key);
        const fallbackReason = [
          "O processamento automatico nao conseguiu confirmar o estorno financeiro.",
          safeProviderError ? `Erro seguro: ${safeProviderError}` : "",
          "Encaminhar para analise manual antes de qualquer nova tentativa.",
        ].filter(Boolean).join(" ");

        const manualRequest = await sendManualApprovalRequest({
          client,
          ticket,
          order,
          settings,
          reason: fallbackReason,
          eligibility,
          protocol: fallbackProtocol,
        }).catch(async (manualError) => {
          await logRefundAuditEvent({
            ticket,
            authUserId,
            orderKey: order.key,
            riskScore: eligibility?.riskScore,
            eventType: "manual_review_dispatch_failed",
            outcome: "approval_channel_unavailable_after_financial_failure",
            correlationId,
            metadata: {
              protocol: fallbackProtocol,
              provider_error: safeProviderError,
              approval_error: normalizeText(manualError.message, 500),
              approval_channel_id: settings?.approvalChannelId || null,
            },
          });
          return null;
        });

        if (manualRequest) {
          if (interaction) {
            await updateComponentMessage(interaction,
              buildRefundManualQueuedPayload({
                protocol: fallbackProtocol,
                order,
                eligibility,
                reason:
                  "Nao consegui confirmar o estorno automatico agora, entao encaminhei para a equipe revisar com seguranca.",
              }),
              correlationId,
            );
          }

          await persistRefundStateDirectly(ticket, {}, {
            stage: "manual_review",
            selectedOrderKey: order.key,
          });

          await logRefundAuditEvent({
            ticket,
            authUserId,
            orderKey: order.key,
            riskScore: eligibility?.riskScore,
            eventType: "manual_review_opened",
            outcome: "fallback_after_financial_failure",
            correlationId,
            metadata: {
              protocol: fallbackProtocol,
              provider_error: safeProviderError,
              reconciliation_reason: reconciliation.reason,
            },
          });

          return {
            ok: false,
            financialCompleted: false,
            manualQueued: true,
            error: financialError,
            reconciliation,
          };
        }
      }

      if (interaction) {
        const failurePayload =
          updateMode === "staff"
            ? buildRefundStaffReviewPayload({
                ticket,
                order,
                settings,
                reason,
                eligibility,
                protocol,
                state: "failed",
                decidedBy: actorUserId,
                errorMessage: `Nao consegui confirmar o estorno financeiro: ${normalizeText(financialError.message, 300)}`,
              })
            : buildRefundFailurePayload({
                protocol,
                order,
                message:
                  `Nao consegui confirmar o estorno financeiro agora (${safeProviderError || "erro do provedor"}). A analise manual tambem nao foi aberta automaticamente porque o canal de aprovacao esta ausente ou inacessivel. Chame a equipe neste ticket para revisar o caso.`,
              });
        await updateComponentMessage(interaction, failurePayload, correlationId);
      }

      await persistRefundStateDirectly(ticket, {}, {
        stage: "refund_failed",
        selectedOrderKey: order.key,
      });

      return {
        ok: false,
        financialCompleted: false,
        error: financialError,
        reconciliation,
      };
    }

    finalOrder = reconciliation.order || order;
    refundResult = {
      ok: true,
      alreadyRefunded: true,
      reconciledAfterError: true,
      reconciliationReason: reconciliation.reason,
    };
    recoveredFromUncertainError = true;
  }

  finalOrder =
    (await getOrderByKey(ticket.guild_id, order.key, {
      authUserId,
      discordUserId: ticket.user_id,
    }).catch(() => null)) ||
    finalOrder ||
    order;

  const successPayload = buildRefundSuccessPayload({
    settings,
    order: finalOrder,
    protocol,
    title: method === "automatic" ? "Reembolso processado automaticamente" : "Reembolso aprovado",
  });

  const postFailures = [];
  const postWarnings = [];
  if (refundResult?.persistenceCompleted === false) {
    postWarnings.push({
      step: "cart_persistence",
      error: normalizeText(refundResult.persistenceError || "Estorno confirmado, mas persistencia local incompleta.", 500),
    });
  }
  if (refundResult?.eventLogged === false) {
    postWarnings.push({
      step: "sales_order_event",
      error: normalizeText(refundResult.eventError || "Estorno confirmado, mas auditoria da venda nao foi gravada.", 500),
    });
  }

  const finalPayload =
    updateMode === "staff"
      ? buildRefundStaffReviewPayload({
          ticket,
          order: finalOrder,
          settings,
          reason,
          eligibility,
          protocol,
          state: "approved",
          decidedBy: actorUserId,
          errorMessage: "",
        })
      : successPayload;

  let finalUpdate = { ok: true };
  if (interaction) {
    finalUpdate = await updateComponentMessage(interaction, finalPayload, correlationId);
    if (!finalUpdate.ok) {
      postFailures.push({
        step: "discord_component_update",
        error: serializeDiscordError(finalUpdate.error),
      });
    }
  }

  const shouldSendTicketConfirmation =
    updateMode === "staff" || !interaction || finalUpdate.ok !== true;
  const ticketNotice = shouldSendTicketConfirmation
    ? await sendRefundTicketConfirmation({
        client,
        interaction,
        ticket,
        content: successPayload,
      })
    : { ok: true, skippedBecauseComponentWasUpdated: true };
  if (ticketNotice?.ok !== true) {
    postFailures.push({
      step: "ticket_notification",
      error: serializeDiscordError(ticketNotice?.error),
    });
  }

  const dmQueue = await enqueueRefundDirectMessage({
    ticket,
    order: finalOrder,
    protocol,
    kind: "processed",
    content: successPayload,
  });
  if (dmQueue.queued) {
    void processDirectMessageQueue(client, { notificationKey: dmQueue.notificationKey }).catch((error) => {
      console.warn("[ticket-refund] falha ao processar DM imediata de reembolso:", error?.message || error);
    });
  } else {
    postFailures.push({
      step: "dm_queue",
      error: normalizeText(dmQueue.error?.message || "Falha ao enfileirar DM.", 300),
    });
  }

  const emailNotice = await sendRefundProcessedEmail({
    discordUserId: ticket.user_id,
    authUserId: finalOrder.authUserId || authUserId,
    toEmail: finalOrder.raw?.customer_email || null,
    refundProtocol: protocol,
    productTitle: finalOrder.productTitle,
    amountLabel: formatMoney(finalOrder.amount, finalOrder.currency),
  });
  if (emailNotice?.sent !== true) {
    postFailures.push({
      step: "email_notification",
      error: normalizeText(emailNotice?.reason || emailNotice?.error?.message || "Email nao enviado.", 300),
    });
  }

  await persistRefundStateDirectly(ticket, {}, {
    stage: "completed",
    selectedOrderKey: order.key,
  });

  await logRefundAuditEvent({
    ticket,
    authUserId,
    orderKey: order.key,
    riskScore: eligibility?.riskScore,
    eventType: method === "automatic" ? "auto_refund_processed" : "manual_refund_approved",
    outcome: refundResult?.alreadyRefunded
      ? "already_refunded"
      : postFailures.length === 0 && postWarnings.length === 0
        ? "processed"
        : "processed_with_postprocess_warnings",
    correlationId,
    metadata: {
      protocol,
      method,
      actor_user_id: actorUserId || "system",
      decision_reason: normalizeText(reason, 500),
      transaction_id: finalOrder.providerPaymentId || order.providerPaymentId || null,
      final_status: refundResult?.alreadyRefunded ? "already_refunded" : "refunded",
      recovered_from_uncertain_provider_error: recoveredFromUncertainError,
      recovered_from_legacy_payment_refund_payload: refundResult?.recoveredFromLegacyPayload === true,
      discord_ticket_confirmation_sent: ticketNotice?.ok === true,
      discord_ticket_confirmation_skipped_duplicate:
        ticketNotice?.skippedBecauseComponentWasUpdated === true,
      dm_notification_queued: dmQueue.queued === true,
      email_confirmation_sent: emailNotice?.sent === true,
      discord_component_updated: finalUpdate.ok === true,
      post_failures: postFailures,
      post_warnings: postWarnings,
    },
  });

  return {
    ok: true,
    financialCompleted: true,
    refundResult,
    finalOrder,
    postFailures,
    postWarnings,
  };
}

async function routeSelectedRefundRequest({
  client,
  interaction,
  ticket,
  order,
  settings,
  authUser,
  eligibility,
  correlationId,
}) {
  const route = resolveRefundRoute(eligibility, settings);

  await logRefundAuditEvent({
    ticket,
    authUserId: authUser.id,
    orderKey: order.key,
    riskScore: eligibility.riskScore,
    eventType: "refund_route_resolved",
    outcome: route.route,
    correlationId,
    metadata: {
      route_reason: route.reason,
      inside_window: eligibility.insideWindow,
      refund_limit_days: eligibility.refundDays,
      auto_process_enabled: settings.autoProcessEnabled,
      manual_approval_required: settings.manualApprovalRequired,
      settings_source: settings.source,
      settings_updated_at: settings.updatedAt,
      settings_mode_conflict: settings.modeConflict === true,
    },
  });

  if (route.route === "blocked") {
    await updateComponentMessage(interaction,
      buildRefundFailurePayload({
        protocol: null,
        order,
        title: "Reembolso nao disponivel",
        message:
          "Esta compra nao possui os requisitos financeiros minimos para estorno pelo ticket. A equipe pode orientar os proximos passos por aqui.",
      }),
      correlationId,
    );
    return true;
  }

  if (route.route === "automatic") {
    const autoProtocol = generateRefundProtocol(ticket.id, order.key);
    await updateComponentMessage(interaction,
      buildRefundProcessingPayload({
        protocol: autoProtocol,
        order,
        mode: "Automatico pelas regras financeiras",
      }),
      correlationId,
    );

    await executeRefundProcessing({
      client,
      interaction,
      ticket,
      order,
      settings,
      protocol: autoProtocol,
      actorUserId: "system",
      authUserId: authUser.id,
      method: "automatic",
      reason: `Reembolso automatico dentro do prazo configurado (${settings.refundLimitDays} dia(s)); aprovacao manual desativada.`,
      eligibility,
      correlationId,
      updateMode: "request",
    });
    return true;
  }

  if (route.reason === "outside_refund_window") {
    await updateComponentMessage(interaction,
      buildRefundExpiredConfirmationPayload({ ticket, order, eligibility }),
      correlationId,
    );
    return true;
  }

  const refundProtocol = generateRefundProtocol(ticket.id, order.key);
  await updateComponentMessage(interaction,
    buildRefundManualQueuedPayload({
      protocol: refundProtocol,
      order,
      eligibility,
      reason: describeRefundRouteReason(route.reason),
    }),
    correlationId,
  );

  try {
    await sendManualApprovalRequest({
      client,
      ticket,
      order,
      settings,
      reason: `Solicitacao confirmada pelo comprador via FlowAI. Rota: ${route.reason}.`,
      eligibility,
      protocol: refundProtocol,
    });
  } catch (error) {
    await updateComponentMessage(interaction,
      buildRefundFailurePayload({
        protocol: refundProtocol,
        order,
        message:
          "A solicitacao precisa de analise manual, mas o canal de aprovacao nao esta configurado ou esta inacessivel. O evento foi registrado para a administracao.",
      }),
      correlationId,
    );
    await logRefundAuditEvent({
      ticket,
      authUserId: authUser.id,
      orderKey: order.key,
      riskScore: eligibility.riskScore,
      eventType: "manual_review_dispatch_failed",
      outcome: "approval_channel_unavailable",
      correlationId,
      metadata: {
        protocol: refundProtocol,
        route_reason: route.reason,
        error: normalizeText(error.message, 500),
        approval_channel_id: settings.approvalChannelId || null,
      },
    });
    return true;
  }

  const historyRows = await fetchRecentAiMessages(ticket.id);
  const previousState = readRefundMemory(historyRows);
  await persistRefundStateDirectly(ticket, previousState, { stage: "manual_review" });

  await logRefundAuditEvent({
    ticket,
    authUserId: authUser.id,
    orderKey: order.key,
    riskScore: eligibility.riskScore,
    eventType: "manual_review_opened",
    outcome: "awaiting_staff",
    correlationId,
    metadata: {
      protocol: refundProtocol,
      insideWindow: eligibility.insideWindow,
      reasons: eligibility.reasons,
      route_reason: route.reason,
      settings_source: settings.source,
      settings_updated_at: settings.updatedAt,
      settings_mode_conflict: settings.modeConflict === true,
    },
  });

  return true;
}

async function handleRefundStaffDecision({
  client,
  interaction,
  ticket,
  order,
  settings,
  runtime,
  action,
  correlationId,
}) {
  const eligibility = evaluateRefundEligibility(order, settings, {
    authUserId: order.authUserId || null,
    discordUserId: ticket.user_id,
  });
  const protocol = generateRefundProtocol(ticket.id, order.key);
  const lockKey = `${ticket.id}:${order.key}`;

  if (action === "deny") {
    await updateComponentMessage(interaction,
      buildRefundStaffReviewPayload({
        ticket,
        order,
        settings,
        reason: "Reembolso recusado manualmente pela equipe.",
        eligibility,
        protocol,
        state: "denied",
        decidedBy: interaction.user.id,
      }),
      correlationId,
    );

    const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
    await channel?.send?.(
      buildRefundV2Payload({
        title: "Reembolso negado",
        tone: "error",
        message:
          "A equipe analisou a solicitacao de reembolso e ela foi negada neste momento. Caso precise de mais detalhes, responda neste ticket.",
      }),
    );

    const denialPayload = buildRefundV2Payload({
      title: "Reembolso negado",
      tone: "error",
      message:
        "A equipe analisou sua solicitacao de reembolso e ela foi negada neste momento. Acompanhe o ticket para mais detalhes.",
    });
    const dmQueue = await enqueueRefundDirectMessage({
      ticket,
      order,
      protocol,
      kind: "denied",
      content: denialPayload,
    });
    if (dmQueue.queued) {
      void processDirectMessageQueue(client, { notificationKey: dmQueue.notificationKey }).catch((error) => {
        console.warn("[ticket-refund] falha ao processar DM imediata de reembolso negado:", error?.message || error);
      });
    }

    await persistRefundStateDirectly(ticket, {}, {
      stage: "completed",
      selectedOrderKey: order.key,
    });
    await logRefundAuditEvent({
      ticket,
      orderKey: order.key,
      riskScore: eligibility.riskScore,
      eventType: "manual_refund_denied",
      outcome: "denied",
      correlationId,
      metadata: {
        responsible_user: interaction.user.id,
        action_time: new Date().toISOString(),
        method: "manual",
        final_status: "denied",
        decidedBy: interaction.user.id,
        protocol,
        dm_notification_queued: dmQueue.queued === true,
      },
    });
    return true;
  }

  if (pendingRefundActions.has(lockKey)) {
    await interaction.reply({
      content: "Este reembolso ja esta sendo processado.",
      ephemeral: true,
    });
    return true;
  }

  pendingRefundActions.add(lockKey);
  try {
    await updateComponentMessage(interaction,
      buildRefundStaffReviewPayload({
        ticket,
        order,
        settings,
        reason: `Aprovado manualmente por ${interaction.user.id}.`,
        eligibility,
        protocol,
        state: "processing",
        decidedBy: interaction.user.id,
      }),
      correlationId,
    );

    await executeRefundProcessing({
      client,
      interaction,
      ticket,
      order,
      settings,
      protocol,
      actorUserId: interaction.user.id,
      authUserId: order.authUserId || null,
      method: "manual",
      reason: `Aprovado manualmente por ${interaction.user.id}; protocolo ${protocol}.`,
      eligibility,
      correlationId,
      updateMode: "staff",
    });
    return true;
  } finally {
    pendingRefundActions.delete(lockKey);
  }
}

function registerLookupAttempt(ticket) {
  const key = `${ticket.guild_id}:${ticket.user_id}`;
  const now = Date.now();
  const bucket = (lookupBuckets.get(key) || []).filter(
    (timestamp) => now - timestamp < REFUND_LOOKUP_RATE_LIMIT_WINDOW_MS,
  );
  bucket.push(now);
  lookupBuckets.set(key, bucket);
  return bucket.length <= REFUND_LOOKUP_RATE_LIMIT_MAX;
}

function hasRepeatedFailedCandidate(state, candidates) {
  const failed = new Set(state.failedOrderCandidates || []);
  return candidates.length > 0 && candidates.every((candidate) => failed.has(normalizeLookupToken(candidate)));
}

async function answerContextualMessage({ message, persist, state, kind, content, ticket }) {
  if (kind === "waiting_review") {
    const nextState = markPrompt(state, "waiting_review");
    await persistRefundState(persist, nextState);
    if (!shouldPrompt(state, "waiting_review", 20_000)) return true;
    await message.reply({
      content: state.stage === "completed"
        ? "O seu pedido ja foi finalizado. Se precisar de mais alguma coisa, a equipe esta a disposicao."
        : "Sim! O seu pedido de reembolso ja esta em analise pela equipe. E so aguardar a resposta por aqui.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (kind === "waiting") {
    const nextState = markPrompt(state, "waiting");
    await persistRefundState(persist, nextState);
    if (!shouldPrompt(state, "waiting", 20_000)) return true;
    const waitingForAuth =
      state.stage === "awaiting_auth" || (state.authStatus && state.authStatus !== "linked");
    await message.reply({
      content: waitingForAuth
        ? "Sem pressa. Quando concluir o Login seguro, eu continuo daqui sem reiniciar o atendimento."
        : "Sem pressa. Quando encontrar, me envie apenas o numero do pedido; eu continuo daqui sem reiniciar o atendimento.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (kind === "order_help") {
    const nextState = markPrompt(state, "order_help");
    await persistRefundState(persist, nextState);
    await message.reply({
      content:
        "O numero costuma aparecer no comprovante ou na area de pedidos, geralmente como `#90058`. Pode mandar com ou sem `#`; eu normalizo aqui.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (kind === "timing") {
    const nextState = markPrompt(state, "timing");
    await persistRefundState(persist, nextState);
    await message.reply({
      content:
        "Depois da validacao, o prazo de estorno depende do provedor de pagamento e do banco emissor. Antes disso eu preciso confirmar a compra correta com seguranca.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (kind === "refund_intake") {
    const nextState = markPrompt(
      sanitizeRefundState({
        ...state,
        intent: true,
        stage: "refund_intake",
      }),
      "refund_intake",
    );
    await persistRefundState(persist, nextState);
    await message.reply({
      content:
        "Vamos com calma: antes de abrir um reembolso, me conta rapidinho o que aconteceu com o pedido? Se for algo como entrega, acesso, produto errado ou erro, talvez eu consiga te ajudar por aqui.\n\nSe voce ja decidiu que quer reembolso mesmo, responda **quero seguir com o reembolso**.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (kind === "side_support") {
    const nextState = markPrompt(state, "side_support");
    await persistRefundState(persist, nextState);
    await message.reply({
      content:
        "Claro, eu acompanho por aqui. Antes de partir direto para reembolso, me conta o que aconteceu com a compra: nao recebeu, veio errado, acesso falhou ou quer cancelar mesmo? Se voce ja tiver o numero do pedido, pode mandar junto que eu consulto sem expor dados sensiveis.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (kind === "human_support") {
    const nextState = markPrompt({ ...state, stage: "manual_review" }, "human_support");
    await persistRefundState(persist, nextState);
    await message.reply({
      content:
        "Tudo bem, vou deixar o caso aberto para a equipe acompanhar. Enquanto isso, se puder, envie o numero do pedido e um resumo curto do que aconteceu; isso ajuda o atendimento humano a chegar ja com contexto.",
      allowedMentions: { parse: [] },
    });
    await logRefundAuditEvent({
      ticket,
      eventType: "human_support_requested_during_refund",
      outcome: "manual_review",
      metadata: { content: normalizeText(content, 300) },
    });
    return true;
  }

  if (kind === "manipulation") {
    const nextState = markPrompt(state, "security");
    await persistRefundState(persist, nextState);
    await message.reply({
      content:
        "Consigo ajudar, mas reembolso passa por validacao de titularidade, status e regras do servidor. Vou seguir esse processo para proteger sua conta e a loja.",
      allowedMentions: { parse: [] },
    });
    await logRefundAuditEvent({
      ticket,
      eventType: "manipulation_attempt_detected",
      outcome: "guarded",
      metadata: { content: normalizeText(content, 300) },
    });
    return true;
  }

  return false;
}

async function handleRefundProtocolQuery({ message, client, ticket, protocolCode, persist }) {
  const searchProtocol = String(protocolCode || "").trim().toUpperCase();

  const searchingMsg = await message.reply({
    content: `Certo! Identifiquei o protocolo **\`${searchProtocol}\`**. Vou consultar os detalhes da solicitação de reembolso no nosso banco de dados, só um instante... 🔍`,
    allowedMentions: { parse: [] },
  });

  try {
    const { data: events, error } = await supabase
      .from("ticket_refund_audit_events")
      .select("*")
      .eq("guild_id", ticket.guild_id)
      .order("created_at", { ascending: false });

    if (error && !isMissingTableError(error, "ticket_refund_audit_events")) {
      throw error;
    }

    const matchingEvents = (events || []).filter((ev) => {
      const proto = ev.metadata?.protocol;
      return typeof proto === "string" && proto.toUpperCase().includes(searchProtocol);
    });

    if (!matchingEvents.length) {
      await searchingMsg.edit({
        content: `Consultei nosso banco de dados, mas nao localizei nenhuma solicitacao correspondente ao protocolo **\`${searchProtocol}\`** no momento. 😕\n\nConfirme se digitou o código corretamente ou envie o número do pedido para iniciarmos uma nova consulta!`,
        allowedMentions: { parse: [] },
      });
      return true;
    }

    const latestEvent = matchingEvents[0];
    const createdDate = latestEvent.created_at ? new Date(latestEvent.created_at) : new Date();
    const formattedDate = createdDate.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    let statusText = "";
    let colorAccent = 0xf1c40f;
    let description = "";

    const eventType = String(latestEvent.event_type || "").toLowerCase();
    const outcome = String(latestEvent.outcome || "").toLowerCase();

    if (
      eventType.includes("approved") ||
      eventType.includes("processed") ||
      outcome === "success" ||
      outcome === "processed"
    ) {
      statusText = "Aprovado e Processado com Sucesso";
      colorAccent = 0x2ecc71;
      description = `O estorno do valor já foi concluído em nosso sistema! 🎉\nO valor foi devolvido para a mesma conta de origem do pagamento. Para pagamentos via Pix, o estorno costuma compensar em poucos minutos. Para cartões de crédito, o prazo de lançamento depende do banco emissor.`;
    } else if (eventType.includes("deny") || eventType.includes("denied") || outcome === "denied") {
      statusText = "Recusado / Negado";
      colorAccent = 0xe74c3c;
      description = `Esta solicitação foi revisada pela nossa equipe e **não foi aprovada** por não cumprir os critérios de reembolso do servidor (como prazo limite expirado ou produto já consumido). Caso precise de suporte adicional, nossa staff está à disposição neste ticket.`;
    } else {
      statusText = "Aguardando Revisão Manual";
      colorAccent = 0xf1c40f;
      description = `A solicitação foi encaminhada para a análise excepcional da nossa equipe de staff. ⏳\nNossos moderadores estão revisando os detalhes da compra e darão um retorno diretamente aqui no seu ticket em breve. Não se preocupe, não é necessário fazer nada!`;
    }

    let orderInfoLine = "";
    if (latestEvent.order_key) {
      const order = await getOrderByKey(ticket.guild_id, latestEvent.order_key).catch(() => null);
      if (order) {
        orderInfoLine = `\n**Compra:** ${order.productTitle || "Produto"}\n**Valor:** ${formatMoney(order.amount, order.currency)}`;
      }
    }

    await searchingMsg.delete().catch(() => null);
    await message.reply(
      buildRefundV2Payload({
        title: "Status da solicitacao de reembolso",
        tone:
          colorAccent === 0x2ecc71
            ? "success"
            : colorAccent === 0xe74c3c
              ? "error"
              : "warning",
        message: [
          `Encontrei as informacoes sobre a solicitacao com o protocolo **\`${searchProtocol}\`**:`,
          "",
          `**Status:** \`${statusText}\``,
          `**Data de abertura:** ${formattedDate}`,
          orderInfoLine,
          "",
          "**Informacoes**",
          description,
        ].join("\n"),
      }),
    );

    let newStage = "manual_review";
    if (statusText.includes("Aprovado")) {
      newStage = "completed";
    }

    const historyRows = await fetchRecentAiMessages(ticket.id);
    const previousState = readRefundMemory(historyRows);
    await persistRefundStateDirectly(ticket, previousState, { stage: newStage });

    return true;
  } catch (error) {
    console.error("[ticket-refund] erro ao processar busca de protocolo:", error);
    await searchingMsg.edit({
      content: `Ocorreu um erro interno ao tentar consultar o protocolo **\`${searchProtocol}\`**. Por favor, tente novamente ou aguarde a staff.`,
      allowedMentions: { parse: [] },
    });
    return true;
  }
}

async function handleRefundOrVerificationMessage({ message, client, ticket, runtime, historyRows, content, persist }) {
  const protocolMatch = String(content || "").match(/(RMB-\d{4,8}-[A-Z0-9]+-[A-Z0-9]+|RMB-[A-Z0-9-]+)/i);
  if (protocolMatch) {
    const protocolCode = protocolMatch[0];
    return await handleRefundProtocolQuery({ message, client, ticket, protocolCode, persist });
  }

  const previousState = readRefundMemory(historyRows);
  let state = buildRefundMemoryPatch(content, historyRows);
  const active = isActiveRefundState(previousState);
  const currentIntent = state.currentIntent === true;
  const cancelIntent = state.cancelIntent === true;
  const orderCandidates = extractOrderCandidates(content, {
    allowShortGeneric: active && !cancelIntent,
  });
  const hasEmail = Boolean(extractEmail(content));

  if (cancelIntent && active) {
    await persistRefundState(persist, state);
    await logRefundAuditEvent({
      ticket,
      eventType: "conversation_cancelled",
      outcome: "user_cancelled",
    });
    return false;
  }

  if (isWaitingFiller(content) || isThankYouIntent(content)) {
    // Agradecimentos e fillers de aguardo (ex: "obrigado", "vou procurar", "ok vou ver")
    // não devem ser interceptados por respostas estáticas rígidas; retornamos false para a LLM geral responder humanamente!
    return false;
  }

  const changeAccount = isChangeAccountIntent(content);
  if (changeAccount) {
    state = sanitizeRefundState({
      ...state,
      intent: true,
      stage: "awaiting_auth",
      authStatus: "pending",
    });
    await sendSecureLoginPrompt({
      message,
      client,
      ticket,
      persist,
      state,
      authUser: null,
    });
    return true;
  }

  if (!state.intent && !currentIntent && !(active && orderCandidates.length)) return false;

  const alreadyPromptedIntake =
    previousState.stage === "refund_intake" ||
    previousState.lastPromptKind === "refund_intake" ||
    state.lastPromptKind === "refund_intake";

  if (state.stage === "refund_intake" || alreadyPromptedIntake) {
    const proceedRefund =
      (alreadyPromptedIntake &&
        (isRefundProceedIntent(content) || isRefundIntakeConfirmation(content))) ||
      isRefundHardProceedIntent(content);

    if (!proceedRefund) {
      if (!alreadyPromptedIntake || shouldPrompt(state, "refund_intake", REFUND_PROMPT_COOLDOWN_MS)) {
        return answerContextualMessage({
          message,
          persist,
          state,
          kind: "refund_intake",
          content,
          ticket,
        });
      }

      if (isRefundSupportConversationIntent(content) || !currentIntent) {
        await persistRefundState(persist, state);
        return false;
      }

      await persistRefundState(persist, state);
      return true;
    }

    state = sanitizeRefundState({
      ...state,
      intent: true,
      stage: "awaiting_auth",
      lastActionAt: nowIso(),
    });
    await persistRefundState(persist, state);
  }

  if (["manual_review", "completed"].includes(state.stage)) {
    const wantsAnother = currentIntent || isListOrdersIntent(content);
    if (!currentIntent && !wantsAnother) return false;
    state = createDefaultRefundState();
    state.intent = true;
    state.stage = "awaiting_auth";
  }

  if (containsManipulationAttempt(content)) {
    state = sanitizeRefundState({ ...state, intent: true, stage: state.stage || "awaiting_auth" });
    return answerContextualMessage({
      message,
      persist,
      state,
      kind: "manipulation",
      content,
      ticket,
    });
  }

  const settings = await getTicketRefundSettings(ticket.guild_id, runtime);
  if (!settings.enabled) {
    await persistRefundState(persist, state, { stage: "manual_review" });
    await message.reply({
      content:
        "A verificacao automatica de reembolso nao esta ativa neste servidor. Vou manter o contexto no ticket para a equipe acompanhar por aqui.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const authUser = await getAuthUserByDiscordUserId(ticket.user_id);

  if (!authUser) {
    if (isWaitingFiller(content) && active) {
      return answerContextualMessage({ message, persist, state, kind: "waiting", content, ticket });
    }

    if (hasEmail && shouldPrompt(state, "email_redirect", 10_000)) {
      await message.reply({
        content:
          "Para sua seguranca, nao vou usar email enviado no chat. Use o botao de Login para vincular a conta correta e eu sigo sem pedir senha ou dados sensiveis.",
        allowedMentions: { parse: [] },
      });
    }

    if (shouldPrompt(state, "login", REFUND_PROMPT_COOLDOWN_MS) || !state.authLinkId) {
      await sendSecureLoginPrompt({
        message,
        client,
        ticket,
        persist,
        state,
        authUser: null,
      });
    } else {
      await persistRefundState(persist, state, {
        stage: "awaiting_auth",
        authStatus: "pending",
      });
    }
    return true;
  }

  const sessionAuthConfirmed =
    state.authStatus === "linked" &&
    Number(state.authUserId) === Number(authUser.id) &&
    Boolean(state.authLinkId) &&
    Boolean(state.authConfirmedAt);

  if (!sessionAuthConfirmed) {
    const pendingState = sanitizeRefundState({
      ...state,
      intent: true,
      authStatus: "pending",
      authUserId: authUser.id,
      stage: "awaiting_auth",
    });

    if (shouldPrompt(pendingState, "confirm_account", REFUND_PROMPT_COOLDOWN_MS) || !pendingState.authLinkId) {
      await sendSecureLoginPrompt({
        message,
        client,
        ticket,
        persist,
        state: pendingState,
        authUser,
        requireConfirmation: true,
      });
    } else {
      await persistRefundState(persist, pendingState);
    }
    return true;
  }

  state = sanitizeRefundState({
    ...state,
    intent: true,
    authStatus: "linked",
    authUserId: authUser.id,
    stage: state.stage === "awaiting_auth" || !state.stage ? "awaiting_order" : state.stage,
  });

  if (!state.authLinkId) {
    const link = await createTicketRefundAuthLink(ticket);
    const payload = buildLoginPromptPayload(link.url, authUser);
    const sent = await message.channel.send(payload);

    state = markPrompt({
      ...state,
      authLinkId: link.linkId,
      loginMessageId: sent?.id || null,
    }, "ask_order_with_login");
    await persistRefundState(persist, state);

    await startLoginPolling({
      client,
      ticket,
      linkId: link.linkId,
      authMessage: sent,
      persist,
      state,
    });

    if (!orderCandidates.length) {
      return true;
    }
  }

  if (hasEmail && !orderCandidates.length) {
    state = markPrompt(state, "email_ignored_linked");
    await persistRefundState(persist, state);
    await message.reply({
      content:
        "Conta segura ja vinculada. Nao preciso que voce envie email no chat; agora me mande apenas o numero do pedido.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (isWaitingFiller(content) && !orderCandidates.length) {
    return answerContextualMessage({ message, persist, state, kind: "waiting", content, ticket });
  }

  if (isOrderHelpQuestion(content) && !orderCandidates.length) {
    return answerContextualMessage({ message, persist, state, kind: "order_help", content, ticket });
  }

  if (isTimingQuestion(content) && !orderCandidates.length) {
    return answerContextualMessage({ message, persist, state, kind: "timing", content, ticket });
  }

  if (isHumanSupportIntent(content) && !orderCandidates.length) {
    return answerContextualMessage({ message, persist, state, kind: "human_support", content, ticket });
  }

  if (isRefundSupportConversationIntent(content) && !orderCandidates.length) {
    return answerContextualMessage({ message, persist, state, kind: "side_support", content, ticket });
  }

  if (isCasualGreetingIntent(content) && !orderCandidates.length) {
    state = markPrompt(state, "greeting");
    await persistRefundState(persist, state);
    await message.reply({
      content:
        "Tudo otimo por aqui! 😄\n\nEstou com a sua conta segura vinculada e pronta. Para darmos andamento ao reembolso, basta me enviar o numero do seu pedido (por exemplo, `90058`). Se você quer trocar a conta vinculada, clique em **Login / Trocar Conta** acima!",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (isListOrdersIntent(content) && !orderCandidates.length) {
    const activeOrders = await listUserRecentOrders({
      guildId: ticket.guild_id,
      authUserId: authUser.id,
      discordUserId: ticket.user_id,
    });

    const availableOrders = [];
    for (const order of activeOrders) {
      const status = String(order.status || "").toLowerCase();
      const providerStatus = String(order.providerStatus || "").toLowerCase();
      const providerDetail = String(order.providerStatusDetail || "").toLowerCase();
      const alreadyRefunded =
        isRefundTerminalStatus(status) ||
        isRefundTerminalStatus(providerStatus) ||
        providerDetail.includes("refund") ||
        providerDetail.includes("chargeback") ||
        providerDetail.includes("reembols");

      const paid =
        order.source === "sales"
          ? ["paid", "delivered", "delivery_failed"].includes(status)
          : ["approved", "settled"].includes(status) || providerStatus === "approved";

      if (paid && !alreadyRefunded) {
        availableOrders.push(order);
      }
    }

    if (availableOrders.length > 0) {
      state = sanitizeRefundState({
        ...state,
        stage: "selecting_order",
        availableOrderKeys: availableOrders.map((order) => order.key),
      });
      await persistRefundState(persist, state);

      await message.reply({
        content:
          "Encontrei as seguintes compras recentes associadas a sua conta vinculada. 😄\n\nPor favor, selecione qual delas voce quer verificar para reembolso no menu abaixo:",
        allowedMentions: { parse: [] },
      });
      await message.channel.send(buildOrderSelectionMessage(ticket, availableOrders));
    } else {
      await message.reply({
        content:
          "Consultei sua conta segura vinculada, mas nao encontrei nenhuma compra recente aprovada sob ela. 😕\n\nSe a compra foi feita sob outra conta, voce pode clicar em **Login / Trocar Conta** acima para vincular o cadastro correto. Caso contrario, me envie o numero do pedido para eu verificar mais a fundo.",
        allowedMentions: { parse: [] },
      });
    }
    return true;
  }

  if (state.stage === "selecting_order" && !orderCandidates.length) {
    const resendEmbed = isResendEmbedIntent(content);
    if (resendEmbed && state.orderCandidates?.length) {
      orderCandidates.push(...state.orderCandidates);
    } else if (shouldPrompt(state, "select_pending", REFUND_PROMPT_COOLDOWN_MS)) {
      state = markPrompt(state, "select_pending");
      await persistRefundState(persist, state);
      await message.reply({
        content:
          "Eu ja encontrei opcoes compativeis. Selecione a compra no menu acima ou use Cancelar para procurar outro pedido.",
        allowedMentions: { parse: [] },
      });
      return true;
    } else {
      return true;
    }
  }

  if (!orderCandidates.length) {
    if (shouldPrompt(state, "ask_order", REFUND_PROMPT_COOLDOWN_MS)) {
      state = markPrompt({ ...state, stage: "awaiting_order" }, "ask_order");
      await persistRefundState(persist, state);
      await message.reply({
        content:
          "Conta vinculada. Me envie o numero do pedido para eu consultar status, prazo e elegibilidade com seguranca.",
        allowedMentions: { parse: [] },
      });
      return true;
    } else {
      await persistRefundState(persist, state, { stage: "awaiting_order" });
      return false;
    }
  }

  if (hasRepeatedFailedCandidate(state, orderCandidates)) {
    state = markPrompt({ ...state, stage: "lookup_failed" }, "same_failed_order");
    await persistRefundState(persist, state);
    await message.reply({
      content:
        "Eu ja tentei esse numero na conta vinculada e nao encontrei uma compra correspondente. Confira se e o pedido certo ou envie outro numero; se for de outra conta, refaca o Login com a conta correta.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (!registerLookupAttempt(ticket)) {
    state = markPrompt({ ...state, stage: "manual_review" }, "rate_limited");
    await persistRefundState(persist, state);
    await logRefundAuditEvent({
      ticket,
      authUserId: authUser.id,
      eventType: "lookup_rate_limited",
      outcome: "manual_review",
    });
    await message.reply({
      content:
        "Detectei muitas tentativas de consulta em pouco tempo. Para proteger a compra, vou deixar a equipe validar manualmente por aqui.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  await message.channel.send({
    content:
      "Certo, vou consultar a compra na conta vinculada. Aguarde um momento enquanto verifico status, prazo e elegibilidade.",
    allowedMentions: { parse: [] },
  });

  await logRefundAuditEvent({
    ticket,
    authUserId: authUser.id,
    eventType: "lookup_started",
    outcome: "started",
    metadata: { orderCandidates },
  });

  const orders = await withTimeout(
    findMatchingOrders({
      guildId: ticket.guild_id,
      authUserId: authUser.id,
      discordUserId: ticket.user_id,
      orderCandidates,
    }),
    ORDER_LOOKUP_TIMEOUT_MS,
    "Consulta de compra",
  ).catch(async (error) => {
    await logRefundAuditEvent({
      ticket,
      authUserId: authUser.id,
      eventType: "lookup_failed",
      outcome: "error",
      metadata: { message: normalizeText(error.message, 300), orderCandidates },
    });
    throw error;
  });
  const visibleOrders = orders.filter((order) =>
    isOrderOwnedByTicketContext(order, {
      authUserId: authUser.id,
      discordUserId: ticket.user_id,
    }),
  );

  if (orders.length > 0 && visibleOrders.length === 0) {
    state = markPrompt({ ...state, stage: "lookup_failed" }, "ownership_mismatch");
    await persistRefundState(persist, state);
    await logRefundAuditEvent({
      ticket,
      authUserId: authUser.id,
      eventType: "lookup_ownership_mismatch",
      outcome: "blocked",
      metadata: { orderCandidates },
    });
    await message.channel.send({
      content:
        "Encontrei uma referencia parecida, mas ela nao pertence a conta confirmada neste ticket. Por seguranca, nao posso consultar nem abrir reembolso desse pedido. Confirme a conta correta pelo Login / Trocar Conta e envie o numero novamente.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const availableOrders = [];
  const refundedOrders = [];

  for (const order of visibleOrders) {
    const status = String(order.status || "").toLowerCase();
    const providerStatus = String(order.providerStatus || "").toLowerCase();
    const providerDetail = String(order.providerStatusDetail || "").toLowerCase();
    const alreadyRefunded =
      isRefundTerminalStatus(status) ||
      isRefundTerminalStatus(providerStatus) ||
      providerDetail.includes("refund") ||
      providerDetail.includes("chargeback") ||
      providerDetail.includes("reembols");

    if (alreadyRefunded) {
      refundedOrders.push(order);
    } else {
      availableOrders.push(order);
    }
  }

  if (visibleOrders.length > 0 && availableOrders.length === 0) {
    state = markPrompt({ ...state, stage: "completed" }, "already_refunded");
    await persistRefundState(persist, state);
    await message.channel.send({
      content:
        "Este pedido ja consta como reembolsado ou com estorno em andamento no sistema. Nao e possivel solicitar um novo reembolso para a mesma compra.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  state = sanitizeRefundState({
    ...state,
    stage: availableOrders.length ? "selecting_order" : "lookup_failed",
    orderCandidates: [...new Set([...orderCandidates, ...state.orderCandidates])].slice(0, 8),
    failedOrderCandidates: availableOrders.length
      ? state.failedOrderCandidates
      : [...new Set([...(state.failedOrderCandidates || []), ...orderCandidates])].slice(0, 12),
    availableOrderKeys: availableOrders.map((order) => order.key),
    lookupCount: Number(state.lookupCount || 0) + 1,
    lastLookupAt: nowIso(),
  });
  await persistRefundState(persist, state);

  if (!availableOrders.length) {
    await message.channel.send({
      content:
        "Nao encontrei uma compra compativel com esse numero na conta vinculada. Confira o pedido ou envie outro numero; se a compra estiver em outra conta, refaca o Login com a conta correta.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  // Check if all found orders are outside the refund window (warn before selection)
  const tempSettings = await getTicketRefundSettings(ticket.guild_id, runtime).catch(() => null);
  const allOutsideWindow = tempSettings && availableOrders.every((ord) => {
    const purchaseMs = parseTimestampMs(resolvePurchaseDate(ord));
    const limitDays = Math.max(0, Number(tempSettings.refundLimitDays || DEFAULT_REFUND_DAYS));
    const deadlineMs = purchaseMs + limitDays * 24 * 60 * 60 * 1000;
    return Number.isFinite(purchaseMs) && Date.now() > deadlineMs;
  });

  if (allOutsideWindow && tempSettings) {
    await message.channel.send({
      content: `⚠️ O prazo limite de reembolso configurado (**${tempSettings.refundLimitDays} dias**) ja foi ultrapassado para esta(s) compra(s). Voce ainda pode selecionar e enviar a solicitacao para analise da equipe.`,
      allowedMentions: { parse: [] },
    });
  }

  await message.channel.send(buildOrderSelectionMessage(ticket, availableOrders));
  return true;
}

async function getTicketById(ticketId) {
  const result = await supabase.from("tickets").select("*").eq("id", ticketId).maybeSingle();
  return result.error ? null : result.data;
}

async function handleTicketRefundInteraction(interaction, client, runtimeLoader) {
  const customId = String(interaction.customId || "");
  if (!customId.startsWith(REFUND_PREFIX)) return false;

  const [, , action, ticketId, orderKeyFromId] = customId.split(":");
  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Ticket nao encontrado para esta acao.", ephemeral: true });
    return true;
  }

  const runtime = await runtimeLoader(ticket.guild_id).catch(() => null);
  const settings = await getTicketRefundSettings(ticket.guild_id, runtime);

  if (action === "cancel") {
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({
        content: "Somente o comprador deste ticket pode cancelar esta selecao.",
        ephemeral: true,
      });
      return true;
    }
    await interaction.update(
      v2Message([
        {
          type: COMPONENT_TYPE.CONTAINER,
          accent_color: 0xb0b0b0,
          components: [
            textDisplay(
              "Selecao cancelada. Envie outro numero de pedido se quiser continuar a verificacao, ou siga com o novo assunto no ticket.",
            ),
          ],
        },
      ]),
    );
    await persistRefundStateDirectly(ticket, { stage: "cancelled", intent: false });
    await logRefundAuditEvent({
      ticket,
      eventType: "selection_cancelled",
      outcome: "user_cancelled",
    });
    return true;
  }

  if (action === "confirm_expired") {
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({
        content: "Somente o comprador deste ticket pode confirmar esta acao.",
        ephemeral: true,
      });
      return true;
    }

    const authUser = await getAuthUserByDiscordUserId(ticket.user_id);
    const selectedOrderKey = orderKeyFromId;
    const order = await getOrderByKey(ticket.guild_id, selectedOrderKey, {
      authUserId: authUser?.id,
      discordUserId: ticket.user_id,
    });

    if (!order) {
      await interaction.reply({
        content: "Nao encontrei essa compra na conta vinculada.",
        ephemeral: true,
      });
      return true;
    }

    const lockKey = `${ticket.id}:${order.key}`;
    if (pendingRefundActions.has(lockKey)) {
      await interaction.reply({
        content: "Ja existe uma solicitacao em andamento para essa compra.",
        ephemeral: true,
      });
      return true;
    }
    pendingRefundActions.add(lockKey);

    try {
      const accountViolations = await fetchActiveAccountViolations(authUser?.id);
      const eligibility = evaluateRefundEligibility(order, settings, {
        authUserId: authUser?.id,
        discordUserId: ticket.user_id,
        accountViolations,
      });

      const refundProtocol = generateRefundProtocol(ticket.id, order.key);
      const expiredCorrelationId = createCorrelationId("refund_expired");

      await updateComponentMessage(interaction,
        buildRefundProcessingPayload({
          protocol: refundProtocol,
          order,
          mode: "Enviando para analise manual",
        }),
        expiredCorrelationId,
      );

      const manualRequest = await sendManualApprovalRequest({
        client,
        ticket,
        order,
        settings,
        reason: "Solicitacao confirmada pelo comprador via FlowAI (Mesmo expirada).",
        allowedMentions: { parse: [] },
        eligibility,
        protocol: refundProtocol,
      }).catch(async (error) => {
        await updateComponentMessage(interaction,
          buildRefundFailurePayload({
            protocol: refundProtocol,
            order,
            message:
              "Nao consegui encaminhar a analise manual porque o canal de aprovacao nao esta configurado ou esta inacessivel.",
          }),
          expiredCorrelationId,
        );
        await logRefundAuditEvent({
          ticket,
          authUserId: authUser?.id,
          orderKey: order.key,
          riskScore: eligibility.riskScore,
          eventType: "manual_review_dispatch_failed",
          outcome: "approval_channel_unavailable",
          metadata: {
            protocol: refundProtocol,
            userConfirmedExpired: true,
            error: normalizeText(error.message, 500),
          },
        });
        return null;
      });
      if (!manualRequest) return true;

      await updateComponentMessage(interaction,
        buildRefundManualQueuedPayload({
          protocol: refundProtocol,
          order,
          eligibility,
          reason: describeRefundRouteReason("outside_refund_window"),
        }),
        expiredCorrelationId,
      );

      const historyRows = await fetchRecentAiMessages(ticket.id);
      const previousState = readRefundMemory(historyRows);
      await persistRefundStateDirectly(ticket, previousState, { stage: "manual_review" });

      await logRefundAuditEvent({
        ticket,
        authUserId: authUser?.id,
        orderKey: order.key,
        riskScore: eligibility.riskScore,
        eventType: "manual_review_opened",
        outcome: "awaiting_staff",
        metadata: { protocol: refundProtocol, insideWindow: eligibility.insideWindow, reasons: eligibility.reasons, userConfirmedExpired: true },
      });
      return true;
    } finally {
      pendingRefundActions.delete(lockKey);
    }
  }

  if (action === "cancel_expired") {
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({
        content: "Somente o comprador deste ticket pode cancelar esta acao.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.update(
      v2Message([
        {
          type: COMPONENT_TYPE.CONTAINER,
          accent_color: 0xb0b0b0,
          components: [
            textDisplay(
              "Solicitacao de reembolso cancelada devido ao prazo expirado. Se precisar de outra ajuda, envie no chat."
            ),
          ],
        },
      ])
    );

    await persistRefundStateDirectly(ticket, { stage: "cancelled", intent: false });
    await logRefundAuditEvent({
      ticket,
      eventType: "selection_cancelled",
      outcome: "user_cancelled_expired_window",
    });
    return true;
  }

  if (action === "select") {
    const correlationId = createCorrelationId("refund_select");
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({
        content: "Somente o comprador deste ticket pode selecionar a compra.",
        ephemeral: true,
      });
      return true;
    }
    await acknowledgeComponent(interaction, correlationId);

    const authUser = await getAuthUserByDiscordUserId(ticket.user_id);
    if (!authUser) {
      await sendInteractionNotice(interaction, {
        content: "A conta Discord ainda nao esta vinculada. Use o botao de Login antes de confirmar a compra.",
        ephemeral: true,
      }, correlationId);
      return true;
    }

    const selectedOrderKey = interaction.values?.[0];
    const order = await getOrderByKey(ticket.guild_id, selectedOrderKey, {
      authUserId: authUser.id,
      discordUserId: ticket.user_id,
    });
    if (!order) {
      await sendInteractionNotice(interaction, {
        content: "Nao encontrei essa compra na conta vinculada.",
        ephemeral: true,
      }, correlationId);
      return true;
    }

    const lockKey = `${ticket.id}:${order.key}`;
    if (pendingRefundActions.has(lockKey)) {
      await sendInteractionNotice(interaction, {
        content: "Ja existe uma solicitacao em andamento para essa compra.",
        ephemeral: true,
      }, correlationId);
      return true;
    }
    pendingRefundActions.add(lockKey);

    try {
      const accountViolations = await fetchActiveAccountViolations(authUser.id);
      const eligibility = evaluateRefundEligibility(order, settings, {
        authUserId: authUser.id,
        discordUserId: ticket.user_id,
        accountViolations,
      });
      const selectedRoute = resolveRefundRoute(eligibility, settings);
      await logRefundAuditEvent({
        ticket,
        authUserId: authUser.id,
        orderKey: order.key,
        riskScore: eligibility.riskScore,
        eventType: "order_selected",
        outcome: selectedRoute.route,
        metadata: {
          source: order.source,
          reasons: eligibility.reasons,
          route_reason: selectedRoute.reason,
          activeViolationCount: accountViolations.length,
        },
      });

      return await routeSelectedRefundRequest({
        client,
        interaction,
        ticket,
        order,
        settings,
        authUser,
        eligibility,
        correlationId,
      });
    } finally {
      pendingRefundActions.delete(lockKey);
    }
  }

  if (action === "approve" || action === "deny") {
    const correlationId = createCorrelationId(`refund_${action}`);
    // 1. Validação de permissões rígida
    if (!hasRefundApprovalPermission(interaction.member, settings, runtime)) {
      await logRefundAuditEvent({
        ticket,
        orderKey: orderKeyFromId || null,
        eventType: "unauthorized_refund_action_attempt",
        outcome: "blocked",
        metadata: {
          attemptedBy: interaction.user.id,
          actionType: action,
          action_time: new Date().toISOString(),
        },
      });
      await interaction.reply({
        content: "Voce nao tem permissao para decidir este reembolso.",
        ephemeral: true,
      });
      return true;
    }

    // 2. Buscar o pedido de forma fresca no banco de dados
    const order = await getOrderByKey(ticket.guild_id, orderKeyFromId);
    if (!order) {
      await interaction.reply({
        content: "Compra nao encontrada para esta decisao.",
        ephemeral: true,
      });
      return true;
    }

    // 3. Prevenir estado inválido ou dupla aprovação
    const orderStatus = String(order.status || "").toLowerCase();
    const orderProviderStatus = String(order.providerStatus || "").toLowerCase();
    if (
      isRefundTerminalStatus(orderStatus) ||
      isRefundTerminalStatus(orderProviderStatus)
    ) {
      await interaction.reply({
        content: "Esta compra ja consta como reembolsada ou contestada na base de dados.",
        ephemeral: true,
      });
      return true;
    }

    return await handleRefundStaffDecision({
      client,
      interaction,
      ticket,
      order,
      settings,
      runtime,
      action,
      correlationId,
    });
  }

  return false;
}

async function handleOrderInfoLookupMessage({ message, ticket, historyRows, content, persist }) {
  const previousState = readRefundMemory(historyRows);
  const askedForOrderInfo = isOrderInfoIntent(content);
  const referencedContent = askedForOrderInfo ? await getReferencedAuthorMessageContent(message) : "";
  const directOrderCandidates = extractOrderCandidates(content, {
    allowShortGeneric: assistantAskedForOrderNumber(historyRows),
  });
  const referencedOrderCandidates =
    directOrderCandidates.length || !referencedContent
      ? []
      : extractOrderCandidates(referencedContent, { allowShortGeneric: true });
  const orderCandidates = [...new Set([...directOrderCandidates, ...referencedOrderCandidates])].slice(0, 6);
  const shouldLookup =
    orderCandidates.length > 0 &&
    !isRefundOrOrderIntent(content) &&
    (assistantAskedForOrderNumber(historyRows) ||
      askedForOrderInfo ||
      previousState.lastPromptKind === "order_info_lookup");

  if (!shouldLookup) {
    if (askedForOrderInfo && !isRefundOrOrderIntent(content)) {
      await persistRefundState(persist, {
        ...previousState,
        intent: false,
        stage: null,
        lastPromptKind: "order_info_lookup",
        lastPromptAt: nowIso(),
        lastActionAt: nowIso(),
      });
    }
    return false;
  }

  const authUser = await getAuthUserByDiscordUserId(ticket.user_id);
  const ownedOrders = await findMatchingOrders({
    guildId: ticket.guild_id,
    authUserId: authUser?.id || null,
    discordUserId: ticket.user_id,
    orderCandidates,
  }).catch((error) => {
    console.warn("[ticket-refund] falha na consulta segura de pedido:", error.message);
    return [];
  });
  const visibleOrders = ownedOrders.filter((order) =>
    isOrderOwnedByTicketContext(order, {
      authUserId: authUser?.id || null,
      discordUserId: ticket.user_id,
    }),
  );

  if (visibleOrders.length) {
    const order = visibleOrders[0];
    await persistRefundState(persist, {
      ...previousState,
      intent: false,
      stage: null,
      lastPromptKind: "order_info_found",
      lastPromptAt: nowIso(),
      lastActionAt: nowIso(),
    });
    await message.reply(buildRefundOrderInfoPayload(order));
    await logRefundAuditEvent({
      ticket,
      authUserId: authUser?.id,
      orderKey: order.key,
      eventType: "order_info_lookup",
      outcome: "found_for_ticket_owner",
      metadata: {
        orderCandidates,
        source: order.source,
        exposedFields: ["order_id", "status", "purchase_date", "amount", "source"],
      },
    });
    return true;
  }

  const anyOrders = await findAnyMatchingSalesOrders({
    guildId: ticket.guild_id,
    orderCandidates,
  }).catch(() => []);

  await persistRefundState(persist, {
    ...previousState,
    intent: false,
    stage: null,
    lastPromptKind: "order_info_not_owned",
    lastPromptAt: nowIso(),
    lastActionAt: nowIso(),
  });

  if (anyOrders.length) {
    await message.reply({
      content:
        "Eu encontrei uma referencia parecida, mas ela nao esta vinculada ao Discord que abriu este ticket. Por seguranca, nao posso exibir informacoes desse pedido por aqui.\n\nConfira se voce abriu o ticket com a conta correta ou chame a equipe para validar a titularidade.",
      allowedMentions: { parse: [] },
    });
    await logRefundAuditEvent({
      ticket,
      authUserId: authUser?.id,
      eventType: "order_info_lookup",
      outcome: "ownership_mismatch",
      metadata: { orderCandidates },
    });
    return true;
  }

  await message.reply({
    content:
      "Nao encontrei esse pedido vinculado ao Discord deste ticket. Confere se o codigo esta completo e se voce abriu o ticket com a conta correta?",
    allowedMentions: { parse: [] },
  });
  await logRefundAuditEvent({
    ticket,
    authUserId: authUser?.id,
    eventType: "order_info_lookup",
    outcome: "not_found",
    metadata: { orderCandidates },
  });
  return true;
}

function isTicketRefundInteraction(interaction) {
  return (
    (interaction.isButton?.() || interaction.isStringSelectMenu?.()) &&
    String(interaction.customId || "").startsWith(REFUND_PREFIX)
  );
}

module.exports = {
  buildRefundMemoryPatch,
  handleOrderInfoLookupMessage,
  handleRefundOrVerificationMessage,
  handleTicketRefundInteraction,
  isTicketRefundInteraction,
};
