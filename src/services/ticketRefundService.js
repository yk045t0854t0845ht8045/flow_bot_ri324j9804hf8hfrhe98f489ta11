const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const { canClaimTicket, canCloseTicket } = require("../utils/staff");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const REFUND_PREFIX = "ticket:refund:";
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
  return {
    flags: COMPONENTS_V2_FLAG,
    allowedMentions: { parse: [] },
    components,
    ...extra,
  };
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
    "verificar compra",
    "verificacao de compra",
    "validar pedido",
    "consultar pedido",
    "numero do pedido",
    "n do pedido",
    "meu pedido",
    "minha compra",
    "comprei",
    "nao recebi",
    "pedido",
  ]);
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
    "nova conta"
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
    "ja envio"
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
    stage: previousState.stage || (intent ? "awaiting_auth" : null),
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
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: currency || "BRL",
  }).format(Number(value || 0));
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

async function logRefundAuditEvent(input) {
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
    metadata: input.metadata || {},
  };

  const result = await supabase.from("ticket_refund_audit_events").insert(payload);
  if (result.error && !isMissingTableError(result.error, "ticket_refund_audit_events")) {
    console.warn("[ticket-refund] falha ao registrar auditoria:", result.error.message);
  }
}

async function getTicketRefundSettings(guildId, runtime) {
  const fallbackRoles = [
    runtime?.staffSettings?.admin_role_id,
    ...(runtime?.staffSettings?.close_role_ids || []),
    ...(runtime?.staffSettings?.claim_role_ids || []),
  ].filter(Boolean);
  const fallback = {
    enabled: true,
    refundLimitDays: DEFAULT_REFUND_DAYS,
    rules: "",
    autoProcessEnabled: false,
    manualApprovalRequired: true,
    approvalChannelId: runtime?.settings?.logs_closed_channel_id || null,
    approverRoleIds: [...new Set(fallbackRoles)],
    successMessage:
      "Reembolso concluido. O prazo de estorno ou compensacao depende do provedor de pagamento e do banco emissor.",
    errorMessage:
      "Nao consegui concluir o reembolso automaticamente. Encaminhei o caso para a equipe responsavel analisar.",
  };

  const result = await supabase
    .from("guild_ticket_refund_settings")
    .select("*")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (result.error) {
    if (isMissingTableError(result.error, "guild_ticket_refund_settings")) {
      return fallback;
    }
    console.warn("[ticket-refund] falha ao ler configuracao:", result.error.message);
    return fallback;
  }

  const row = result.data || {};
  return {
    enabled: row.enabled !== false,
    refundLimitDays: Number.isFinite(Number(row.refund_limit_days))
      ? Number(row.refund_limit_days)
      : fallback.refundLimitDays,
    rules: normalizeText(row.refund_rules || "", 1200),
    autoProcessEnabled: row.auto_process_enabled === true,
    manualApprovalRequired: row.manual_approval_required !== false,
    approvalChannelId: row.approval_channel_id || fallback.approvalChannelId,
    approverRoleIds: Array.isArray(row.approver_role_ids)
      ? row.approver_role_ids.filter(Boolean)
      : fallback.approverRoleIds,
    successMessage: normalizeText(row.success_message || "", 500) || fallback.successMessage,
    errorMessage: normalizeText(row.error_message || "", 500) || fallback.errorMessage,
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

function buildLoginPromptPayload(url, authUser) {
  if (authUser) {
    return v2Message([
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x8fdbff,
        components: [
          textDisplay(
            [
              "## Conta ja vinculada",
              `Sua conta segura (ID: ${authUser.id}) ja esta vinculada. Se a compra foi feita nesta conta, **basta enviar o numero do pedido abaixo**.`,
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
      if (link?.status === "confirmed" && link.auth_user_id) {
        authUser = await getAuthUserById(link.auth_user_id);
      }
      if (!authUser) {
        authUser = await getAuthUserByDiscordUserId(ticket.user_id);
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

async function sendSecureLoginPrompt({ message, client, ticket, persist, state, authUser }) {
  const link = await createTicketRefundAuthLink(ticket);
  const payload = buildLoginPromptPayload(link.url, authUser);
  const sent = await message.channel.send(payload);
  const nextState = markPrompt(
    {
      ...state,
      intent: true,
      stage: authUser ? "awaiting_order" : "awaiting_auth",
      authStatus: authUser ? "linked" : "pending",
      authLinkId: link.linkId,
      loginMessageId: sent?.id || null,
    },
    authUser ? "ask_order_with_login" : "login",
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
  const cartRows = new Map();

  if (authUserId) {
    const authCartResult = await supabase
      .from("guild_sales_carts")
      .select("*")
      .eq("guild_id", guildId)
      .eq("auth_user_id", authUserId)
      .order("created_at", { ascending: false })
      .limit(60);
    if (!authCartResult.error) {
      for (const cart of authCartResult.data || []) cartRows.set(cart.id, cart);
    }
  }

  if (discordUserId) {
    const discordCartResult = await supabase
      .from("guild_sales_carts")
      .select("*")
      .eq("guild_id", guildId)
      .eq("discord_user_id", discordUserId)
      .order("created_at", { ascending: false })
      .limit(60);
    if (!discordCartResult.error) {
      for (const cart of discordCartResult.data || []) cartRows.set(cart.id, cart);
    }
  }

  const carts = Array.from(cartRows.values());
  const cartIds = carts.map((cart) => cart.id);
  const [itemsByCart, deliveriesByCart, eventsByCart] = await Promise.all([
    fetchSalesCartItems(cartIds),
    fetchSalesDeliveries(cartIds),
    fetchSalesEvents(cartIds),
  ]);

  const salesOrders = carts.map((cart) =>
    toUnifiedSalesOrder(
      cart,
      itemsByCart.get(cart.id) || [],
      deliveriesByCart.get(cart.id) || [],
      eventsByCart.get(cart.id) || [],
    ),
  );

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

async function getOrderByKey(guildId, orderKey, options = {}) {
  const parsed = decodeOrderKey(orderKey);
  if (!parsed) return null;

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

function evaluateRefundEligibility(order, settings, context = {}) {
  const purchaseDate = resolvePurchaseDate(order);
  const purchaseMs = purchaseDate ? Date.parse(purchaseDate) : Number.NaN;
  const refundDays = Math.max(0, Number(settings.refundLimitDays || DEFAULT_REFUND_DAYS));
  const deadlineMs = Number.isFinite(purchaseMs)
    ? purchaseMs + refundDays * 24 * 60 * 60 * 1000
    : Number.NaN;
  const insideWindow = Number.isFinite(deadlineMs) ? Date.now() <= deadlineMs : false;
  const status = String(order.status || "").toLowerCase();
  const providerStatus = String(order.providerStatus || "").toLowerCase();
  const providerDetail = String(order.providerStatusDetail || "").toLowerCase();
  const alreadyRefunded =
    status === "refunded" ||
    providerStatus === "refunded" ||
    providerStatus === "charged_back" ||
    providerDetail.includes("refund") ||
    providerDetail.includes("chargeback") ||
    providerDetail.includes("reembols");
  const paid =
    order.source === "sales"
      ? ["paid", "delivered", "delivery_failed"].includes(status)
      : ["approved", "settled"].includes(status) || providerStatus === "approved";
  const hasProviderPayment = Boolean(order.providerPaymentId);
  const ownershipOk =
    context.authUserId && order.authUserId
      ? Number(context.authUserId) === Number(order.authUserId)
      : order.source === "sales" && context.discordUserId && order.discordUserId === context.discordUserId;
  const deliveredOrConsumed =
    order.source === "sales" &&
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
  if (order.source !== "sales") reasons.push("payment_order_requires_financial_review");

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
  if (order.source !== "sales") riskScore += 20;
  riskScore = Math.min(100, riskScore);

  const validationsComplete =
    Boolean(context.authUserId) &&
    ownershipOk &&
    Boolean(purchaseDate) &&
    Boolean(order.status) &&
    hasProviderPayment;
  const eligible =
    validationsComplete &&
    paid &&
    hasProviderPayment &&
    insideWindow &&
    !alreadyRefunded &&
    riskScore < 35;
  const manualRequired =
    !eligible ||
    settings.manualApprovalRequired ||
    riskScore > 15 ||
    deliveredOrConsumed ||
    order.source !== "sales";

  return {
    eligible,
    canAutoRefund:
      eligible &&
      settings.autoProcessEnabled &&
      !settings.manualApprovalRequired &&
      !manualRequired &&
      order.source === "sales",
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
    signal: AbortSignal.timeout?.(20_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || `Falha HTTP ${response.status} ao reembolsar.`);
  }
  return payload;
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

async function sendManualApprovalRequest({ client, ticket, order, settings, reason, eligibility }) {
  const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
  const channel = settings.approvalChannelId
    ? await guild?.channels.fetch(settings.approvalChannelId).catch(() => null)
    : null;
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Canal de aprovacao de reembolso nao configurado ou inacessivel.");
  }

  const embed = new EmbedBuilder()
    .setTitle("Solicitacao de reembolso")
    .setColor(eligibility.eligible ? 0xf1c40f : 0xdb4646)
    .addFields(
      {
        name: "Ticket",
        value: `${ticket.protocol || ticket.id}\n<#${ticket.channel_id}>`,
        inline: true,
      },
      { name: "Usuario", value: `<@${ticket.user_id}>`, inline: true },
      {
        name: "Compra",
        value: `${order.productTitle}\n${formatMoney(order.amount, order.currency)} | ${formatDate(resolvePurchaseDate(order))}`,
        inline: false,
      },
      {
        name: "Pedido",
        value:
          order.source === "payment"
            ? `#${order.raw?.order_number || order.id} (${order.key})`
            : `\`${order.id}\``,
        inline: true,
      },
      {
        name: "Pagamento",
        value: order.providerPaymentId ? `\`${order.providerPaymentId}\`` : "Nao informado",
        inline: true,
      },
      {
        name: "Validacao",
        value: summarizeEligibilityForStaff(eligibility),
        inline: false,
      },
      {
        name: "Motivo",
        value: normalizeText(reason || "Solicitado pelo comprador no ticket.", 900),
        inline: false,
      },
    )
    .setTimestamp(new Date());

  await channel.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${REFUND_PREFIX}approve:${ticket.id}:${order.key}`)
          .setLabel("Aprovar")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${REFUND_PREFIX}deny:${ticket.id}:${order.key}`)
          .setLabel("Negar")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { parse: [], users: [ticket.user_id], roles: [] },
  });
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

async function handleRefundOrVerificationMessage({ message, client, ticket, runtime, historyRows, content, persist }) {
  let state = buildRefundMemoryPatch(content, historyRows);
  const active = isActiveRefundState(readRefundMemory(historyRows));
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

  if (!state.intent && !currentIntent && !(active && orderCandidates.length)) return false;

  const changeAccount = isChangeAccountIntent(content);

  if (["manual_review", "completed"].includes(state.stage)) {
    if (!currentIntent) return false;
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

  if (changeAccount) {
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

  if (state.stage === "selecting_order" && !orderCandidates.length) {
    if (shouldPrompt(state, "select_pending", REFUND_PROMPT_COOLDOWN_MS)) {
      state = markPrompt(state, "select_pending");
      await persistRefundState(persist, state);
      await message.reply({
        content:
          "Eu ja encontrei opcoes compativeis. Selecione a compra no menu acima ou use Cancelar para procurar outro pedido.",
        allowedMentions: { parse: [] },
      });
    }
    return true;
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
    } else {
      await persistRefundState(persist, state, { stage: "awaiting_order" });
    }
    return true;
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

  state = sanitizeRefundState({
    ...state,
    stage: orders.length ? "selecting_order" : "lookup_failed",
    orderCandidates: [...new Set([...orderCandidates, ...state.orderCandidates])].slice(0, 8),
    failedOrderCandidates: orders.length
      ? state.failedOrderCandidates
      : [...new Set([...(state.failedOrderCandidates || []), ...orderCandidates])].slice(0, 12),
    availableOrderKeys: orders.map((order) => order.key),
    lookupCount: Number(state.lookupCount || 0) + 1,
    lastLookupAt: nowIso(),
  });
  await persistRefundState(persist, state);

  if (!orders.length) {
    await message.channel.send({
      content:
        "Nao encontrei uma compra compativel com esse numero na conta vinculada. Confira o pedido ou envie outro numero; se a compra estiver em outra conta, refaca o Login com a conta correta.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  await message.channel.send(buildOrderSelectionMessage(ticket, orders));
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
    await logRefundAuditEvent({
      ticket,
      eventType: "selection_cancelled",
      outcome: "user_cancelled",
    });
    return true;
  }

  if (action === "select") {
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({
        content: "Somente o comprador deste ticket pode selecionar a compra.",
        ephemeral: true,
      });
      return true;
    }

    const authUser = await getAuthUserByDiscordUserId(ticket.user_id);
    if (!authUser) {
      await interaction.reply({
        content: "A conta Discord ainda nao esta vinculada. Use o botao de Login antes de confirmar a compra.",
        ephemeral: true,
      });
      return true;
    }

    const selectedOrderKey = interaction.values?.[0];
    const order = await getOrderByKey(ticket.guild_id, selectedOrderKey, {
      authUserId: authUser.id,
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
      const accountViolations = await fetchActiveAccountViolations(authUser.id);
      const eligibility = evaluateRefundEligibility(order, settings, {
        authUserId: authUser.id,
        discordUserId: ticket.user_id,
        accountViolations,
      });
      await logRefundAuditEvent({
        ticket,
        authUserId: authUser.id,
        orderKey: order.key,
        riskScore: eligibility.riskScore,
        eventType: "order_selected",
        outcome: eligibility.canAutoRefund ? "auto_candidate" : "manual_review",
        metadata: {
          source: order.source,
          reasons: eligibility.reasons,
          activeViolationCount: accountViolations.length,
        },
      });

      if (eligibility.canAutoRefund) {
        await interaction.update(
          v2Message([
            {
              type: COMPONENT_TYPE.CONTAINER,
              accent_color: 0x8fdbff,
              components: [
                textDisplay("Compra confirmada. O reembolso esta sendo processado automaticamente agora."),
              ],
            },
          ]),
        );
        await callInternalSalesRefund(
          order.id,
          ticket.guild_id,
          "Solicitacao validada automaticamente pelo FlowAI no ticket.",
        );
        await interaction.followUp({
          content: `${settings.successMessage}\n\nCompra: ${order.productTitle}\nValor: ${formatMoney(order.amount, order.currency)}\nPrazo estimado: o estorno normalmente segue o prazo do Mercado Pago e do banco emissor.`,
          allowedMentions: { parse: [] },
        });
        await logRefundAuditEvent({
          ticket,
          authUserId: authUser.id,
          orderKey: order.key,
          riskScore: eligibility.riskScore,
          eventType: "refund_processed",
          outcome: "success",
        });
        return true;
      }

      await sendManualApprovalRequest({
        client,
        ticket,
        order,
        settings,
        reason: "Solicitacao confirmada pelo comprador via FlowAI.",
        eligibility,
      });
      await interaction.update(
        v2Message([
          {
            type: COMPONENT_TYPE.CONTAINER,
            accent_color: 0xf1c40f,
            components: [
              textDisplay(
                "Compra confirmada. A solicitacao foi enviada para analise da equipe responsavel. Assim que houver uma decisao, ela sera registrada por aqui.",
              ),
            ],
          },
        ]),
      );
      return true;
    } finally {
      pendingRefundActions.delete(lockKey);
    }
  }

  if (action === "approve" || action === "deny") {
    if (!hasRefundApprovalPermission(interaction.member, settings, runtime)) {
      await interaction.reply({
        content: "Voce nao tem permissao para decidir este reembolso.",
        ephemeral: true,
      });
      return true;
    }
    const order = await getOrderByKey(ticket.guild_id, orderKeyFromId);
    if (!order) {
      await interaction.reply({
        content: "Compra nao encontrada para esta decisao.",
        ephemeral: true,
      });
      return true;
    }

    if (action === "deny") {
      await interaction.update({
        content: `Reembolso negado por <@${interaction.user.id}> para a compra ${order.productTitle}.`,
        embeds: interaction.message.embeds,
        components: [],
        allowedMentions: { parse: [] },
      });
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      await channel?.send?.({
        content:
          "A equipe analisou a solicitacao de reembolso e ela foi negada neste momento. Caso precise de mais detalhes, responda neste ticket.",
        allowedMentions: { parse: [] },
      });
      await logRefundAuditEvent({
        ticket,
        orderKey: order.key,
        eventType: "manual_refund_denied",
        outcome: "denied",
        metadata: { decidedBy: interaction.user.id },
      });
      return true;
    }

    if (order.source !== "sales") {
      await interaction.reply({
        content:
          "Este pedido pertence ao financeiro da plataforma e precisa ser reembolsado pelo painel administrativo de pagamentos.",
        ephemeral: true,
      });
      return true;
    }

    const lockKey = `${ticket.id}:${order.key}`;
    if (pendingRefundActions.has(lockKey)) {
      await interaction.reply({
        content: "Este reembolso ja esta sendo processado.",
        ephemeral: true,
      });
      return true;
    }
    pendingRefundActions.add(lockKey);
    try {
      await interaction.deferUpdate();
      await callInternalSalesRefund(order.id, ticket.guild_id, `Aprovado manualmente por ${interaction.user.id}.`);
      await interaction.editReply({
        content: `Reembolso aprovado e processado por <@${interaction.user.id}> para a compra ${order.productTitle}.`,
        embeds: interaction.message.embeds,
        components: [],
        allowedMentions: { parse: [] },
      });
      const channel = await client.channels.fetch(ticket.channel_id).catch(() => null);
      await channel?.send?.({
        content: `${settings.successMessage}\n\nCompra: ${order.productTitle}\nValor: ${formatMoney(order.amount, order.currency)}\nPrazo estimado: o estorno normalmente segue o prazo do Mercado Pago e do banco emissor.`,
        allowedMentions: { parse: [] },
      });
      await logRefundAuditEvent({
        ticket,
        orderKey: order.key,
        eventType: "manual_refund_approved",
        outcome: "processed",
        metadata: { decidedBy: interaction.user.id },
      });
      return true;
    } catch (error) {
      await interaction.followUp({
        content: `Nao consegui processar automaticamente: ${normalizeText(error.message, 300)}`,
        ephemeral: true,
      });
      await logRefundAuditEvent({
        ticket,
        orderKey: order.key,
        eventType: "manual_refund_process_failed",
        outcome: "error",
        metadata: { message: normalizeText(error.message, 300), decidedBy: interaction.user.id },
      });
      return true;
    } finally {
      pendingRefundActions.delete(lockKey);
    }
  }

  return false;
}

function isTicketRefundInteraction(interaction) {
  return (
    (interaction.isButton?.() || interaction.isStringSelectMenu?.()) &&
    String(interaction.customId || "").startsWith(REFUND_PREFIX)
  );
}

module.exports = {
  buildRefundMemoryPatch,
  handleRefundOrVerificationMessage,
  handleTicketRefundInteraction,
  isTicketRefundInteraction,
};
