const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const PRODUCT_SELECT =
  "id, guild_id, title, description, media_urls, price_amount, inventory_tracked, stock_quantity, sku, status, active, published_point_of_sale, published_virtual_store";
const CART_SELECT =
  "id, guild_id, discord_user_id, discord_channel_id, auth_user_id, status, subtotal_amount, total_amount, provider_payment_id, provider_status, provider_ticket_url, provider_qr_code, provider_qr_base64";

function unwrap(result, operation) {
  if (result.error) {
    throw new Error(`[Supabase] Falha em "${operation}": ${result.error.message}`);
  }
  return result.data;
}

function buildProductCode(id) {
  const digits = String(id || "").replace(/\D/g, "");
  const seed =
    digits ||
    Array.from(String(id || ""))
      .reduce((acc, char) => `${acc}${char.charCodeAt(0)}`, "");
  return `prd-${seed.padEnd(8, "0").slice(0, 8)}`;
}

function normalizeProductCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^prd-[0-9]{8}$/.test(code) ? code : "";
}

function createCheckoutToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashCheckoutToken(token) {
  return crypto.createHash("sha256").update(String(token || "").trim()).digest("hex");
}

function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

function sanitizeChannelName(value) {
  const base = String(value || "cliente")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `carrinho-${base || "cliente"}`;
}

function checkoutUrl(token) {
  return `${String(env.appUrl || "https://www.flwdesk.com").replace(/\/+$/, "")}/checkout/discord/${encodeURIComponent(token)}`;
}

function deliveryUrl(cartId) {
  return `${String(env.appUrl || "https://www.flwdesk.com").replace(/\/+$/, "")}/checkout/orders/${encodeURIComponent(cartId)}`;
}

function parseSalesCustomId(customId) {
  const parts = String(customId || "").split(":");
  if (parts[0] !== "sales") return null;
  return parts;
}

function isSalesComponentInteraction(interaction) {
  return (
    (interaction.isButton?.() || interaction.isStringSelectMenu?.()) &&
    String(interaction.customId || "").startsWith("sales:")
  );
}

async function getSalesSettings(guildId) {
  const result = await supabase
    .from("guild_sales_settings")
    .select("enabled, carts_category_id")
    .eq("guild_id", guildId)
    .maybeSingle();
  return unwrap(result, "getSalesSettings") || null;
}

async function getActivePaymentMethods(guildId) {
  const result = await supabase
    .from("guild_sales_payment_methods")
    .select("method_key, provider, display_name, payment_rail, status, credentials_configured, last_health_status")
    .eq("guild_id", guildId)
    .eq("status", "active");
  return unwrap(result, "getActivePaymentMethods") || [];
}

function isMercadoPagoPixReady(method) {
  if (!method || method.method_key !== "mercado_pago") return false;
  const provider = String(method.provider || "").trim();
  const rail = String(method.payment_rail || "").trim();
  return (
    method.status === "active" &&
    (method.credentials_configured === true || method.last_health_status !== "failed") &&
    (!provider || provider === "mercado_pago") &&
    (!rail || rail === "pix")
  );
}

function getReadyMercadoPagoMethods(methods) {
  return methods.filter(isMercadoPagoPixReady);
}

function productHasStock(product, quantity = 1) {
  if (product?.inventory_tracked === false) return true;
  return Number(product?.stock_quantity || 0) >= Math.max(1, Number(quantity || 1));
}

async function getAvailableStockQuantity(guildId, productId, fallbackQuantity = 0) {
  const result = await supabase
    .from("guild_sales_stock_items")
    .select("quantity")
    .eq("guild_id", guildId)
    .eq("product_id", productId)
    .eq("status", "available");

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    if (
      result.error.code === "42P01" ||
      result.error.code === "PGRST205" ||
      message.includes("guild_sales_stock_items")
    ) {
      return Math.max(0, Number(fallbackQuantity || 0));
    }
    throw new Error(`[Supabase] Falha em "getAvailableStockQuantity": ${result.error.message}`);
  }

  return (result.data || []).reduce(
    (sum, item) => sum + Math.max(0, Number(item.quantity || 0)),
    0,
  );
}

async function productHasEffectiveStock(product, quantity = 1) {
  if (product?.inventory_tracked === false) return true;
  const storedQuantity = Number(product?.stock_quantity || 0);
  const availableQuantity = await getAvailableStockQuantity(
    product.guild_id,
    product.id,
    storedQuantity,
  );
  const effectiveQuantity = Math.max(storedQuantity, availableQuantity);
  if (availableQuantity !== storedQuantity) {
    const repairResult = await supabase
      .from("guild_sales_products")
      .update({ stock_quantity: availableQuantity })
      .eq("guild_id", product.guild_id)
      .eq("id", product.id);
    if (repairResult.error) {
      console.warn("[salesService] Falha ao sincronizar estoque do produto.", {
        guildId: product.guild_id,
        productId: product.id,
        error: repairResult.error.message,
      });
    }
  }
  return effectiveQuantity >= Math.max(1, Number(quantity || 1));
}

async function getProductByCode(guildId, productCode) {
  const result = await supabase
    .from("guild_sales_products")
    .select(PRODUCT_SELECT)
    .eq("guild_id", guildId)
    .limit(500);
  const rows = unwrap(result, "getProductByCode") || [];
  return rows.find((row) => buildProductCode(row.id) === productCode) || null;
}

async function getCart(cartId) {
  const result = await supabase
    .from("guild_sales_carts")
    .select(CART_SELECT)
    .eq("id", cartId)
    .maybeSingle();
  return unwrap(result, "getCart") || null;
}

async function getCartItems(cartId) {
  const result = await supabase
    .from("guild_sales_cart_items")
    .select("id, cart_id, guild_id, product_id, quantity, unit_price_amount, total_amount, product_snapshot")
    .eq("cart_id", cartId)
    .order("created_at", { ascending: true });
  return unwrap(result, "getCartItems") || [];
}

async function updateCartTotals(cartId, items) {
  const total = items.reduce((sum, item) => {
    const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
    const unit = Number(item.unit_price_amount || 0);
    return sum + quantity * unit;
  }, 0);
  const amount = Number(total.toFixed(2));
  const result = await supabase
    .from("guild_sales_carts")
    .update({
      subtotal_amount: amount,
      total_amount: amount,
    })
    .eq("id", cartId)
    .select(CART_SELECT)
    .single();
  return unwrap(result, "updateCartTotals");
}

function resolveFirstItemProduct(items) {
  const item = items[0] || null;
  const snapshot = item?.product_snapshot && typeof item.product_snapshot === "object"
    ? item.product_snapshot
    : {};
  return {
    title: snapshot.title || "Produto",
    sku: snapshot.sku || "",
    priceAmount: Number(item?.unit_price_amount || 0),
    stockQuantity: Number(snapshot.stockQuantity || 0),
    mediaUrls: Array.isArray(snapshot.mediaUrls) ? snapshot.mediaUrls : [],
  };
}

function buildCartEmbed({ cart, items, linked }) {
  const product = resolveFirstItemProduct(items);
  const quantity = Math.max(1, Math.floor(Number(items[0]?.quantity || 1)));
  const total = Number(cart.total_amount || quantity * product.priceAmount);
  return new EmbedBuilder()
    .setColor(linked ? 0x7ce2a0 : 0xf1f1f1)
    .setTitle(linked ? "Carrinho vinculado" : "Vincule sua compra")
    .setDescription(
      linked
        ? "A conta Flowdesk foi confirmada. Ajuste a quantidade e prossiga para o PIX."
        : "Antes do pagamento, confirme no site que este carrinho pertence a sua conta Flowdesk.",
    )
    .addFields(
      {
        name: "Produto",
        value: `${product.title}\n${product.sku || "SKU automatico"} - ${formatMoney(product.priceAmount)}`,
      },
      {
        name: "Quantidade",
        value: `${quantity} un.`,
        inline: true,
      },
      {
        name: "Total",
        value: formatMoney(total),
        inline: true,
      },
    )
    .setFooter({ text: "Flowdesk Vendas" });
}

function buildLinkComponents(cartId, linkUrl) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Vincular compra")
        .setURL(linkUrl),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId(`sales:cart:linked:${cartId}`)
        .setLabel("Ja vinculei"),
    ),
  ];
}

function buildCartControlComponents(cartId, paymentPending = false) {
  if (paymentPending) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Primary)
          .setCustomId(`sales:cart:check:${cartId}`)
          .setLabel("Verificar pagamento"),
      ),
    ];
  }

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId(`sales:cart:qty_dec:${cartId}`)
        .setLabel("-"),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setCustomId(`sales:cart:qty_inc:${cartId}`)
        .setLabel("+"),
      new ButtonBuilder()
        .setStyle(ButtonStyle.Success)
        .setCustomId(`sales:cart:checkout:${cartId}`)
        .setLabel("Prosseguir"),
    ),
  ];
}

function buildPaymentSelectComponents(cartId, methods) {
  const options = methods
    .filter((method) => method.method_key === "mercado_pago")
    .map((method) => ({
      label: method.display_name || "Mercado Pago",
      description: "PIX automatico",
      value: method.method_key,
    }));

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`sales:cart:payment:${cartId}`)
        .setPlaceholder("Selecione o metodo de pagamento")
        .addOptions(options),
    ),
  ];
}

async function refreshCartMessage(message, cartId, options = {}) {
  const cart = await getCart(cartId);
  if (!cart) return;
  const items = await getCartItems(cartId);
  const linked = Boolean(cart.auth_user_id);
  const paymentPending = cart.status === "payment_pending";
  await message.edit({
    embeds: [buildCartEmbed({ cart, items, linked })],
    components: linked
      ? buildCartControlComponents(cart.id, paymentPending)
      : options.linkUrl
        ? buildLinkComponents(cart.id, options.linkUrl)
        : [],
  }).catch(() => null);
}

async function createCartChannel(interaction, settings) {
  const guild = interaction.guild;
  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  return guild.channels.create({
    name: sanitizeChannelName(interaction.user.username),
    type: ChannelType.GuildText,
    parent: settings.carts_category_id || undefined,
    topic: `Carrinho Flowdesk de ${interaction.user.tag} (${interaction.user.id})`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...(botMember
        ? [
            {
              id: botMember.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ]
        : []),
    ],
  });
}

async function createCartRecord({ guildId, discordUserId, channelId, product }) {
  const amount = Number(product.price_amount || 0);
  const cartResult = await supabase
    .from("guild_sales_carts")
    .insert({
      guild_id: guildId,
      discord_user_id: discordUserId,
      discord_channel_id: channelId,
      status: "link_required",
      currency: "BRL",
      subtotal_amount: amount,
      total_amount: amount,
    })
    .select(CART_SELECT)
    .single();
  const cart = unwrap(cartResult, "createCartRecord.cart");

  const snapshot = {
    code: buildProductCode(product.id),
    title: product.title,
    sku: product.sku || "",
    priceAmount: amount,
    stockQuantity: Number(product.stock_quantity || 0),
    mediaUrls: Array.isArray(product.media_urls) ? product.media_urls : [],
  };

  const itemResult = await supabase
    .from("guild_sales_cart_items")
    .insert({
      cart_id: cart.id,
      guild_id: guildId,
      product_id: product.id,
      quantity: 1,
      unit_price_amount: amount,
      total_amount: amount,
      product_snapshot: snapshot,
    })
    .select("id")
    .single();
  unwrap(itemResult, "createCartRecord.item");

  const token = createCheckoutToken();
  const linkResult = await supabase
    .from("guild_sales_checkout_links")
    .insert({
      cart_id: cart.id,
      guild_id: guildId,
      discord_user_id: discordUserId,
      token_hash: hashCheckoutToken(token),
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  unwrap(linkResult, "createCartRecord.checkoutLink");

  return { cart, token };
}

async function callSalesInternalApi(action, cartId) {
  if (!env.salesInternalApiToken) {
    throw new Error("SALES_INTERNAL_API_TOKEN/CRON_SECRET nao configurado para o bot.");
  }

  const response = await fetch(env.salesInternalApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.salesInternalApiToken}`,
    },
    body: JSON.stringify({ action, cartId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "Falha ao comunicar com checkout interno.");
  }
  return payload;
}

async function handleMissingPayment(interaction) {
  const content =
    "Este servidor ainda nao ativou PIX via Mercado Pago. Peca para um administrador configurar em Vendas > Metodos de pagamento.";
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content).catch(() => null);
    return;
  }
  await interaction.reply({ flags: MessageFlags.Ephemeral, content });
}

async function handleAddToCartInteraction(interaction) {
  const parts = parseSalesCustomId(interaction.customId);
  const mode = parts?.[2];
  const productCode = normalizeProductCode(parts?.[3]);
  if (!productCode || (mode !== "add" && mode !== "missing_payment")) return false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  const settings = await getSalesSettings(guildId);
  if (!settings?.enabled || !settings.carts_category_id) {
    await interaction.editReply(
      "O modulo de vendas ainda nao esta ativo ou a categoria de carrinhos nao foi definida.",
    );
    return true;
  }

  const methods = await getActivePaymentMethods(guildId);
  if (!getReadyMercadoPagoMethods(methods).length) {
    await handleMissingPayment(interaction);
    return true;
  }

  const product = await getProductByCode(guildId, productCode);
  if (!product || product.status !== "active" || product.active === false) {
    await interaction.editReply("Produto indisponivel.");
    return true;
  }
  if (!(await productHasEffectiveStock(product, 1))) {
    await interaction.editReply("Produto sem estoque disponivel.");
    return true;
  }

  const channel = await createCartChannel(interaction, settings);
  const { cart, token } = await createCartRecord({
    guildId,
    discordUserId: interaction.user.id,
    channelId: channel.id,
    product,
  });
  const items = await getCartItems(cart.id);
  const linkUrl = checkoutUrl(token);

  await channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [buildCartEmbed({ cart, items, linked: false })],
    components: buildLinkComponents(cart.id, linkUrl),
    allowedMentions: { users: [interaction.user.id] },
  });

  await interaction.editReply(`Carrinho criado: ${channel}`);
  return true;
}

async function handleLinkedButton(interaction, cartId) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  if (!cart.auth_user_id) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Ainda nao detectei a vinculacao. Confirme no site e clique novamente.",
    });
    return;
  }
  await interaction.deferUpdate();
  await refreshCartMessage(interaction.message, cartId);
}

async function handleQuantityButton(interaction, cartId, direction) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  if (!cart.auth_user_id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Vincule a compra antes de alterar quantidade." });
    return;
  }
  if (cart.status === "payment_pending") {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Pagamento ja foi gerado para este carrinho." });
    return;
  }

  const items = await getCartItems(cartId);
  const item = items[0];
  if (!item) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho vazio." });
    return;
  }
  const productResult = await supabase
    .from("guild_sales_products")
    .select("inventory_tracked, stock_quantity")
    .eq("id", item.product_id)
    .maybeSingle();
  const product = unwrap(productResult, "handleQuantityButton.product");
  const stock = product?.inventory_tracked === false
    ? 999
    : Math.max(
        1,
        await getAvailableStockQuantity(cart.guild_id, item.product_id, product?.stock_quantity || 1),
      );
  const current = Math.max(1, Number(item.quantity || 1));
  const nextQuantity =
    direction === "inc" ? Math.min(stock, current + 1) : Math.max(1, current - 1);
  const unit = Number(item.unit_price_amount || 0);

  await supabase
    .from("guild_sales_cart_items")
    .update({
      quantity: nextQuantity,
      total_amount: Number((nextQuantity * unit).toFixed(2)),
    })
    .eq("id", item.id);
  const updatedItems = await getCartItems(cartId);
  await updateCartTotals(cartId, updatedItems);

  await interaction.deferUpdate();
  await refreshCartMessage(interaction.message, cartId);
}

async function handleCheckoutButton(interaction, cartId) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  if (!cart.auth_user_id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Vincule a compra antes de pagar." });
    return;
  }
  const methods = await getActivePaymentMethods(cart.guild_id);
  const available = getReadyMercadoPagoMethods(methods);
  if (!available.length) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Nenhum metodo de pagamento ativo com credenciais validas." });
    return;
  }

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    content: "Escolha o metodo ativo para gerar o pagamento.",
    components: buildPaymentSelectComponents(cartId, available),
  });
}

function buildPixPaymentMessage(cartId, payment) {
  const components = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Primary)
        .setCustomId(`sales:cart:check:${cartId}`)
        .setLabel("Verificar pagamento"),
      ...(payment.ticketUrl
        ? [
            new ButtonBuilder()
              .setStyle(ButtonStyle.Link)
              .setLabel("Abrir Mercado Pago")
              .setURL(payment.ticketUrl),
          ]
        : []),
    ),
  ];

  const embed = new EmbedBuilder()
    .setColor(0x8fdbff)
    .setTitle("PIX gerado")
    .setDescription("Pague com o QR Code ou copia e cola. Depois clique em Verificar pagamento.")
    .addFields(
      { name: "Valor", value: formatMoney(payment.amount), inline: true },
      { name: "Status", value: payment.status || "pending", inline: true },
    );

  const files = [];
  if (payment.qrBase64) {
    const raw = String(payment.qrBase64).replace(/^data:image\/png;base64,/i, "");
    const buffer = Buffer.from(raw, "base64");
    files.push(new AttachmentBuilder(buffer, { name: "pix.png" }));
    embed.setImage("attachment://pix.png");
  }

  if (payment.qrCode) {
    embed.addFields({
      name: "PIX copia e cola",
      value: `\`\`\`${String(payment.qrCode).slice(0, 990)}\`\`\``,
    });
  }

  return { embeds: [embed], components, files };
}

async function deliverApprovedCart(interaction, payload) {
  const deliveries = Array.isArray(payload.deliveries) ? payload.deliveries : [];
  const orderUrl = deliveryUrl(payload.cart.id);
  const user = interaction.user;
  const receiptEmail =
    typeof payload.user?.email === "string" && payload.user.email.trim()
      ? payload.user.email.trim()
      : null;
  const dmLines = [
    `Compra aprovada no servidor ${interaction.guild?.name || "Discord"}.`,
    `Entrega no site: ${orderUrl}`,
    receiptEmail ? `Comprovante enviado para: ${receiptEmail}` : null,
  ].filter(Boolean);

  for (const delivery of deliveries) {
    if (delivery.deliveryMethod === "discord_dm" && delivery.message) {
      dmLines.push("", delivery.message);
    }
  }

  await user.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x7ce2a0)
        .setTitle("Pagamento aprovado")
        .setDescription(dmLines.join("\n").slice(0, 3900)),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Abrir entrega")
          .setURL(orderUrl),
      ),
    ],
  }).catch(() => null);

  await interaction.channel?.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x7ce2a0)
        .setTitle("Pagamento aprovado")
        .setDescription(
          `Entrega liberada para <@${user.id}>. Tambem enviei o link por DM quando possivel.`,
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Ver entrega")
          .setURL(orderUrl),
      ),
    ],
    allowedMentions: { users: [user.id] },
  }).catch(() => null);
}

async function handlePaymentSelect(interaction) {
  const parts = parseSalesCustomId(interaction.customId);
  const cartId = parts?.[3];
  if (!cartId || interaction.values?.[0] !== "mercado_pago") return false;

  await interaction.deferUpdate();
  let payload;
  try {
    payload = await callSalesInternalApi("create_pix_payment", cartId);
  } catch (error) {
    await interaction.followUp({
      flags: MessageFlags.Ephemeral,
      content: error instanceof Error ? error.message : "Nao foi possivel gerar o pagamento.",
    }).catch(() => null);
    return true;
  }
  if (payload.cart?.status === "delivered" || payload.cart?.status === "delivery_failed") {
    await deliverApprovedCart(interaction, payload);
    return true;
  }

  await interaction.channel?.send(buildPixPaymentMessage(cartId, payload.payment));
  await refreshCartMessage(interaction.message, cartId);
  return true;
}

async function handleCheckPaymentButton(interaction, cartId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const payload = await callSalesInternalApi("sync_payment", cartId);
  const status = payload.cart?.status || payload.payment?.status || "payment_pending";
  if (status === "delivered" || status === "delivery_failed") {
    await interaction.editReply("Pagamento aprovado. Entrega liberada.");
    await deliverApprovedCart(interaction, payload);
    return;
  }
  await interaction.editReply(`Pagamento ainda nao aprovado. Status atual: ${status}.`);
}

async function handleCartButtonInteraction(interaction) {
  const parts = parseSalesCustomId(interaction.customId);
  if (parts?.[1] !== "cart") return false;
  const action = parts[2];
  const cartId = parts[3];
  if (!cartId) return false;

  if (action === "linked") {
    await handleLinkedButton(interaction, cartId);
    return true;
  }
  if (action === "qty_dec") {
    await handleQuantityButton(interaction, cartId, "dec");
    return true;
  }
  if (action === "qty_inc") {
    await handleQuantityButton(interaction, cartId, "inc");
    return true;
  }
  if (action === "checkout") {
    await handleCheckoutButton(interaction, cartId);
    return true;
  }
  if (action === "check") {
    await handleCheckPaymentButton(interaction, cartId);
    return true;
  }

  return false;
}

async function handleSalesInteraction(interaction) {
  if (!isSalesComponentInteraction(interaction)) return false;

  if (interaction.isButton()) {
    if (await handleAddToCartInteraction(interaction)) return true;
    if (await handleCartButtonInteraction(interaction)) return true;
  }

  if (interaction.isStringSelectMenu()) {
    if (await handlePaymentSelect(interaction)) return true;
  }

  return false;
}

module.exports = {
  handleSalesInteraction,
  isSalesComponentInteraction,
};
