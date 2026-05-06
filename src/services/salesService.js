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
  "id, guild_id, discord_user_id, discord_channel_id, auth_user_id, status, subtotal_amount, total_amount, provider_payment_id, provider_status, provider_ticket_url, provider_qr_code, provider_qr_base64, discord_notification_sent_at";

const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
};
const COMPONENTS_V2_FLAG = MessageFlags.IsComponentsV2 || 32768;

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

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
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

function button({ customId, label, style = ButtonStyle.Secondary, url, disabled = false }) {
  return {
    type: COMPONENT_TYPE.BUTTON,
    style,
    label: truncateText(label, 80),
    disabled,
    ...(url ? { url } : { custom_id: customId }),
  };
}

function selectMenu({ customId, placeholder, options }) {
  return {
    type: COMPONENT_TYPE.STRING_SELECT,
    custom_id: customId,
    placeholder,
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
    .eq("status", "available")
    .gt("quantity", 0);

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    if (
      result.error.code === "42P01" ||
      result.error.code === "PGRST205" ||
      message.includes("guild_sales_stock_items")
    ) {
      return {
        quantity: Math.max(0, Number(fallbackQuantity || 0)),
        reliable: false,
      };
    }
    throw new Error(`[Supabase] Falha em "getAvailableStockQuantity": ${result.error.message}`);
  }

  return {
    quantity: (result.data || []).reduce(
      (sum, item) => sum + Math.max(0, Number(item.quantity || 0)),
      0,
    ),
    reliable: true,
  };
}

function isMissingStockSyncRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "42883" || message.includes("sync_guild_sales_product_stock_quantity");
}

async function getCanonicalAvailableStockQuantity(product) {
  const storedQuantity = Number(product?.stock_quantity || 0);
  if (!product?.guild_id || !product?.id) {
    return { quantity: storedQuantity, reliable: false };
  }

  const rpcResult = await supabase
    .rpc("sync_guild_sales_product_stock_quantity", {
      p_guild_id: product.guild_id,
      p_product_id: product.id,
    });
  if (!rpcResult.error && Number.isFinite(Number(rpcResult.data))) {
    return { quantity: Math.max(0, Number(rpcResult.data || 0)), reliable: true };
  }
  if (rpcResult.error && !isMissingStockSyncRpcError(rpcResult.error)) {
    console.warn("[salesService] Falha ao sincronizar estoque via RPC.", {
      guildId: product.guild_id,
      productId: product.id,
      error: rpcResult.error.message,
    });
  }

  const availableQuantity = await getAvailableStockQuantity(
    product.guild_id,
    product.id,
    storedQuantity,
  );
  if (availableQuantity.reliable) {
    return availableQuantity;
  }

  const freshProduct = await supabase
    .from("guild_sales_products")
    .select("stock_quantity")
    .eq("guild_id", product.guild_id)
    .eq("id", product.id)
    .maybeSingle();
  if (!freshProduct.error && freshProduct.data) {
    return {
      quantity: Math.max(0, Number(freshProduct.data.stock_quantity || 0)),
      reliable: false,
    };
  }

  return availableQuantity;
}

async function productHasEffectiveStock(product, quantity = 1) {
  if (product?.inventory_tracked === false) return true;
  const storedQuantity = Number(product?.stock_quantity || 0);
  const availableQuantity = await getCanonicalAvailableStockQuantity(product);
  const effectiveQuantity = availableQuantity.quantity;
  if (availableQuantity.reliable && availableQuantity.quantity !== storedQuantity) {
    const repairResult = await supabase
      .from("guild_sales_products")
      .update({ stock_quantity: availableQuantity.quantity })
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

async function getOpenCartForUser(guildId, discordUserId) {
  const result = await supabase
    .from("guild_sales_carts")
    .select(CART_SELECT)
    .eq("guild_id", guildId)
    .eq("discord_user_id", discordUserId)
    .in("status", ["link_required", "open"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return unwrap(result, "getOpenCartForUser") || null;
}

function cartMessageCustomIdExists(components, cartId) {
  if (!Array.isArray(components)) return false;
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const customId = component.customId || component.custom_id;
    if (typeof customId === "string" && customId.includes(`:${cartId}`)) return true;
    if (cartMessageCustomIdExists(component.components, cartId)) return true;
    if (component.accessory && cartMessageCustomIdExists([component.accessory], cartId)) return true;
  }
  return false;
}

async function replaceCartChannelMessage(channel, cart, options = {}) {
  if (!channel?.send) return null;
  const items = await getCartItems(cart.id);
  const messages = await channel.messages?.fetch({ limit: 25 }).catch(() => null);
  if (messages) {
    await Promise.all(
      Array.from(messages.values())
        .filter((message) => message.author?.bot && cartMessageCustomIdExists(message.components, cart.id))
        .map((message) => message.delete().catch(() => null)),
    );
  }
  return channel.send(buildCartMessagePayload({
    cart,
    items,
    linked: Boolean(cart.auth_user_id),
    linkUrl: options.linkUrl,
  }));
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

function resolveItemProduct(item) {
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

function buildCartItemsMarkdown(items) {
  if (!items.length) return "Carrinho vazio.";
  return items
    .map((item, index) => {
      const product = resolveItemProduct(item);
      const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
      const total = Number(item.total_amount || quantity * product.priceAmount);
      return [
        `**${index + 1}. ${truncateText(product.title, 80)}**`,
        `${product.sku || product.code || "SKU automatico"} - ${quantity} un. x ${formatMoney(product.priceAmount)} = **${formatMoney(total)}**`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildCartMessagePayload({ cart, items, linked, linkUrl }) {
  const title = linked ? "## Carrinho vinculado" : "## Vincule sua compra";
  const subtitle = linked
    ? "A conta Flowdesk foi confirmada. Ajuste as quantidades e prossiga para o pagamento."
    : "Antes do pagamento, confirme no site que este carrinho pertence a sua conta Flowdesk.";
  const controlsDisabled = ["payment_pending", "paid", "delivered", "delivery_failed"].includes(cart.status);
  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: linked ? 0x7ce2a0 : 0xf1f1f1,
      components: [
        textDisplay(`${title}\n${subtitle}`),
        separator(),
        textDisplay(buildCartItemsMarkdown(items)),
        separator(),
        textDisplay(`**Total:** ${formatMoney(cart.total_amount)}`),
      ],
    },
  ];

  if (!linked && linkUrl) {
    components.push(actionRow([
      button({ label: "Vincular compra", style: ButtonStyle.Link, url: linkUrl }),
      button({ customId: `sales:cart:linked:${cart.id}`, label: "Ja vinculei" }),
    ]));
    return v2Message(components);
  }

  if (linked && !controlsDisabled) {
    for (const item of items.slice(0, 5)) {
      const product = resolveItemProduct(item);
      components.push(actionRow([
        button({ customId: `sales:cart:qty_dec:${cart.id}:${item.id}`, label: "-" }),
        button({
          customId: `sales:cart:item:${cart.id}:${item.id}`,
          label: `${truncateText(product.title, 36)} (${Math.max(1, Number(item.quantity || 1))})`,
          disabled: true,
        }),
        button({ customId: `sales:cart:qty_inc:${cart.id}:${item.id}`, label: "+" }),
      ]));
    }
    components.push(actionRow([
      button({ customId: `sales:cart:checkout:${cart.id}`, label: "Prosseguir", style: ButtonStyle.Success }),
    ]));
  }

  if (cart.status === "payment_pending") {
    components.push(actionRow([
      button({ customId: `sales:cart:check:${cart.id}`, label: "Atualizar status", style: ButtonStyle.Primary }),
    ]));
  }

  return v2Message(components);
}

function buildPaymentSelectionPayload(cart, items, methods) {
  const options = methods
    .filter((method) => method.method_key === "mercado_pago")
    .map((method) => ({
      label: method.display_name || "Mercado Pago",
      description: "PIX automatico",
      value: method.method_key,
    }));

  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay("## Escolha o metodo de pagamento\nAs quantidades foram bloqueadas para evitar alteracoes enquanto voce escolhe o pagamento."),
        separator(),
        textDisplay(`${buildCartItemsMarkdown(items)}\n\n**Total:** ${formatMoney(cart.total_amount)}`),
      ],
    },
    actionRow([
      selectMenu({
        customId: `sales:cart:payment:${cart.id}`,
        placeholder: "Selecione o metodo de pagamento",
        options,
      }),
    ]),
    actionRow([
      button({ customId: `sales:cart:back:${cart.id}`, label: "Voltar" }),
    ]),
  ]);
}

async function refreshCartMessage(message, cartId, options = {}) {
  const cart = await getCart(cartId);
  if (!cart) return;
  const items = await getCartItems(cartId);
  const linked = Boolean(cart.auth_user_id);
  await message.edit(buildCartMessagePayload({
    cart,
    items,
    linked,
    linkUrl: options.linkUrl,
  })).catch(() => null);
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

async function createCheckoutLinkToken(cart) {
  const token = createCheckoutToken();
  const linkResult = await supabase
    .from("guild_sales_checkout_links")
    .insert({
      cart_id: cart.id,
      guild_id: cart.guild_id,
      discord_user_id: cart.discord_user_id,
      token_hash: hashCheckoutToken(token),
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  unwrap(linkResult, "createCheckoutLinkToken");
  return token;
}

function buildProductSnapshot(product, amount) {
  return {
    code: buildProductCode(product.id),
    title: product.title,
    sku: product.sku || "",
    priceAmount: amount,
    stockQuantity: Number(product.stock_quantity || 0),
    mediaUrls: Array.isArray(product.media_urls) ? product.media_urls : [],
  };
}

async function addProductToCart(cart, product) {
  const amount = Number(product.price_amount || 0);
  const items = await getCartItems(cart.id);
  const existing = items.find((item) => item.product_id === product.id);
  const currentQuantity = Math.max(0, Number(existing?.quantity || 0));
  if (!(await productHasEffectiveStock(product, currentQuantity + 1))) {
    if (existing) {
      const updatedCart = await updateCartTotals(cart.id, items);
      return { cart: updatedCart, added: false, maxStockReached: true };
    }
    throw new Error("Produto sem estoque disponivel para adicionar outra unidade.");
  }

  if (existing) {
    const nextQuantity = currentQuantity + 1;
    const updateResult = await supabase
      .from("guild_sales_cart_items")
      .update({
        quantity: nextQuantity,
        unit_price_amount: amount,
        total_amount: Number((nextQuantity * amount).toFixed(2)),
        product_snapshot: buildProductSnapshot(product, amount),
      })
      .eq("id", existing.id);
    unwrap(updateResult, "addProductToCart.updateItem");
  } else {
    const insertResult = await supabase
      .from("guild_sales_cart_items")
      .insert({
        cart_id: cart.id,
        guild_id: cart.guild_id,
        product_id: product.id,
        quantity: 1,
        unit_price_amount: amount,
        total_amount: amount,
        product_snapshot: buildProductSnapshot(product, amount),
      });
    unwrap(insertResult, "addProductToCart.insertItem");
  }

  const updatedItems = await getCartItems(cart.id);
  const updatedCart = await updateCartTotals(cart.id, updatedItems);
  return { cart: updatedCart, added: true, maxStockReached: false };
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

  const existingCart = await getOpenCartForUser(guildId, interaction.user.id);
  if (existingCart) {
    const addResult = await addProductToCart(existingCart, product);
    const updatedCart = addResult.cart;
    let channel = interaction.guild.channels.cache.get(existingCart.discord_channel_id);
    if (!channel && existingCart.discord_channel_id) {
      channel = await interaction.guild.channels.fetch(existingCart.discord_channel_id).catch(() => null);
    }
    if (!channel) {
      channel = await createCartChannel(interaction, settings);
      const updateResult = await supabase
        .from("guild_sales_carts")
        .update({ discord_channel_id: channel.id })
        .eq("id", existingCart.id)
        .select(CART_SELECT)
        .single();
      Object.assign(updatedCart, unwrap(updateResult, "handleAddToCartInteraction.repairChannel"));
    }
    const token = updatedCart.auth_user_id ? null : await createCheckoutLinkToken(updatedCart);
    await replaceCartChannelMessage(channel, updatedCart, {
      linkUrl: token ? checkoutUrl(token) : null,
    });
    await interaction.editReply(
      addResult.added
        ? `Produto adicionado ao carrinho aberto: ${channel}`
        : `Este produto ja esta no carrinho aberto: ${channel}`,
    );
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
    ...buildCartMessagePayload({ cart, items, linked: false, linkUrl }),
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

async function handleQuantityButton(interaction, cartId, direction, itemId = null) {
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
  const item = itemId
    ? items.find((entry) => entry.id === itemId)
    : items[0];
  if (!item) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho vazio." });
    return;
  }
  const productResult = await supabase
    .from("guild_sales_products")
    .select(PRODUCT_SELECT)
    .eq("id", item.product_id)
    .maybeSingle();
  const product = unwrap(productResult, "handleQuantityButton.product");
  const availableStock = product?.inventory_tracked === false
    ? { quantity: 999, reliable: true }
    : await getAvailableStockQuantity(cart.guild_id, item.product_id, product?.stock_quantity || 1);
  const stock = product?.inventory_tracked === false
    ? 999
    : Math.max(1, availableStock.quantity);
  const current = Math.max(1, Number(item.quantity || 1));
  const nextQuantity =
    direction === "inc" ? Math.min(stock, current + 1) : Math.max(1, current - 1);
  if (direction === "inc" && !(await productHasEffectiveStock(product, nextQuantity))) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Estoque maximo atingido para este produto." });
    return;
  }
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

  const items = await getCartItems(cartId);
  if (!items.length) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho vazio." });
    return;
  }

  await interaction.update(buildPaymentSelectionPayload(cart, items, available));
}

function buildPixPaymentMessage(cartId, payment) {
  const files = [];
  const body = [
    "## PIX gerado",
    "Pague com o QR Code ou copia e cola. O status sera atualizado automaticamente aqui no carrinho.",
    "",
    `**Valor:** ${formatMoney(payment.amount)}`,
    `**Status:** ${payment.status || "pending"}`,
  ];
  if (payment.qrBase64) {
    const raw = String(payment.qrBase64).replace(/^data:image\/png;base64,/i, "");
    const buffer = Buffer.from(raw, "base64");
    files.push(new AttachmentBuilder(buffer, { name: "pix.png" }));
  }

  if (payment.qrCode) {
    body.push("", "**PIX copia e cola**", `\`\`\`${String(payment.qrCode).slice(0, 990)}\`\`\``);
  }

  const containerComponents = [textDisplay(body.join("\n"))];
  if (payment.qrBase64) {
    containerComponents.push({
      type: COMPONENT_TYPE.MEDIA_GALLERY,
      items: [{ media: { url: "attachment://pix.png" } }],
    });
  }

  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: containerComponents,
    },
    actionRow([
      button({ customId: `sales:cart:check:${cartId}`, label: "Atualizar status", style: ButtonStyle.Primary }),
      ...(payment.ticketUrl
        ? [button({ label: "Abrir Mercado Pago", style: ButtonStyle.Link, url: payment.ticketUrl })]
        : []),
    ]),
  ];

  return v2Message(components, { files });
}

async function deliverApprovedCart(interaction, payload) {
  const deliveries = Array.isArray(payload.deliveries) ? payload.deliveries : [];
  const orderUrl = deliveryUrl(payload.cart.id);
  const user = interaction.user;
  const lockResult = await supabase
    .from("guild_sales_carts")
    .update({
      discord_notification_sent_at: new Date().toISOString(),
      discord_notification_error: "",
    })
    .eq("id", payload.cart.id)
    .is("discord_notification_sent_at", null)
    .select("id")
    .maybeSingle();
  if (lockResult.error) {
    console.warn("[salesService] Falha ao travar notificacao de entrega.", lockResult.error.message);
  }
  if (!lockResult.data && !lockResult.error) {
    return false;
  }

  const receiptEmail =
    typeof payload.user?.email === "string" && payload.user.email.trim()
      ? payload.user.email.trim()
      : null;
  const emailDeliveryCount = deliveries.filter(
    (delivery) => delivery.deliveryMethod === "email" && delivery.status !== "failed",
  ).length;
  const discordDeliveryCount = deliveries.filter(
    (delivery) => delivery.deliveryMethod !== "email" || delivery.status === "failed",
  ).length;
  await user.send(v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x7ce2a0,
      components: [
        textDisplay([
          "## Pagamento aprovado",
          `Compra aprovada no servidor ${interaction.guild?.name || "Discord"}.`,
          receiptEmail ? `Comprovante enviado para: ${receiptEmail}.` : null,
          emailDeliveryCount
            ? `${emailDeliveryCount} entrega(s) por email foram enviadas para o email cadastrado.`
            : null,
          discordDeliveryCount
            ? `${discordDeliveryCount} entrega(s) seguem abaixo em mensagens separadas.`
            : null,
        ].filter(Boolean).join("\n")),
      ],
    },
    actionRow([
      button({ label: "Abrir pedido", style: ButtonStyle.Link, url: orderUrl }),
    ]),
  ])).catch(() => null);

  for (const [index, delivery] of deliveries.entries()) {
    if (delivery.deliveryMethod === "email" && delivery.status !== "failed") {
      continue;
    }
    await user.send(v2Message([
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: delivery.status === "failed" ? 0xffb86b : 0x7ce2a0,
        components: [
          textDisplay([
            `## Entrega ${index + 1}/${deliveries.length}`,
            `**${delivery.productTitle || "Produto"}**`,
            delivery.status === "failed"
              ? (delivery.message || "Entrega pendente. Abra um ticket com o comprovante.")
              : (delivery.message || "Entrega disponivel pelo link do pedido."),
          ].join("\n").slice(0, 3900)),
        ],
      },
      actionRow([
        button({ label: "Abrir pedido", style: ButtonStyle.Link, url: orderUrl }),
      ]),
    ])).catch(() => null);
  }

  await interaction.channel?.send(v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x7ce2a0,
      components: [
        textDisplay(
          `## Pagamento aprovado\nEntrega liberada para <@${user.id}>. Enviei ${deliveries.length || "as"} entrega(s) em mensagens separadas por DM quando possivel.`,
        ),
      ],
    },
    actionRow([
      button({ label: "Ver entrega", style: ButtonStyle.Link, url: orderUrl }),
    ]),
  ], {
    allowedMentions: { users: [user.id] },
  })).catch(() => null);

  setTimeout(() => {
    interaction.channel?.delete("Carrinho Flowdesk finalizado").catch(() => null);
  }, 10_000);

  return true;
}

function buildPaymentStatusPayload(cartId, payment, status) {
  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: status === "delivered" || status === "delivery_failed" ? 0x7ce2a0 : 0x8fdbff,
      components: [
        textDisplay([
          status === "delivered" || status === "delivery_failed"
            ? "## Pagamento aprovado"
            : "## Aguardando pagamento",
          `**Valor:** ${formatMoney(payment?.amount || 0)}`,
          `**Status:** ${status || payment?.status || "payment_pending"}`,
          status === "delivered" || status === "delivery_failed"
            ? "Entrega liberada. Este canal sera removido em alguns segundos."
            : "Assim que o Mercado Pago aprovar, eu atualizo automaticamente.",
        ].join("\n")),
      ],
    },
    actionRow([
      button({ customId: `sales:cart:check:${cartId}`, label: "Atualizar status", style: ButtonStyle.Primary }),
      ...(payment?.ticketUrl
        ? [button({ label: "Abrir Mercado Pago", style: ButtonStyle.Link, url: payment.ticketUrl })]
        : []),
    ]),
  ]);
}

function startPaymentAutoSync(interaction, cartId, paymentMessage) {
  const startedAt = Date.now();
  const maxDurationMs = 30 * 60_000;
  const intervalMs = 7_500;

  const tick = async () => {
    if (Date.now() - startedAt > maxDurationMs) return;
    let payload;
    try {
      payload = await callSalesInternalApi("sync_payment", cartId);
    } catch (error) {
      console.warn("[salesService] Falha no auto sync do pagamento.", {
        cartId,
        error: error instanceof Error ? error.message : error,
      });
      setTimeout(tick, intervalMs);
      return;
    }

    const status = payload.cart?.status || payload.payment?.status || "payment_pending";
    await paymentMessage?.edit(buildPaymentStatusPayload(cartId, payload.payment, status)).catch(() => null);
    if (status === "delivered" || status === "delivery_failed") {
      await deliverApprovedCart(interaction, payload);
      return;
    }
    setTimeout(tick, intervalMs);
  };

  setTimeout(tick, intervalMs);
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

  await interaction.message?.edit(v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay("## Pagamento gerado\nAs quantidades foram bloqueadas. Use o QR Code abaixo para pagar."),
      ],
    },
  ])).catch(() => null);
  const paymentMessage = await interaction.channel?.send(buildPixPaymentMessage(cartId, payload.payment));
  startPaymentAutoSync(interaction, cartId, paymentMessage);
  return true;
}

async function handleCheckPaymentButton(interaction, cartId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const payload = await callSalesInternalApi("sync_payment", cartId);
  const status = payload.cart?.status || payload.payment?.status || "payment_pending";
  if (status === "delivered" || status === "delivery_failed") {
    const sent = await deliverApprovedCart(interaction, payload);
    await interaction.editReply(
      sent
        ? "Pagamento aprovado. Entrega liberada."
        : "Pagamento ja aprovado e entrega ja processada.",
    );
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
    await handleQuantityButton(interaction, cartId, "dec", parts[4]);
    return true;
  }
  if (action === "qty_inc") {
    await handleQuantityButton(interaction, cartId, "inc", parts[4]);
    return true;
  }
  if (action === "checkout") {
    await handleCheckoutButton(interaction, cartId);
    return true;
  }
  if (action === "back") {
    await interaction.deferUpdate();
    await refreshCartMessage(interaction.message, cartId);
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
