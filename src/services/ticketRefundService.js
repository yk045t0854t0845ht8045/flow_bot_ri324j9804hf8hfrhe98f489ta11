const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} = require("discord.js");
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
const ORDER_LOOKUP_TIMEOUT_MS = 12_000;
const DEFAULT_REFUND_DAYS = 7;
const pendingRefundActions = new Set();

function normalizeText(value, maxLength = 1800) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeIntentText(value) {
  return normalizeText(value, 2200)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmail(text) {
  const match = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

function extractOrderNumber(text) {
  const normalized = String(text || "");
  const explicit = normalized.match(
    /(?:pedido|ordem|order|compra|numero|n[úu]mero|#)\s*(?:do|da|n[ºo.]*)?\s*[:#-]?\s*([a-z0-9-]{4,64})/i,
  );
  if (explicit?.[1]) return explicit[1].trim();

  const candidates = normalized.match(/\b(?:[a-z]{2,}-)?[a-z0-9]{6,64}\b/gi) || [];
  return candidates
    .map((candidate) => candidate.trim())
    .find((candidate) => !candidate.includes("@") && /\d/.test(candidate)) || null;
}

function isRefundOrOrderIntent(text) {
  const normalized = normalizeIntentText(text);
  return [
    "reembolso",
    "estorno",
    "refund",
    "verificar compra",
    "verificacao de compra",
    "validar pedido",
    "consultar pedido",
    "numero do pedido",
    "n do pedido",
  ].some((hint) => normalized.includes(hint));
}

function readRefundMemory(historyRows) {
  const memory = {
    email: null,
    orderNumber: null,
    intent: false,
  };

  for (const row of historyRows || []) {
    const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const refund = metadata.refund && typeof metadata.refund === "object" ? metadata.refund : {};
    if (refund.intent === true) memory.intent = true;
    if (typeof refund.email === "string" && refund.email) memory.email = refund.email;
    if (typeof refund.orderNumber === "string" && refund.orderNumber) {
      memory.orderNumber = refund.orderNumber;
    }
  }

  return memory;
}

function buildRefundMemoryPatch(content, historyRows) {
  const memory = readRefundMemory(historyRows);
  const email = extractEmail(content);
  const orderNumber = extractOrderNumber(content);
  const intent = memory.intent || isRefundOrOrderIntent(content);

  return {
    intent,
    email: email || memory.email,
    orderNumber: orderNumber || memory.orderNumber,
    justProvidedEmail: Boolean(email && !orderNumber && !memory.orderNumber),
  };
}

function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
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
      const snapshot = item?.product_snapshot && typeof item.product_snapshot === "object"
        ? item.product_snapshot
        : {};
      return normalizeText(snapshot.title || snapshot.name || "Produto", 80);
    })
    .filter(Boolean);
  if (!titles.length) return "Produto";
  if (titles.length === 1) return titles[0];
  return `${titles[0]} +${titles.length - 1}`;
}

function resolvePurchaseDate(cart) {
  return cart.paid_at || cart.created_at || cart.updated_at || null;
}

function normalizeOrderToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "");
}

function orderMatches(cart, orderNumber) {
  const token = normalizeOrderToken(orderNumber);
  if (!token) return true;
  const candidates = [
    cart.id,
    cart.provider_payment_id,
    cart.provider_external_reference,
    cart.checkout_token_hash,
  ].map(normalizeOrderToken);
  return candidates.some(
    (candidate) =>
      candidate &&
      (candidate === token || candidate.endsWith(token) || token.endsWith(candidate)),
  );
}

function evaluateRefundEligibility(cart, settings) {
  const purchaseDate = resolvePurchaseDate(cart);
  const purchaseMs = purchaseDate ? Date.parse(purchaseDate) : Number.NaN;
  const refundDays = Math.max(0, Number(settings.refundLimitDays || DEFAULT_REFUND_DAYS));
  const deadlineMs = Number.isFinite(purchaseMs)
    ? purchaseMs + refundDays * 24 * 60 * 60 * 1000
    : Number.NaN;
  const insideWindow = Number.isFinite(deadlineMs) ? Date.now() <= deadlineMs : false;
  const status = String(cart.status || "").toLowerCase();
  const providerStatus = String(cart.provider_status || "").toLowerCase();
  const alreadyRefunded =
    status === "refunded" ||
    providerStatus === "refunded" ||
    String(cart.provider_status_detail || "").toLowerCase().includes("refund");
  const paid = ["paid", "delivered", "delivery_failed"].includes(status);
  const hasProviderPayment = Boolean(cart.provider_payment_id);

  return {
    eligible: paid && hasProviderPayment && insideWindow && !alreadyRefunded,
    paid,
    hasProviderPayment,
    alreadyRefunded,
    insideWindow,
    refundDays,
    deadline: Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null,
  };
}

function parseJsonObject(value) {
  if (!value || typeof value !== "object") return {};
  return value;
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
    const message = String(result.error.message || "").toLowerCase();
    if (result.error.code === "42P01" || message.includes("guild_ticket_refund_settings")) {
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

async function findSalesOrders({ guildId, email, orderNumber, discordUserId }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const userResult = await supabase
    .from("auth_users")
    .select("id, email, discord_user_id")
    .ilike("email", normalizedEmail)
    .maybeSingle();

  const authUser = userResult.error ? null : userResult.data;
  const query = supabase
    .from("guild_sales_carts")
    .select(
      "id, guild_id, discord_user_id, auth_user_id, status, total_amount, provider, provider_payment_id, provider_status, provider_status_detail, paid_at, created_at, updated_at",
    )
    .eq("guild_id", guildId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (authUser?.id) {
    query.eq("auth_user_id", authUser.id);
  } else if (discordUserId) {
    query.eq("discord_user_id", discordUserId);
  }

  const cartsResult = await query;
  if (cartsResult.error) {
    throw new Error(cartsResult.error.message);
  }

  const carts = (cartsResult.data || []).filter((cart) => orderMatches(cart, orderNumber));
  if (!carts.length) return [];

  const cartIds = carts.map((cart) => cart.id);
  const itemsResult = await supabase
    .from("guild_sales_cart_items")
    .select("id, cart_id, product_id, quantity, unit_price_amount, total_amount, product_snapshot")
    .in("cart_id", cartIds);

  const itemsByCart = new Map();
  for (const item of itemsResult.error ? [] : itemsResult.data || []) {
    const current = itemsByCart.get(item.cart_id) || [];
    current.push(item);
    itemsByCart.set(item.cart_id, current);
  }

  return carts.map((cart) => ({
    ...cart,
    items: itemsByCart.get(cart.id) || [],
    productTitle: resolveProductTitle(itemsByCart.get(cart.id) || []),
  }));
}

function buildOrderSelectionMessage(ticket, orders, settings) {
  const options = orders.slice(0, 10).map((order) => ({
    label: resolveProductTitle(order.items).slice(0, 100),
    description: `${formatMoney(order.total_amount)} | ${formatDate(resolvePurchaseDate(order))}`.slice(0, 100),
    value: order.id,
  }));

  return {
    content: [
      "Encontrei compra(s) compativeis com os dados enviados.",
      "Selecione abaixo qual compra voce quer verificar para reembolso. Se nenhuma for a correta, use Cancelar.",
    ].join("\n"),
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${REFUND_PREFIX}select:${ticket.id}`)
          .setPlaceholder("Selecionar compra")
          .addOptions(options),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${REFUND_PREFIX}cancel:${ticket.id}`)
          .setLabel("Cancelar")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: { parse: [] },
  };
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

async function sendManualApprovalRequest({ client, ticket, order, settings, reason }) {
  const guild = await client.guilds.fetch(ticket.guild_id).catch(() => null);
  const channel = settings.approvalChannelId
    ? await guild?.channels.fetch(settings.approvalChannelId).catch(() => null)
    : null;
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Canal de aprovacao de reembolso nao configurado ou inacessivel.");
  }

  const eligibility = evaluateRefundEligibility(order, settings);
  const embed = new EmbedBuilder()
    .setTitle("Solicitacao de reembolso")
    .setColor(eligibility.eligible ? 0xf1c40f : 0xdb4646)
    .addFields(
      { name: "Ticket", value: `${ticket.protocol || ticket.id}\n<#${ticket.channel_id}>`, inline: true },
      { name: "Usuario", value: `<@${ticket.user_id}>`, inline: true },
      { name: "Compra", value: `${order.productTitle || resolveProductTitle(order.items)}\n${formatMoney(order.total_amount)} | ${formatDate(resolvePurchaseDate(order))}`, inline: false },
      { name: "Pedido", value: `\`${order.id}\``, inline: true },
      { name: "Pagamento", value: order.provider_payment_id ? `\`${order.provider_payment_id}\`` : "Nao informado", inline: true },
      { name: "Elegibilidade", value: eligibility.eligible ? "Dentro das regras configuradas." : "Fora das regras automaticas. Revisao manual necessaria.", inline: false },
      { name: "Motivo", value: normalizeText(reason || "Solicitado pelo comprador no ticket.", 900), inline: false },
    )
    .setTimestamp(new Date());

  await channel.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${REFUND_PREFIX}approve:${ticket.id}:${order.id}`)
          .setLabel("Aprovar")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`${REFUND_PREFIX}deny:${ticket.id}:${order.id}`)
          .setLabel("Negar")
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { parse: [], users: [ticket.user_id], roles: [] },
  });
}

async function handleRefundOrVerificationMessage({ message, client, ticket, runtime, historyRows, content, persist }) {
  const memory = buildRefundMemoryPatch(content, historyRows);
  if (!memory.intent) return false;

  await persist({
    authorId: message.author.id,
    authorType: "user",
    source: "ticket_refund_context",
    content: `refund-context:${JSON.stringify({
      email: memory.email,
      orderNumber: memory.orderNumber,
      intent: true,
    })}`,
    metadata: {
      refund: {
        intent: true,
        email: memory.email,
        orderNumber: memory.orderNumber,
      },
    },
  });

  if (!memory.email) {
    await message.reply({
      content:
        "Consigo verificar isso para voce. Para continuar, preciso do email usado na compra e do numero do pedido.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (!memory.orderNumber) {
    await message.reply({
      content:
        "Recebi o email. Para continuar a verificacao, tambem e obrigatorio enviar o numero do pedido.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  await message.channel.send({
    content:
      "Certo, vou consultar a compra no sistema com o email e o numero do pedido informados. Aguarde um momento enquanto verifico status, prazo e elegibilidade.",
    allowedMentions: { parse: [] },
  });

  const settings = await getTicketRefundSettings(ticket.guild_id, runtime);
  if (!settings.enabled) {
    await message.channel.send({
      content:
        "A verificacao automatica de reembolso nao esta ativa neste servidor. Encaminhei o atendimento para a equipe responsavel acompanhar por aqui.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  const orders = await withTimeout(
    findSalesOrders({
      guildId: ticket.guild_id,
      email: memory.email,
      orderNumber: memory.orderNumber,
      discordUserId: ticket.user_id,
    }),
    ORDER_LOOKUP_TIMEOUT_MS,
    "Consulta de compra",
  );

  if (!orders.length) {
    await message.channel.send({
      content:
        "Nao encontrei uma compra compativel com esse email e numero de pedido. Confira os dados enviados ou aguarde a equipe validar manualmente pelo painel.",
      allowedMentions: { parse: [] },
    });
    return true;
  }

  await message.channel.send(buildOrderSelectionMessage(ticket, orders, settings));
  return true;
}

async function getTicketById(ticketId) {
  const result = await supabase
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();
  return result.error ? null : result.data;
}

async function getOrderById(guildId, cartId) {
  const cartResult = await supabase
    .from("guild_sales_carts")
    .select(
      "id, guild_id, discord_user_id, auth_user_id, status, total_amount, provider, provider_payment_id, provider_status, provider_status_detail, paid_at, created_at, updated_at",
    )
    .eq("guild_id", guildId)
    .eq("id", cartId)
    .maybeSingle();
  if (cartResult.error || !cartResult.data) return null;
  const itemsResult = await supabase
    .from("guild_sales_cart_items")
    .select("id, cart_id, product_id, quantity, unit_price_amount, total_amount, product_snapshot")
    .eq("cart_id", cartId);
  const items = itemsResult.error ? [] : itemsResult.data || [];
  return {
    ...cartResult.data,
    items,
    productTitle: resolveProductTitle(items),
  };
}

async function handleTicketRefundInteraction(interaction, client, runtimeLoader) {
  const customId = String(interaction.customId || "");
  if (!customId.startsWith(REFUND_PREFIX)) return false;

  const [, , action, ticketId, cartId] = customId.split(":");
  const ticket = await getTicketById(ticketId);
  if (!ticket) {
    await interaction.reply({ content: "Ticket nao encontrado para esta acao.", ephemeral: true });
    return true;
  }

  const runtime = await runtimeLoader(ticket.guild_id).catch(() => null);
  const settings = await getTicketRefundSettings(ticket.guild_id, runtime);

  if (action === "cancel") {
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({ content: "Somente o comprador deste ticket pode cancelar esta selecao.", ephemeral: true });
      return true;
    }
    await interaction.update({
      content: "Selecao cancelada. Envie o email e o numero do pedido corretos para eu consultar novamente.",
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }

  if (action === "select") {
    if (interaction.user.id !== ticket.user_id) {
      await interaction.reply({ content: "Somente o comprador deste ticket pode selecionar a compra.", ephemeral: true });
      return true;
    }
    const selectedCartId = interaction.values?.[0];
    const order = await getOrderById(ticket.guild_id, selectedCartId);
    if (!order) {
      await interaction.reply({ content: "Nao encontrei essa compra no sistema.", ephemeral: true });
      return true;
    }

    const lockKey = `${ticket.id}:${order.id}`;
    if (pendingRefundActions.has(lockKey)) {
      await interaction.reply({ content: "Ja existe uma solicitacao em andamento para essa compra.", ephemeral: true });
      return true;
    }
    pendingRefundActions.add(lockKey);

    try {
      const eligibility = evaluateRefundEligibility(order, settings);
      if (eligibility.eligible && settings.autoProcessEnabled && !settings.manualApprovalRequired) {
        await interaction.update({
          content: "Compra confirmada. O reembolso esta sendo processado automaticamente agora.",
          components: [],
          allowedMentions: { parse: [] },
        });
        await callInternalSalesRefund(order.id, ticket.guild_id, "Solicitacao validada automaticamente pelo FlowAI no ticket.");
        await interaction.followUp({
          content: `${settings.successMessage}\n\nCompra: ${order.productTitle}\nValor: ${formatMoney(order.total_amount)}\nPrazo estimado: o estorno normalmente segue o prazo do Mercado Pago e do banco emissor.`,
          allowedMentions: { parse: [] },
        });
        return true;
      }

      await sendManualApprovalRequest({
        client,
        ticket,
        order,
        settings,
        reason: "Solicitacao confirmada pelo comprador via FlowAI.",
      });
      await interaction.update({
        content:
          "Compra confirmada. A solicitacao foi enviada para analise da equipe responsavel. Assim que houver uma decisao, ela sera registrada por aqui.",
        components: [],
        allowedMentions: { parse: [] },
      });
      return true;
    } finally {
      pendingRefundActions.delete(lockKey);
    }
  }

  if (action === "approve" || action === "deny") {
    if (!hasRefundApprovalPermission(interaction.member, settings, runtime)) {
      await interaction.reply({ content: "Voce nao tem permissao para decidir este reembolso.", ephemeral: true });
      return true;
    }
    const order = await getOrderById(ticket.guild_id, cartId);
    if (!order) {
      await interaction.reply({ content: "Compra nao encontrada para esta decisao.", ephemeral: true });
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
      return true;
    }

    const lockKey = `${ticket.id}:${order.id}`;
    if (pendingRefundActions.has(lockKey)) {
      await interaction.reply({ content: "Este reembolso ja esta sendo processado.", ephemeral: true });
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
        content: `${settings.successMessage}\n\nCompra: ${order.productTitle}\nValor: ${formatMoney(order.total_amount)}\nPrazo estimado: o estorno normalmente segue o prazo do Mercado Pago e do banco emissor.`,
        allowedMentions: { parse: [] },
      });
      return true;
    } catch (error) {
      await interaction.followUp({
        content: `Nao consegui processar automaticamente: ${normalizeText(error.message, 300)}`,
        ephemeral: true,
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
