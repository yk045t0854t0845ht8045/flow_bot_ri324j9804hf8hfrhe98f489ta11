const { MessageFlags, SeparatorSpacingSize } = require("discord.js");
const { env } = require("../config/env");
const {
  createTicketAiMessage,
  getGuildTicketRuntime,
  getOpenTicketByChannel,
  getRecentTicketAiMessages,
  getTicketAiSession,
  upsertTicketAiSession,
} = require("./supabaseService");
const { canClaimTicket, canCloseTicket } = require("../utils/staff");

const MAX_TICKET_AI_MESSAGES = 12;
const MAX_TICKET_AI_CONTENT = 1800;
const MAX_TICKET_LOG_TEXT = 3200;
const IN_FLIGHT_NOTICE_TTL_MS = 1000 * 12;
const TICKET_COOLDOWN_MS = 1200;
const STAFF_HANDOFF_STALE_MS = 1000 * 60 * 20;
const CLAIM_HANDOFF_STALE_MS = 1000 * 60 * 45;
const TICKET_IDLE_RESUME_MS = 1000 * 60 * 18;

const COMPONENT_TYPE = {
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  CONTAINER: 17,
};

const inFlightTicketChannels = new Set();
const processingNoticeStore = new Map();
const lastTicketReplyByKey = new Map();
const unavailableModelCache = new Map();

const HUMAN_HANDOFF_HINTS = [
  "atendente",
  "humano",
  "suporte humano",
  "quero falar com atendente",
  "quero um atendente",
  "me chama um atendente",
  "me passa para um atendente",
  "me transfere",
  "me redireciona",
];

const STRESS_HINTS = [
  "estress",
  "irrit",
  "raiva",
  "nervos",
  "chatead",
  "horrivel",
  "ridicul",
  "lixo",
  "merda",
  "porra",
  "caralho",
  "urgente",
  "agora",
  "imediat",
];

const SENSITIVE_TICKET_HINTS = [
  "pagamento",
  "reembolso",
  "estorno",
  "cobranca",
  "chargeback",
  "licenca",
  "plano",
  "cancelamento",
  "parceria",
  "parceiro",
  "ban",
  "denuncia",
  "abuso",
  "moderacao",
  "financeiro",
];

const TICKET_AI_SYSTEM_PROMPT = [
  "Voce e o Flowdesk AI dentro de um ticket privado no Discord.",
  "Atenda em PT-BR com tom profissional, humano, acolhedor e objetivo.",
  "Fale como um atendimento premium: natural, seguro e sem soar robotico.",
  "Tenha calor humano e carisma leve, mas sem perder clareza.",
  "Seu papel e tentar resolver duvidas operacionais e orientar o usuario com base no contexto real do servidor.",
  "Mostre que voce leu o motivo e o historico do ticket antes de responder.",
  "Evite repetir que voce e IA ou usar frases frias e mecanicas.",
  "Prefira conversar como gente: responda de forma curta, clara e util.",
  "Nao repita o motivo do ticket em outras palavras se ele ja estiver claro.",
  "Se o motivo estiver coerente, comece ajudando direto em vez de pedir as mesmas informacoes de novo.",
  "So faca pergunta complementar quando ela for realmente necessaria para destravar o atendimento.",
  "Nunca gere scripts, codigos ou blocos de codigo.",
  "Use Markdown do Discord apenas quando ajudar na leitura e sem exagero.",
  "Se o caso exigir acao humana, acesso interno, decisao comercial, moderacao, pagamento sensivel ou se o usuario estiver irritado e pedir atendimento humano, comece a resposta com HANDOFF: e explique brevemente que um atendente assumira.",
  "Nao pergunte de novo o motivo principal se ele ja estiver informado no contexto do ticket; use esse motivo para aprofundar o atendimento.",
  "Se o ticket for sobre painel, logs, staff, cargo, categoria ou transcript, use o contexto real do servidor para orientar com precisao.",
  "Nao invente configuracoes, cargos, canais ou promessas inexistentes.",
].join(" ");

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMostRecentTimestampMs(...values) {
  return values.reduce((highest, value) => {
    return Math.max(highest, parseTimestampMs(value));
  }, 0);
}

function normalizeText(value, maxLength = MAX_TICKET_AI_CONTENT) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeIntentText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeForLog(value, maxLength = MAX_TICKET_LOG_TEXT) {
  return normalizeText(value, maxLength).replace(/```/g, "'''");
}

function inlineMemoryText(value, maxLength = 220) {
  return normalizeText(value, maxLength).replace(/\n+/g, " / ");
}

function isOfficialTicketGuild(guildId) {
  return guildId === env.officialSupportGuildId;
}

function includesAny(text, hints) {
  return hints.some((hint) => text.includes(hint));
}

function isStaleTimestamp(value, ttlMs) {
  const timestampMs = parseTimestampMs(value);
  if (!timestampMs) return true;
  return nowMs() - timestampMs >= ttlMs;
}

function formatElapsedWindow(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "algum tempo";
  }

  const minutes = Math.max(1, Math.round(ms / (1000 * 60)));
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} h`;
}

function buildTicketToneGuidance(ticket, historyRows) {
  const sourceText = normalizeIntentText([
    ticket?.opened_reason || "",
    ...(Array.isArray(historyRows)
      ? historyRows
          .slice(-4)
          .filter((row) => row?.author_type === "user")
          .map((row) => row.content || "")
      : []),
  ].join(" "));

  if (includesAny(sourceText, SENSITIVE_TICKET_HINTS)) {
    return [
      "Assunto sensivel detectado no ticket.",
      "Use tom mais profissional, sobrio e cuidadoso.",
      "Evite excesso de entusiasmo e foque em seguranca, clareza e direcionamento.",
    ].join(" ");
  }

  return [
    "Assunto geral de suporte detectado.",
    "Pode soar mais humano, proximo e acolhedor, com leve carisma de comunidade.",
    "Ainda assim, mantenha resposta curta, clara e util.",
  ].join(" ");
}

function buildTicketResumeState(session, ticket) {
  const lastConversationMs = getMostRecentTimestampMs(
    session?.last_user_message_at,
    session?.last_ai_reply_at,
    session?.last_staff_message_at,
  );
  const idleGapMs = lastConversationMs ? nowMs() - lastConversationMs : 0;
  const claimAnchor = session?.last_staff_message_at || ticket?.claimed_at || session?.handed_off_at;

  return {
    idleGapMs,
    idleResume: idleGapMs >= TICKET_IDLE_RESUME_MS,
    staleStaffHandoff:
      session?.status === "handoff" &&
      session?.handoff_reason === "staff_joined" &&
      isStaleTimestamp(
        session?.last_staff_message_at || session?.handed_off_at,
        STAFF_HANDOFF_STALE_MS,
      ),
    staleClaimHandoff:
      Boolean(ticket?.claimed_by) &&
      isStaleTimestamp(claimAnchor, CLAIM_HANDOFF_STALE_MS),
  };
}

function buildTicketMemorySnapshot(ticket, historyRows) {
  const rows = Array.isArray(historyRows) ? historyRows : [];
  const recentRows = rows.slice(-8);
  const userMessages = recentRows
    .filter((row) => row?.author_type === "user")
    .slice(-3)
    .map((row) => inlineMemoryText(row.content, 220))
    .filter(Boolean);
  const lastAssistant = [...recentRows]
    .reverse()
    .find((row) => row?.author_type === "assistant");
  const lastStaff = [...recentRows]
    .reverse()
    .find((row) => row?.author_type === "staff");

  const sections = [];

  if (ticket?.opened_reason) {
    sections.push(`Motivo inicial do ticket: ${inlineMemoryText(ticket.opened_reason, 220)}`);
  }

  if (userMessages.length) {
    sections.push(
      [
        "Ultimos pontos trazidos pelo usuario:",
        ...userMessages.map((message) => `- ${message}`),
      ].join("\n"),
    );
  }

  if (lastAssistant?.content) {
    sections.push(`Ultima orientacao da IA: ${inlineMemoryText(lastAssistant.content, 220)}`);
  }

  if (lastStaff?.content) {
    sections.push(`Ultima mensagem humana da equipe: ${inlineMemoryText(lastStaff.content, 200)}`);
  }

  return sections.join("\n\n").slice(0, 1300);
}

function buildTicketResumeGuidance(resumeState) {
  if (!resumeState) return "";

  const guidance = [];

  if (resumeState.idleResume) {
    guidance.push(
      `A conversa foi retomada depois de cerca de ${formatElapsedWindow(resumeState.idleGapMs)}. Retome do ponto em que parou e nao peca para repetir todo o contexto.`,
    );
  }

  if (resumeState.staleStaffHandoff || resumeState.staleClaimHandoff) {
    guidance.push(
      "Voce esta reassumindo o atendimento de forma discreta porque nao houve continuidade humana recente. Avise isso com uma frase curta e siga direto ajudando.",
    );
  }

  return guidance.join(" ");
}

function buildTicketResumeLeadIn(resumeState) {
  if (!resumeState) return "";

  if (resumeState.staleClaimHandoff || resumeState.staleStaffHandoff) {
    return "Vou seguir com voce por aqui.";
  }

  return "";
}

function applyTicketResumeLeadIn(content, resumeState) {
  const leadIn = buildTicketResumeLeadIn(resumeState);
  if (!leadIn || !content) {
    return content;
  }

  const normalized = normalizeIntentText(content);
  if (
    normalized.startsWith("vou seguir com voce por aqui") ||
    normalized.startsWith("vou seguir com voce") ||
    normalized.startsWith("vou retomar")
  ) {
    return content;
  }

  return `${leadIn}\n\n${content}`;
}

function buildTicketReplyKey(ticketId, userId) {
  return `${ticketId}:${userId}`;
}

function canReplyInTicket(ticketId, userId) {
  const lastAt = lastTicketReplyByKey.get(buildTicketReplyKey(ticketId, userId)) || 0;
  return nowMs() - lastAt >= TICKET_COOLDOWN_MS;
}

function markTicketReply(ticketId, userId) {
  lastTicketReplyByKey.set(buildTicketReplyKey(ticketId, userId), nowMs());
}

function cleanupProcessingNotices() {
  const cutoff = nowMs() - IN_FLIGHT_NOTICE_TTL_MS;
  for (const [key, value] of processingNoticeStore.entries()) {
    if (value < cutoff) {
      processingNoticeStore.delete(key);
    }
  }
}

async function sendProcessingNotice(channel, channelId) {
  cleanupProcessingNotices();
  const lastAt = processingNoticeStore.get(channelId) || 0;
  if (nowMs() - lastAt < IN_FLIGHT_NOTICE_TTL_MS) {
    return;
  }

  processingNoticeStore.set(channelId, nowMs());
  await channel.send({
    content: "Estou analisando a sua ultima mensagem. Me mande a proxima em alguns segundos.",
    allowedMentions: { parse: [], roles: [], users: [] },
  }).catch(() => null);
}

function isModelAccessError(status, rawText) {
  let payload = null;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = null;
  }

  const message = String(payload?.error?.message || rawText || "").toLowerCase();
  const code = String(payload?.error?.code || "").toLowerCase();

  return (
    status === 403 ||
    code === "model_not_found" ||
    message.includes("does not have access to model") ||
    message.includes("model_not_found")
  );
}

function buildModelCandidates() {
  return [...new Set([
    env.openaiModel,
    ...env.openaiModelFallbacks,
    "gpt-4o-mini",
  ].filter(Boolean))];
}

async function callOpenAI(messages, userId) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY nao configurada.");
  }

  let lastError = null;

  for (const model of buildModelCandidates()) {
    const blockedUntil = unavailableModelCache.get(model) || 0;
    if (blockedUntil > nowMs()) {
      continue;
    }

    const response = await fetch(`${env.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.35,
        max_tokens: 420,
        user: String(userId || "").slice(0, 64) || undefined,
      }),
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      lastError = new Error(
        `Falha ao chamar OpenAI com ${model}: ${response.status} ${response.statusText} ${rawText}`,
      );

      if (isModelAccessError(response.status, rawText)) {
        unavailableModelCache.set(model, nowMs() + 1000 * 60 * 30);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        continue;
      }

      throw lastError;
    }

    let data = null;
    try {
      data = JSON.parse(rawText);
    } catch (error) {
      lastError = new Error(
        `Resposta invalida da OpenAI com ${model}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const content = normalizeText(data?.choices?.[0]?.message?.content || "", 3500);
    if (!content) {
      lastError = new Error(`Resposta vazia da OpenAI com ${model}.`);
      continue;
    }

    unavailableModelCache.delete(model);
    return { content, model };
  }

  throw lastError || new Error("Nenhum modelo disponivel respondeu no ticket.");
}

function formatChannel(channelId) {
  return channelId ? `<#${channelId}>` : "nao configurado";
}

function formatRole(roleId) {
  return roleId ? `<@&${roleId}>` : "nao configurado";
}

function formatRoleList(roleIds) {
  if (!Array.isArray(roleIds) || !roleIds.length) return "nao configurado";
  return roleIds.map((roleId) => `<@&${roleId}>`).join(", ");
}

function buildTicketServerContext(runtime, ticket) {
  const settings = runtime?.settings || null;
  const staffSettings = runtime?.staffSettings || null;

  return [
    `Guild: ${ticket.guild_id}`,
    `Canal do ticket: ${ticket.channel_id}`,
    ticket.opened_reason ? `Motivo de abertura informado pelo usuario: ${ticket.opened_reason}` : "",
    settings
      ? [
          "Configuracao de ticket:",
          `- Canal do painel: ${formatChannel(settings.menu_channel_id)}`,
          `- Categoria: ${formatChannel(settings.tickets_category_id)}`,
          `- Log de criacao: ${formatChannel(settings.logs_created_channel_id)}`,
          `- Log de fechamento: ${formatChannel(settings.logs_closed_channel_id)}`,
          `- Botao do painel: ${settings.panel_button_label || "Abrir ticket"}`,
          `- Titulo do painel: ${settings.panel_title || env.panelTitle}`,
        ].join("\n")
      : "",
    staffSettings
      ? [
          "Configuracao de staff:",
          `- Admin: ${formatRole(staffSettings.admin_role_id)}`,
          `- Pode assumir: ${formatRoleList(staffSettings.claim_role_ids)}`,
          `- Pode fechar: ${formatRoleList(staffSettings.close_role_ids)}`,
          `- Notificados: ${formatRoleList(staffSettings.notify_role_ids)}`,
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 2200);
}

function extractMessageContent(message) {
  const base = normalizeText(message.content || "", 1400);
  const attachmentNames = Array.from(message.attachments?.values?.() || [])
    .map((attachment) => attachment.name || attachment.url || "arquivo")
    .slice(0, 4);

  if (!attachmentNames.length) {
    return base;
  }

  const attachmentLine = `Anexos: ${attachmentNames.join(", ")}`;
  return [base, attachmentLine].filter(Boolean).join("\n");
}

function isSupportStaffMessage(message, runtime) {
  return Boolean(
    message.member &&
      (canClaimTicket(message.member, runtime?.staffSettings) ||
        canCloseTicket(message.member, runtime?.staffSettings))
  );
}

function shouldHandoffByUserMessage(content) {
  const normalized = normalizeIntentText(content);
  return (
    includesAny(normalized, HUMAN_HANDOFF_HINTS) ||
    includesAny(normalized, STRESS_HINTS)
  );
}

async function safeGetTicketAiSession(ticketId) {
  return await getTicketAiSession(ticketId).catch((error) => {
    console.error("[ticket-ai] falha ao carregar sessao:", error);
    return null;
  });
}

async function safeUpsertTicketAiSession(input) {
  return await upsertTicketAiSession(input).catch((error) => {
    console.error("[ticket-ai] falha ao salvar sessao:", error);
    return {
      ticket_id: input.ticketId,
      protocol: input.protocol,
      guild_id: input.guildId,
      channel_id: input.channelId,
      user_id: input.userId,
      status: input.status || "active",
      handoff_reason: input.handoffReason || null,
      handed_off_by: input.handedOffBy || null,
      handed_off_at: input.handedOffAt || null,
      last_ai_reply_at: input.lastAiReplyAt || null,
      last_user_message_at: input.lastUserMessageAt || null,
      last_staff_message_at: input.lastStaffMessageAt || null,
    };
  });
}

async function ensureTicketAiSession(ticket) {
  const existing = await safeGetTicketAiSession(ticket.id);
  if (existing) return existing;

  return await safeUpsertTicketAiSession({
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    userId: ticket.user_id,
    status: "active",
  });
}

async function persistTicketAiMessage(ticket, input) {
  const content = normalizeText(input.content || "", 3500);
  if (!content) return null;

  return await createTicketAiMessage({
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    authorId: input.authorId || null,
    authorType: input.authorType,
    source: input.source || "ticket_ai",
    content,
    metadata: input.metadata || {},
  }).catch((error) => {
    console.error("[ticket-ai] falha ao persistir mensagem:", error);
    return null;
  });
}

function buildTicketLogPayload({ ticket, userId, prompt, response, source, model, status }) {
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
              "### Pergunta do ticket",
              sanitizeForLog(prompt) || "Pergunta vazia",
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
              `-# Usuario: <@${userId || ticket.user_id}>`,
              `-# Canal: <#${ticket.channel_id}>`,
              `-# Protocolo: \`${ticket.protocol}\``,
              `-# Origem: \`${source}\``,
              `-# Em: <t:${timestamp}:F>`,
            ].join("\n"),
          },
        ],
      },
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: status === "handoff" ? 0xf1c40f : 0x2ecc71,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              "### Resposta da IA",
              sanitizeForLog(response) || "Resposta vazia",
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
              `-# Status: \`${status || "active"}\``,
              `-# Guild: \`${ticket.guild_id}\``,
            ].join("\n"),
          },
        ],
      },
    ],
  };
}

async function sendTicketAiInteractionLog(client, payload) {
  try {
    if (!client?.channels?.fetch || !env.aiMentionLogChannelId) return;

    const logChannel = await client.channels.fetch(env.aiMentionLogChannelId).catch(() => null);
    if (!logChannel || typeof logChannel.send !== "function") {
      return;
    }

    await logChannel.send(buildTicketLogPayload(payload));
  } catch (error) {
    console.error("[ticket-ai-log] falha ao registrar conversa:", error);
  }
}

function splitDiscordMessage(content) {
  const clean = normalizeText(content, 6000);
  if (!clean) return [];
  if (clean.length <= MAX_TICKET_AI_CONTENT) return [clean];

  const chunks = [];
  let remaining = clean;

  while (remaining.length > MAX_TICKET_AI_CONTENT) {
    let splitAt = remaining.lastIndexOf("\n\n", MAX_TICKET_AI_CONTENT);
    if (splitAt < 500) {
      splitAt = remaining.lastIndexOf("\n", MAX_TICKET_AI_CONTENT);
    }
    if (splitAt < 500) {
      splitAt = remaining.lastIndexOf(" ", MAX_TICKET_AI_CONTENT);
    }
    if (splitAt < 500) {
      splitAt = MAX_TICKET_AI_CONTENT;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

async function replyToTicketMessage(message, content) {
  const chunks = splitDiscordMessage(content);
  if (!chunks.length) return;

  const [firstChunk, ...restChunks] = chunks;
  try {
    await message.reply({
      content: firstChunk,
      allowedMentions: {
        repliedUser: false,
        parse: [],
        roles: [],
        users: [],
      },
    });
  } catch (error) {
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

async function sendTicketChannelMessage(channel, content, mentionUserId = null) {
  if (!channel || typeof channel.send !== "function") return;

  const chunks = splitDiscordMessage(content);
  if (!chunks.length) return;

  const [firstChunk, ...restChunks] = chunks;
  const firstContent = mentionUserId ? `<@${mentionUserId}> ${firstChunk}` : firstChunk;

  await channel.send({
    content: firstContent,
    allowedMentions: {
      parse: [],
      roles: [],
      users: mentionUserId ? [mentionUserId] : [],
    },
  });

  for (const chunk of restChunks) {
    await channel.send({
      content: chunk,
      allowedMentions: { parse: [], roles: [], users: [] },
    });
  }
}

function sanitizeAssistantReply(content) {
  const clean = normalizeText(content, 3500);
  if (!clean) {
    return "";
  }

  if (clean.includes("```")) {
    return [
      "Posso te orientar sem enviar codigo por aqui.",
      "",
      "Me diga exatamente onde voce travou que eu explico os passos em linguagem simples.",
    ].join("\n");
  }

  return clean;
}

function parseAssistantOutcome(content) {
  const clean = sanitizeAssistantReply(content);
  if (!clean) {
    return { content: "", handoff: false };
  }

  if (/^handoff\s*:/i.test(clean)) {
    return {
      content: clean.replace(/^handoff\s*:/i, "").trim(),
      handoff: true,
    };
  }

  return { content: clean, handoff: false };
}

function buildInitialReasonGuidance(reason) {
  const normalized = normalizeIntentText(reason);

  if (!normalized) {
    return "Oi. Ja peguei seu ticket por aqui. Pode continuar que eu sigo te ajudando.";
  }

  if (
    normalized.includes("quero comprar") ||
    normalized.includes("tenho interesse") ||
    normalized.includes("quero adquirir")
  ) {
    return "Claro. Posso te ajudar com isso. Voce quer comprar, tirar uma duvida antes da compra ou entender como funciona?";
  }

  if (normalized.includes("reembolso") || normalized.includes("estorno")) {
    const hasPartner = normalized.includes("parceir");
    return [
      "Entendi.",
      "Sobre reembolso, isso normalmente segue com a equipe responsavel pela compra/licenca.",
      hasPartner
        ? "Sobre parceria, isso tambem entra no time responsavel. Se quiser adiantar, manda o email da compra e o link da sua comunidade/projeto."
        : "Se quiser adiantar, manda o email da compra ou o numero do pedido.",
    ].join(" ");
  }

  if (
    normalized.includes("embed") &&
    (normalized.includes("edit") || normalized.includes("salv") || normalized.includes("painel"))
  ) {
    return "Entendi. Se o embed do ticket nao esta salvando, normalmente o problema fica em algum campo invalido do embed ou na gravacao da configuracao. Se voce quiser, eu posso te guiar nisso aqui com voce.";
  }

  if (
    normalized.includes("ticket") &&
    (normalized.includes("abr") || normalized.includes("painel") || normalized.includes("salv"))
  ) {
    return "Entendi. Se o problema esta no fluxo de ticket ou no painel, eu consigo te orientar por etapa ate achar exatamente onde esta travando.";
  }

  if (normalized.includes("cargo") || normalized.includes("role")) {
    return "Entendi. Se isso envolve cargo, eu posso te ajudar a revisar a configuracao e o ponto exato em que ela para de funcionar.";
  }

  if (normalized.includes("transcript")) {
    return "Entendi. Se o problema e com transcript, eu posso te ajudar a verificar se a falha esta na geracao, no log ou na entrega do codigo.";
  }

  if (normalized.includes("pagamento") || normalized.includes("plano") || normalized.includes("licenca")) {
    return "Entendi. Se isso envolve pagamento, plano ou licenca, eu consigo te orientar no fluxo e separar rapido o que e ajuste tecnico e o que precisa da equipe responsavel.";
  }

  if (normalized.includes("parceir")) {
    return "Entendi. Sobre parceria, isso normalmente segue com o time responsavel. Se quiser adiantar, manda o link da sua comunidade ou projeto.";
  }

  if (
    normalized.includes("ajuda") ||
    normalized.includes("duvida") ||
    normalized.includes("dúvida")
  ) {
    return "Claro. Me manda o ponto principal que voce quer resolver primeiro e eu sigo com voce por aqui.";
  }

  return "Entendi. Pode me mandar mais um pouco de contexto que eu te ajudo a seguir por aqui.";
}

function buildTicketWelcomeMessage(ticket) {
  const reason = normalizeText(ticket.opened_reason || "", 500);
  return buildInitialReasonGuidance(reason);
}

function buildTicketRuleBasedReply(ticket, runtime, content) {
  const normalized = normalizeIntentText(content);

  if (
    normalized.includes("quero comprar") ||
    normalized.includes("tenho interesse") ||
    normalized.includes("quero adquirir")
  ) {
    return "Claro. Se for compra, me diz so se voce quer ajuda com plano, pagamento ou com o que cada opcao entrega.";
  }

  if (normalized.includes("reembolso") || normalized.includes("estorno")) {
    return "Certo. Para adiantar isso, me manda o email da compra ou o numero do pedido. Se tiver mais de um assunto no ticket, eu separo com voce por partes.";
  }

  if (normalized.includes("parceir")) {
    return "Beleza. Se for parceria, me manda o link da sua comunidade ou projeto e o que voce imagina para essa parceria.";
  }

  if (
    normalized.includes("ticket") &&
    (normalized.includes("painel") || normalized.includes("abrir") || normalized.includes("abre"))
  ) {
    const panelChannel = runtime?.settings?.menu_channel_id
      ? `<#${runtime.settings.menu_channel_id}>`
      : "o canal configurado de tickets";
    const buttonLabel = runtime?.settings?.panel_button_label || "Abrir ticket";

    return `Se a duvida for no fluxo de ticket, o painel principal fica em ${panelChannel} e o botao usado hoje e \`${buttonLabel}\`. Se quiser, eu posso te ajudar a revisar onde exatamente esta travando.`;
  }

  return null;
}

function buildHandoffReply(reason) {
  switch (reason) {
    case "user_requested_human":
      return [
        "Claro. Vou deixar este atendimento com um atendente humano para seguir com voce.",
        "",
        "Assim que a equipe assumir, ela continua com voce por aqui.",
      ].join("\n");
    case "staff_joined":
    case "ticket_claimed":
      return "Perfeito. A equipe assumiu este ticket e eu vou sair da conversa para nao atrapalhar o atendimento.";
    default:
      return [
        "Quero te ajudar da forma certa, mas neste caso faz mais sentido um atendente humano seguir com voce.",
        "",
        "Vou deixar o atendimento encaminhado para a equipe continuar por aqui.",
      ].join("\n");
  }
}

function canAutoResumeTicketAiSession(session, ticket) {
  const resumeState = buildTicketResumeState(session, ticket);

  if (!session || session.status !== "handoff") {
    return !ticket?.claimed_by || resumeState.staleClaimHandoff;
  }

  switch (session.handoff_reason) {
    case "ai_unavailable":
      return true;
    case "ticket_claimed":
      return resumeState.staleClaimHandoff;
    case "staff_joined":
      return resumeState.staleStaffHandoff || resumeState.staleClaimHandoff;
    default:
      return false;
  }
}

async function reactivateTicketAiSession(ticket, session, lastUserMessageAt) {
  return await safeUpsertTicketAiSession({
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    userId: ticket.user_id,
    status: "active",
    handoffReason: null,
    handedOffBy: null,
    handedOffAt: null,
    lastAiReplyAt: session?.last_ai_reply_at || null,
    lastUserMessageAt: lastUserMessageAt || session?.last_user_message_at || null,
    lastStaffMessageAt: session?.last_staff_message_at || null,
  });
}

function buildModelPromptMessages(ticket, runtime, historyRows, resumeState) {
  const promptMessages = [
    { role: "system", content: TICKET_AI_SYSTEM_PROMPT },
  ];

  const toneGuidance = buildTicketToneGuidance(ticket, historyRows);
  if (toneGuidance) {
    promptMessages.push({ role: "system", content: toneGuidance });
  }

  const resumeGuidance = buildTicketResumeGuidance(resumeState);
  if (resumeGuidance) {
    promptMessages.push({ role: "system", content: resumeGuidance });
  }

  const serverContext = buildTicketServerContext(runtime, ticket);
  if (serverContext) {
    promptMessages.push({
      role: "system",
      content: `Contexto real do ticket e do servidor:\n${serverContext}`,
    });
  }

  const memorySnapshot = buildTicketMemorySnapshot(ticket, historyRows);
  if (memorySnapshot) {
    promptMessages.push({
      role: "system",
      content: `Memoria curta do atendimento:\n${memorySnapshot}`,
    });
  }

  for (const row of historyRows) {
    const content = normalizeText(row.content || "", 1400);
    if (!content) continue;

    if (row.author_type === "user") {
      promptMessages.push({ role: "user", content });
      continue;
    }

    if (row.author_type === "assistant" || row.author_type === "system") {
      promptMessages.push({ role: "assistant", content });
    }
  }

  return promptMessages;
}

async function markTicketAiHandoff(ticket, options = {}) {
  const existing = await safeGetTicketAiSession(ticket.id);

  return await safeUpsertTicketAiSession({
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    userId: ticket.user_id,
    status: "handoff",
    handoffReason: options.handoffReason || existing?.handoff_reason || "human_handoff",
    handedOffBy: options.handedOffBy || existing?.handed_off_by || null,
    handedOffAt: options.handedOffAt || existing?.handed_off_at || nowIso(),
    lastAiReplyAt: options.lastAiReplyAt || existing?.last_ai_reply_at || null,
    lastUserMessageAt: options.lastUserMessageAt || existing?.last_user_message_at || null,
    lastStaffMessageAt: options.lastStaffMessageAt || existing?.last_staff_message_at || null,
  });
}

async function markTicketAiClosed(ticket, options = {}) {
  const existing = await safeGetTicketAiSession(ticket.id);

  return await safeUpsertTicketAiSession({
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    userId: ticket.user_id,
    status: "closed",
    handoffReason: existing?.handoff_reason || options.handoffReason || null,
    handedOffBy: existing?.handed_off_by || options.handedOffBy || null,
    handedOffAt: existing?.handed_off_at || options.handedOffAt || null,
    lastAiReplyAt: existing?.last_ai_reply_at || options.lastAiReplyAt || null,
    lastUserMessageAt: existing?.last_user_message_at || options.lastUserMessageAt || null,
    lastStaffMessageAt: existing?.last_staff_message_at || options.lastStaffMessageAt || null,
  });
}

async function maybeSendHandoffReply({ client, channel, ticket, reason, userId }) {
  const content = buildHandoffReply(reason);
  await sendTicketChannelMessage(channel, content, userId).catch(() => null);
  await persistTicketAiMessage(ticket, {
    authorId: client?.user?.id || null,
    authorType: "assistant",
    source: "ticket_ai_handoff",
    content,
    metadata: { reason },
  });
  await sendTicketAiInteractionLog(client, {
    ticket,
    userId,
    prompt: reason === "user_requested_human"
      ? "Usuario pediu atendimento humano ou demonstrou estresse"
      : "Fluxo redirecionado para atendimento humano",
    response: content,
    source: "ticket_ai_handoff",
    model: null,
    status: "handoff",
  });
  return content;
}

async function sendInitialTicketAiMessage(client, ticket) {
  if (!client?.user || !ticket || !isOfficialTicketGuild(ticket.guild_id)) {
    return false;
  }

  const existingSession = await ensureTicketAiSession(ticket);
  if (existingSession?.status === "handoff" || existingSession?.status === "closed") {
    return false;
  }

  if (existingSession?.last_ai_reply_at) {
    return false;
  }

  const guild = client.guilds.cache.get(ticket.guild_id) || await client.guilds.fetch(ticket.guild_id).catch(() => null);
  if (!guild) return false;

  const channel = guild.channels.cache.get(ticket.channel_id) || await guild.channels.fetch(ticket.channel_id).catch(() => null);
  if (!channel || typeof channel.send !== "function") return false;

  const content = buildTicketWelcomeMessage(ticket);

  await sendTicketChannelMessage(channel, content);
  await persistTicketAiMessage(ticket, {
    authorId: client.user.id,
    authorType: "assistant",
    source: "ticket_ai_welcome",
    content,
    metadata: {
      has_reason: Boolean(ticket.opened_reason),
    },
  });

  await safeUpsertTicketAiSession({
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    channelId: ticket.channel_id,
    userId: ticket.user_id,
    status: "active",
    lastAiReplyAt: nowIso(),
    lastUserMessageAt: existingSession?.last_user_message_at || null,
    lastStaffMessageAt: existingSession?.last_staff_message_at || null,
  });

  await sendTicketAiInteractionLog(client, {
    ticket,
    userId: ticket.user_id,
    prompt: ticket.opened_reason || "Boas-vindas automaticas do ticket",
    response: content,
    source: "ticket_ai_welcome",
    model: null,
    status: "active",
  });

  return true;
}

async function handleTicketAiMessage(message, client) {
  if (!client?.user || !message?.guildId || !message.channelId) {
    return false;
  }

  if (message.author?.bot || message.webhookId) {
    return false;
  }

  if (!isOfficialTicketGuild(message.guildId)) {
    return false;
  }

  const ticket = await getOpenTicketByChannel(message.guildId, message.channelId).catch(() => null);
  if (!ticket) {
    return false;
  }

  const runtime = await getGuildTicketRuntime(ticket.guild_id).catch(() => null);
  const content = extractMessageContent(message);
  const currentIso = nowIso();
  const session = await ensureTicketAiSession(ticket);
  const resumeState = buildTicketResumeState(session, ticket);

  if (message.author.id !== ticket.user_id) {
    if (isSupportStaffMessage(message, runtime)) {
      await persistTicketAiMessage(ticket, {
        authorId: message.author.id,
        authorType: "staff",
        source: "ticket_staff_message",
        content,
        metadata: { messageId: message.id },
      });

      await markTicketAiHandoff(ticket, {
        handoffReason: "staff_joined",
        handedOffBy: message.author.id,
        handedOffAt: currentIso,
        lastAiReplyAt: session?.last_ai_reply_at || null,
        lastUserMessageAt: session?.last_user_message_at || null,
        lastStaffMessageAt: currentIso,
      });
    }

    return true;
  }

  await persistTicketAiMessage(ticket, {
    authorId: message.author.id,
    authorType: "user",
    source: "ticket_user_message",
    content,
    metadata: {
      messageId: message.id,
      attachmentCount: message.attachments?.size || 0,
    },
  });

  if (session?.status === "closed") {
    await safeUpsertTicketAiSession({
      ticketId: ticket.id,
      protocol: ticket.protocol,
      guildId: ticket.guild_id,
      channelId: ticket.channel_id,
      userId: ticket.user_id,
      status: "closed",
      handoffReason: session.handoff_reason,
      handedOffBy: session.handed_off_by,
      handedOffAt: session.handed_off_at,
      lastAiReplyAt: session.last_ai_reply_at || null,
      lastUserMessageAt: currentIso,
      lastStaffMessageAt: session.last_staff_message_at || null,
    });
    return true;
  }

  if (session?.status === "handoff") {
    if (!canAutoResumeTicketAiSession(session, ticket)) {
      await safeUpsertTicketAiSession({
        ticketId: ticket.id,
        protocol: ticket.protocol,
        guildId: ticket.guild_id,
        channelId: ticket.channel_id,
        userId: ticket.user_id,
        status: "handoff",
        handoffReason: session.handoff_reason,
        handedOffBy: session.handed_off_by,
        handedOffAt: session.handed_off_at,
        lastAiReplyAt: session.last_ai_reply_at || null,
        lastUserMessageAt: currentIso,
        lastStaffMessageAt: session.last_staff_message_at || null,
      });
      return true;
    }

    await reactivateTicketAiSession(ticket, session, currentIso);
  }

  if (ticket.claimed_by && !(resumeState.staleClaimHandoff || resumeState.staleStaffHandoff)) {
    await markTicketAiHandoff(ticket, {
      handoffReason: "ticket_claimed",
      handedOffBy: ticket.claimed_by,
      handedOffAt: currentIso,
      lastAiReplyAt: session?.last_ai_reply_at || null,
      lastUserMessageAt: currentIso,
      lastStaffMessageAt: session?.last_staff_message_at || null,
    });
    return true;
  }

  if (!content) {
    await safeUpsertTicketAiSession({
      ticketId: ticket.id,
      protocol: ticket.protocol,
      guildId: ticket.guild_id,
      channelId: ticket.channel_id,
      userId: ticket.user_id,
      status: "active",
      lastAiReplyAt: session?.last_ai_reply_at || null,
      lastUserMessageAt: currentIso,
      lastStaffMessageAt: session?.last_staff_message_at || null,
    });
    return true;
  }

  if (shouldHandoffByUserMessage(content)) {
    await maybeSendHandoffReply({
      client,
      channel: message.channel,
      ticket,
      reason: "user_requested_human",
      userId: ticket.user_id,
    });
    await markTicketAiHandoff(ticket, {
      handoffReason: "user_requested_human",
      handedOffBy: message.author.id,
      handedOffAt: currentIso,
      lastAiReplyAt: session?.last_ai_reply_at || null,
      lastUserMessageAt: currentIso,
      lastStaffMessageAt: session?.last_staff_message_at || null,
    });
    return true;
  }

  if (!canReplyInTicket(ticket.id, message.author.id)) {
    return true;
  }

  if (inFlightTicketChannels.has(message.channelId)) {
    await sendProcessingNotice(message.channel, message.channelId);
    return true;
  }

  markTicketReply(ticket.id, message.author.id);
  inFlightTicketChannels.add(message.channelId);

  let typingInterval = null;

  try {
    await safeUpsertTicketAiSession({
      ticketId: ticket.id,
      protocol: ticket.protocol,
      guildId: ticket.guild_id,
      channelId: ticket.channel_id,
      userId: ticket.user_id,
      status: "active",
      lastAiReplyAt: session?.last_ai_reply_at || null,
      lastUserMessageAt: currentIso,
      lastStaffMessageAt: session?.last_staff_message_at || null,
    });

    const directReply = buildTicketRuleBasedReply(ticket, runtime, content);
    if (directReply) {
      const finalDirectReply = applyTicketResumeLeadIn(directReply, resumeState);

      await replyToTicketMessage(message, finalDirectReply);
      await persistTicketAiMessage(ticket, {
        authorId: client.user.id,
        authorType: "assistant",
        source: "ticket_ai_direct",
        content: finalDirectReply,
        metadata: {
          handoff_resume: Boolean(
            resumeState.staleClaimHandoff || resumeState.staleStaffHandoff,
          ),
        },
      });
      await safeUpsertTicketAiSession({
        ticketId: ticket.id,
        protocol: ticket.protocol,
        guildId: ticket.guild_id,
        channelId: ticket.channel_id,
        userId: ticket.user_id,
        status: "active",
        lastAiReplyAt: nowIso(),
        lastUserMessageAt: currentIso,
        lastStaffMessageAt: session?.last_staff_message_at || null,
      });
      await sendTicketAiInteractionLog(client, {
        ticket,
        userId: message.author.id,
        prompt: content,
        response: finalDirectReply,
        source: "ticket_ai_direct",
        model: null,
        status: "active",
      });
      return true;
    }

    await message.channel.sendTyping().catch(() => null);
    typingInterval = setInterval(() => {
      void message.channel.sendTyping().catch(() => null);
    }, 8000);

    const historyRows = await getRecentTicketAiMessages(ticket.id, MAX_TICKET_AI_MESSAGES).catch(() => []);
    const promptMessages = buildModelPromptMessages(ticket, runtime, historyRows, resumeState);
    const result = await callOpenAI(promptMessages, message.author.id);
    const parsed = parseAssistantOutcome(result.content);
    const finalReply = applyTicketResumeLeadIn(parsed.content, resumeState);

    if (!finalReply) {
      throw new Error("Resposta vazia apos sanitizacao.");
    }

    await replyToTicketMessage(message, finalReply);
    await persistTicketAiMessage(ticket, {
      authorId: client.user.id,
      authorType: "assistant",
      source: parsed.handoff ? "ticket_ai_handoff" : "ticket_ai_reply",
      content: finalReply,
      metadata: {
        model: result.model,
        handoff: parsed.handoff,
        handoff_resume: Boolean(
          resumeState.staleClaimHandoff || resumeState.staleStaffHandoff,
        ),
        idle_resume: Boolean(resumeState.idleResume),
      },
    });

    if (parsed.handoff) {
      await markTicketAiHandoff(ticket, {
        handoffReason: "ai_requested_handoff",
        handedOffBy: client.user.id,
        handedOffAt: nowIso(),
        lastAiReplyAt: nowIso(),
        lastUserMessageAt: currentIso,
        lastStaffMessageAt: session?.last_staff_message_at || null,
      });
    } else {
      await safeUpsertTicketAiSession({
        ticketId: ticket.id,
        protocol: ticket.protocol,
        guildId: ticket.guild_id,
        channelId: ticket.channel_id,
        userId: ticket.user_id,
        status: "active",
        lastAiReplyAt: nowIso(),
        lastUserMessageAt: currentIso,
        lastStaffMessageAt: session?.last_staff_message_at || null,
      });
    }

    await sendTicketAiInteractionLog(client, {
      ticket,
      userId: message.author.id,
      prompt: content,
      response: finalReply,
      source: parsed.handoff ? "ticket_ai_handoff" : "ticket_ai_reply",
      model: result.model,
      status: parsed.handoff ? "handoff" : "active",
    });

    return true;
  } catch (error) {
    console.error("[ticket-ai] falha ao responder ticket:", error);
    const handoffReply = buildHandoffReply("ai_unavailable");

    await replyToTicketMessage(message, handoffReply).catch(() => null);
    await persistTicketAiMessage(ticket, {
      authorId: client.user.id,
      authorType: "assistant",
      source: "ticket_ai_handoff",
      content: handoffReply,
      metadata: {
        reason: "ai_unavailable",
        error: error instanceof Error ? error.message : String(error),
      },
    });

    await markTicketAiHandoff(ticket, {
      handoffReason: "ai_unavailable",
      handedOffBy: client.user.id,
      handedOffAt: nowIso(),
      lastAiReplyAt: nowIso(),
      lastUserMessageAt: currentIso,
      lastStaffMessageAt: session?.last_staff_message_at || null,
    });

    await sendTicketAiInteractionLog(client, {
      ticket,
      userId: message.author.id,
      prompt: content,
      response: handoffReply,
      source: "ticket_ai_handoff",
      model: null,
      status: "handoff",
    });

    return true;
  } finally {
    if (typingInterval) {
      clearInterval(typingInterval);
    }
    inFlightTicketChannels.delete(message.channelId);
  }
}

async function generateAiSuggestion(reason, rules, userId, { guildName, userName } = {}) {
  if (!env.openaiApiKey) {
    throw new Error("OpenAI API Key não configurada.");
  }

  const systemPrompt = [
    "Você é o Especialista em Triagem do Flowdesk, um assistente de IA de alto nível.",
    guildName ? `Você está operando no servidor premium **${guildName}**.` : "",
    "Seu objetivo é analisar profundamente o motivo do ticket e oferecer uma resolução imediata baseada estritamente nas 'Regras de Atendimento' fornecidas.",
    "Diretrizes:",
    "1. Resposta Especialista: Não seja genérico. Use os termos técnicos e regras específicas do servidor.",
    "2. Tom de Voz: Profissional, prestativo e autoritativo (você conhece as regras).",
    "3. Resolução: Se a resposta estiver nas regras, entregue-a de forma clara e formatada.",
    "4. Handoff: Se o assunto for complexo, explique quais informações o usuário já deve deixar preparadas para agilizar o atendimento humano.",
    "5. Formatação: Use negrito para pontos importantes e listas para passos a passo.",
    "Sempre termine perguntando se a informação foi útil para resolver o problema agora.",
  ].filter(Boolean).join(" ");

  const contextPrompt = `
Usuário: ${userName || "Desconhecido"} (${userId})
Servidor: ${guildName || "Desconhecido"}

Regras de Atendimento do Servidor:
${rules || "Nenhuma regra específica configurada."}

Pergunta/Motivo do Usuário:
${reason}
  `.trim();

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: contextPrompt },
  ];

  const result = await callOpenAI(messages, userId);
  return result.content;
}

module.exports = {
  handleTicketAiMessage,
  markTicketAiClosed,
  markTicketAiHandoff,
  sendInitialTicketAiMessage,
  generateAiSuggestion,
  sendTicketAiInteractionLog,
};
