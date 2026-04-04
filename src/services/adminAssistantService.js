const { ChannelType, EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { env } = require("../config/env");
const { getGuildTicketRuntime, getOpenTicketByChannel } = require("./supabaseService");
const { closeOpenTicketChannel } = require("./ticketService");

const ADMIN_ACTION_SYSTEM_PROMPT = [
  "Voce interpreta pedidos administrativos para um bot do Discord.",
  "Responda apenas com JSON valido, sem markdown.",
  "Extraia somente acoes administrativas reais e seguras.",
  "Se faltar contexto essencial para executar, retorne intent='clarify'.",
  "Se a mensagem nao for um pedido administrativo operacional, retorne intent='ignore'.",
  "Acoes permitidas: create_category, create_channel, create_role, send_message, send_embed, purge_messages, close_ticket.",
  "Para create_channel, channelType pode ser text, announcement ou voice.",
  "Quando o usuario pedir para criar canal parecido com os outros, marque copyStyleFromCategory=true.",
  "Quando o usuario pedir para mencionar everyone ou here, use mentionEveryone=true em send_message ou send_embed.",
  "Para purge_messages, use count entre 1 e 100.",
  "Para send_embed, voce pode preencher title, description, fields, footer, color e content.",
  "Para close_ticket, use o canal atual se nenhum canal for informado.",
  "Nao invente IDs. Use nomes quando necessario.",
  "Se o usuario pedir varias coisas, retorne varias actions na ordem.",
].join(" ");

const ADMIN_ACTION_HINTS = [
  "cria",
  "criar",
  "crie",
  "gera",
  "publica",
  "posta",
  "canal",
  "categoria",
  "cargo",
  "role",
  "papel",
  "menciona",
  "manda",
  "envia",
  "postagem",
  "embed",
  "anuncio",
  "anuncios",
  "noticias",
  "everyone",
  "here",
  "fecha",
  "fechar",
  "limpa",
  "limpar",
  "apaga",
  "ticket",
];

const ADMIN_EXECUTION_VERBS = [
  "cria",
  "criar",
  "crie",
  "gera",
  "publica",
  "posta",
  "manda",
  "envia",
  "menciona",
  "fecha",
  "fechar",
  "limpa",
  "limpar",
  "apaga",
  "apagar",
  "move",
  "renomeia",
  "renomear",
];

const ADMIN_TARGET_HINTS = [
  "canal",
  "categoria",
  "cargo",
  "role",
  "papel",
  "embed",
  "postagem",
  "anuncio",
  "anuncios",
  "noticias",
  "mensagem",
  "chat",
  "ticket",
  "everyone",
  "here",
];

const COLOR_MAP = new Map([
  ["vermelho", 0xed4245],
  ["azul", 0x3498db],
  ["verde", 0x57f287],
  ["amarelo", 0xfee75c],
  ["laranja", 0xe67e22],
  ["roxo", 0x9b59b6],
  ["rosa", 0xeb459e],
  ["preto", 0x2c2f33],
  ["branco", 0xffffff],
]);

function normalizeText(value, maxLength = 2000) {
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

function normalizeMatchKey(value) {
  return normalizeIntentText(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripBotMention(content, botId) {
  if (!content || !botId) return "";
  const mentionPattern = new RegExp(`<@!?${botId}>`, "g");
  return content.replace(mentionPattern, "").trim();
}

function isOfficialGuild(message) {
  return Boolean(
    message?.guildId &&
      env.officialSupportGuildId &&
      message.guildId === env.officialSupportGuildId,
  );
}

function looksLikeAdminActionRequest(prompt) {
  const normalized = normalizeIntentText(prompt);
  const hasExecutionVerb = ADMIN_EXECUTION_VERBS.some((hint) => normalized.includes(hint));
  const hasTarget = ADMIN_TARGET_HINTS.some((hint) => normalized.includes(hint));

  if (!hasExecutionVerb) {
    return false;
  }

  if (hasTarget) {
    return true;
  }

  return ADMIN_ACTION_HINTS.some((hint) => normalized.includes(hint));
}

async function isAuthorizedAdmin(message) {
  if (!message?.member) return false;

  if (
    message.member.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member.permissions.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  const runtime = await getGuildTicketRuntime(message.guildId).catch(() => null);
  const adminRoleId = runtime?.staffSettings?.admin_role_id;
  return Boolean(
    typeof adminRoleId === "string" &&
      adminRoleId &&
      message.member.roles.cache.has(adminRoleId),
  );
}

function getGuildContext(guild) {
  const channels = Array.from(guild.channels.cache.values())
    .filter(Boolean)
    .map((channel) => ({
      id: channel.id,
      name: channel.name || "",
      type: channel.type,
      parentId: channel.parentId || null,
      parentName: channel.parent?.name || null,
    }));

  const roles = Array.from(guild.roles.cache.values())
    .filter((role) => !role.managed)
    .sort((left, right) => right.position - left.position)
    .slice(0, 60)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color || 0,
    }));

  return { channels, roles };
}

async function buildRecentChannelContext(message) {
  const recentMessages = await message.channel.messages.fetch({ limit: 8 }).catch(() => null);
  if (!recentMessages) return "";

  const lines = [];
  for (const channelMessage of Array.from(recentMessages.values()).reverse()) {
    const content = normalizeText(channelMessage.content || "", 300);
    const embedTitle = normalizeText(channelMessage.embeds?.[0]?.title || "", 120);
    const embedDescription = normalizeText(channelMessage.embeds?.[0]?.description || "", 220);

    lines.push([
      `- autor=${channelMessage.author?.username || channelMessage.author?.id || "desconhecido"}`,
      content ? `conteudo=${content}` : "",
      embedTitle ? `embedTitulo=${embedTitle}` : "",
      embedDescription ? `embedDescricao=${embedDescription}` : "",
    ].filter(Boolean).join(" / "));
  }

  return lines.join("\n").slice(0, 2200);
}

async function buildAdminActionContext(message, guildContext) {
  const channelLines = guildContext.channels
    .slice(0, 140)
    .map((channel) => {
      const parent = channel.parentName ? ` / categoria=${channel.parentName}` : "";
      return `- canal: ${channel.name} / id=${channel.id} / tipo=${channel.type}${parent}`;
    })
    .join("\n");

  const roleLines = guildContext.roles
    .map((role) => `- cargo: ${role.name} / id=${role.id}`)
    .join("\n");

  const mentionedChannels = Array.from(message.mentions?.channels?.values?.() || [])
    .map((channel) => `${channel.name}:${channel.id}`)
    .join(", ");
  const mentionedRoles = Array.from(message.mentions?.roles?.values?.() || [])
    .map((role) => `${role.name}:${role.id}`)
    .join(", ");
  const recentContext = await buildRecentChannelContext(message);

  return [
    `Servidor: ${message.guild?.name || message.guildId}`,
    `Canal atual: ${message.channel?.name || message.channelId}`,
    mentionedChannels ? `Canais mencionados na mensagem: ${mentionedChannels}` : "",
    mentionedRoles ? `Cargos mencionados na mensagem: ${mentionedRoles}` : "",
    recentContext ? `Mensagens recentes do canal atual:\n${recentContext}` : "",
    "Canais conhecidos:",
    channelLines || "- nenhum",
    "",
    "Cargos conhecidos:",
    roleLines || "- nenhum",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 12000);
}

function buildModelCandidates() {
  return [...new Set([
    env.openaiModel,
    ...env.openaiModelFallbacks,
    "gpt-4o-mini",
  ].filter(Boolean))];
}

function isModelAccessError(status, rawText) {
  const normalized = normalizeIntentText(rawText);
  return (
    status === 403 ||
    normalized.includes("does not have access to model") ||
    normalized.includes("model_not_found")
  );
}

async function callOpenAIForAdminPlan(prompt, context, userId) {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY nao configurada.");
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
        temperature: 0.1,
        max_tokens: 900,
        user: String(userId || "").slice(0, 64) || undefined,
        messages: [
          { role: "system", content: ADMIN_ACTION_SYSTEM_PROMPT },
          { role: "system", content: context },
          {
            role: "user",
            content: [
              "Mensagem do admin:",
              prompt,
              "",
              "Retorne JSON no formato:",
              '{"intent":"execute|clarify|ignore","summary":"...","clarification":"...","actions":[{"type":"create_category|create_channel|create_role|send_message|send_embed|purge_messages|close_ticket"}]}'
            ].join("\n"),
          },
        ],
      }),
    });

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      lastError = new Error(
        `Falha ao chamar OpenAI com ${model}: ${response.status} ${response.statusText} ${rawText}`,
      );

      if (isModelAccessError(response.status, rawText)) {
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

    const content = normalizeText(data?.choices?.[0]?.message?.content || "", 16000);
    if (!content) {
      lastError = new Error(`Resposta vazia da OpenAI com ${model}.`);
      continue;
    }

    try {
      return JSON.parse(content);
    } catch {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      lastError = new Error("A IA nao retornou JSON valido para o plano administrativo.");
    }
  }

  throw lastError || new Error("Nenhum modelo conseguiu interpretar o pedido administrativo.");
}

function heuristicAdminPlan(prompt, message) {
  const normalized = normalizeIntentText(prompt);
  const roleMention = Array.from(message.mentions?.roles?.values?.() || [])[0] || null;
  const channelMention = Array.from(message.mentions?.channels?.values?.() || [])[0] || null;

  const closeTicketMatch = normalized.match(/fecha(?:r)?(?:\s+o)?\s+ticket/);
  if (closeTicketMatch) {
    return {
      intent: "execute",
      summary: "Fechar ticket",
      actions: [{
        type: "close_ticket",
        channelId: channelMention?.id || message.channelId,
      }],
    };
  }

  const purgeMatch = normalized.match(/(?:limpa|limpar|apaga|apagar)\s+(\d{1,3})\s+mensagens?/);
  if (purgeMatch) {
    return {
      intent: "execute",
      summary: `Limpar ${purgeMatch[1]} mensagens`,
      actions: [{
        type: "purge_messages",
        channelId: channelMention?.id || message.channelId,
        count: Number(purgeMatch[1]),
      }],
    };
  }

  const categoryMatch = prompt.match(/cria(?:r)?\s+(?:a\s+)?categoria\s+(.+)$/i);
  if (categoryMatch) {
    return {
      intent: "execute",
      summary: `Criar categoria ${categoryMatch[1].trim()}`,
      actions: [{ type: "create_category", name: categoryMatch[1].trim() }],
    };
  }

  const roleMatch = prompt.match(/cria(?:r)?\s+(?:o\s+)?(?:cargo|role|papel)\s+(.+)$/i);
  if (roleMatch) {
    return {
      intent: "execute",
      summary: `Criar cargo ${roleMatch[1].trim()}`,
      actions: [{ type: "create_role", name: roleMatch[1].trim() }],
    };
  }

  const channelMatch = prompt.match(/cria(?:r)?(?:\s+ai)?\s+(?:o\s+)?canal(?:\s+de)?\s+(.+)$/i);
  if (channelMatch) {
    const name = channelMatch[1].trim();
    return {
      intent: "execute",
      summary: `Criar canal ${name}`,
      actions: [{
        type: "create_channel",
        name,
        channelType: normalized.includes("noticia") || normalized.includes("announcement")
          ? "announcement"
          : "text",
        parentName: channelMention?.parent?.name || null,
        copyStyleFromCategory: true,
        mentionAuthor: true,
      }],
    };
  }

  if (normalized.includes("embed") && (normalized.includes("anuncio") || normalized.includes("noticia") || normalized.includes("postagem"))) {
    return {
      intent: "clarify",
      clarification: channelMention
        ? "Eu consigo montar esse embed. Me manda o titulo e os pontos principais, ou descreve o formato que voce quer nesse canal."
        : "Eu consigo montar esse embed. Me diz em qual canal ele deve ir e os pontos principais da postagem.",
      actions: [],
    };
  }

  if (
    (normalized.includes("manda") || normalized.includes("envia") || normalized.includes("menciona")) &&
    (normalized.includes("everyone") || normalized.includes("here"))
  ) {
    return {
      intent: channelMention ? "clarify" : "ignore",
      clarification: channelMention
        ? "Eu consigo fazer isso. Me manda so a mensagem exata que voce quer enviar nesse canal."
        : "",
      actions: [],
    };
  }

  if (roleMention && normalized.includes("canal")) {
    return {
      intent: "execute",
      summary: "Criar canal privado com cargo mencionado",
      actions: [{
        type: "create_channel",
        name: roleMention.name,
        channelType: "text",
        allowedRoleIds: [roleMention.id],
        privateChannel: true,
      }],
    };
  }

  return { intent: "ignore", actions: [] };
}

function findBestChannelByName(guild, name, filterFn = () => true) {
  if (!name) return null;
  const target = normalizeMatchKey(name);
  const candidates = Array.from(guild.channels.cache.values()).filter(filterFn);

  return (
    candidates.find((channel) => normalizeMatchKey(channel.name) === target) ||
    candidates.find((channel) => normalizeMatchKey(channel.name).includes(target)) ||
    null
  );
}

function findBestRoleByName(guild, name) {
  if (!name) return null;
  const target = normalizeMatchKey(name);
  const roles = Array.from(guild.roles.cache.values());
  return (
    roles.find((role) => normalizeMatchKey(role.name) === target) ||
    roles.find((role) => normalizeMatchKey(role.name).includes(target)) ||
    null
  );
}

function parseRoleColor(value) {
  if (!value) return undefined;
  const normalized = normalizeIntentText(value);
  if (COLOR_MAP.has(normalized)) {
    return COLOR_MAP.get(normalized);
  }
  if (/^#?[0-9a-f]{6}$/i.test(String(value))) {
    return Number.parseInt(String(value).replace("#", ""), 16);
  }
  return undefined;
}

function normalizeChannelSegment(name) {
  return normalizeIntentText(name)
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

function inferCategoryStylePrefix(category, type = ChannelType.GuildText) {
  if (!category?.children?.cache) return "";

  const sibling = category.children.cache.find((channel) => {
    return channel.type === type && /^.+?[·-].+$/u.test(channel.name || "");
  });

  if (!sibling) return "";

  const match = String(sibling.name).match(/^(.+?[·-])(.+)$/u);
  return match?.[1] || "";
}

function buildChannelName(rawName, parentCategory, channelType) {
  const cleanRaw = normalizeText(rawName, 90);
  if (!cleanRaw) return null;

  if (channelType === ChannelType.GuildVoice || channelType === ChannelType.GuildCategory) {
    return cleanRaw.slice(0, 90);
  }

  const prefix = inferCategoryStylePrefix(parentCategory, channelType);
  const segment = normalizeChannelSegment(cleanRaw);
  if (!segment) return null;
  return `${prefix}${segment}`.slice(0, 90);
}

function resolveChannelType(value) {
  switch (normalizeIntentText(value)) {
    case "announcement":
    case "news":
    case "noticias":
      return ChannelType.GuildAnnouncement;
    case "voice":
    case "voz":
      return ChannelType.GuildVoice;
    default:
      return ChannelType.GuildText;
  }
}

function buildPermissionOverwrites(guild, action, templateChannel, message, resolvedAccess = {}) {
  if (!action.privateChannel && !templateChannel) {
    return undefined;
  }

  if (templateChannel) {
    return templateChannel.permissionOverwrites.cache.map((overwrite) => ({
      id: overwrite.id,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
      type: overwrite.type,
    }));
  }

  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    {
      id: message.author.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  for (const roleId of resolvedAccess.allowedRoleIds || []) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  for (const userId of resolvedAccess.allowedUserIds || []) {
    overwrites.push({
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  return overwrites;
}

async function ensureBotAdminPermissions(guild, requiredPermissions) {
  const me = guild.members.me || await guild.members.fetchMe();
  return requiredPermissions.every((permission) => me.permissions.has(permission));
}

function buildEmbedFromAction(action) {
  const embed = new EmbedBuilder();

  if (action.title) {
    embed.setTitle(normalizeText(action.title, 256));
  }
  if (action.description) {
    embed.setDescription(normalizeText(action.description, 4096));
  }
  if (action.color) {
    const color = parseRoleColor(action.color);
    if (typeof color === "number") {
      embed.setColor(color);
    }
  } else {
    embed.setColor(env.accentColor || 0x2d7ff9);
  }
  if (action.footer) {
    embed.setFooter({ text: normalizeText(action.footer, 2048) });
  }
  if (Array.isArray(action.fields)) {
    const fields = action.fields
      .map((field) => ({
        name: normalizeText(field?.name || "", 256),
        value: normalizeText(field?.value || "", 1024),
        inline: Boolean(field?.inline),
      }))
      .filter((field) => field.name && field.value)
      .slice(0, 25);

    if (fields.length) {
      embed.addFields(fields);
    }
  }

  return embed;
}

async function safeAdminReply(message, content) {
  try {
    await message.author.send({
      content,
      allowedMentions: { parse: [], roles: [], users: [] },
    });
    return;
  } catch {
    const sentMessage = await message.channel.send({
      content,
      allowedMentions: { parse: [], roles: [], users: [] },
    }).catch(() => null);

    if (sentMessage) {
      setTimeout(() => {
        void sentMessage.delete().catch(() => null);
      }, 10000);
    }
  }
}

async function executeAdminActions(message, plan) {
  const guild = message.guild;
  const runtime = await getGuildTicketRuntime(guild.id).catch(() => null);
  const results = [];
  const createdRefs = [];

  for (const action of plan.actions || []) {
    if (!action?.type) continue;

    if (action.type === "create_category") {
      const allowed = await ensureBotAdminPermissions(guild, [
        PermissionFlagsBits.ManageChannels,
      ]);
      if (!allowed) {
        throw new Error("Eu nao tenho permissao de `ManageChannels` para criar categoria.");
      }

      const name = normalizeText(action.name || "", 80);
      if (!name) {
        throw new Error("Nao consegui identificar o nome da categoria.");
      }

      const createdCategory = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
      });

      createdRefs.push(createdCategory);
      results.push(`Categoria criada: ${createdCategory}`);
      continue;
    }

    if (action.type === "create_role") {
      const allowed = await ensureBotAdminPermissions(guild, [
        PermissionFlagsBits.ManageRoles,
      ]);
      if (!allowed) {
        throw new Error("Eu nao tenho permissao de `ManageRoles` para criar cargo.");
      }

      const name = normalizeText(action.name || "", 80);
      if (!name) {
        throw new Error("Nao consegui identificar o nome do cargo.");
      }

      const createdRole = await guild.roles.create({
        name,
        color: parseRoleColor(action.color),
        mentionable: Boolean(action.mentionable),
        hoist: Boolean(action.hoist),
        reason: `Criado por solicitacao de ${message.author.tag}`,
      });

      results.push(`Cargo criado: <@&${createdRole.id}>`);
      continue;
    }

    if (action.type === "create_channel") {
      const allowed = await ensureBotAdminPermissions(guild, [
        PermissionFlagsBits.ManageChannels,
      ]);
      if (!allowed) {
        throw new Error("Eu nao tenho permissao de `ManageChannels` para criar canal.");
      }

      const channelType = resolveChannelType(action.channelType);
      const parentCategory =
        (action.parentId ? guild.channels.cache.get(action.parentId) : null) ||
        findBestChannelByName(guild, action.parentName, (channel) => channel.type === ChannelType.GuildCategory) ||
        createdRefs.find((channel) => channel.type === ChannelType.GuildCategory) ||
        null;

      const templateChannel =
        (action.copyFromId ? guild.channels.cache.get(action.copyFromId) : null) ||
        findBestChannelByName(guild, action.copyFromName, (channel) => channel.type === channelType) ||
        null;

      const resolvedAllowedRoleIds = [
        ...(Array.isArray(action.allowedRoleIds) ? action.allowedRoleIds : []),
        ...((Array.isArray(action.allowedRoleNames) ? action.allowedRoleNames : [])
          .map((roleName) => findBestRoleByName(guild, roleName)?.id)
          .filter(Boolean)),
      ];

      const resolvedAllowedUserIds = [
        ...(Array.isArray(action.allowedUserIds) ? action.allowedUserIds : []),
      ];

      const rawName = action.name || action.targetName || action.summary || "novo-canal";
      const channelName = buildChannelName(rawName, parentCategory, channelType);
      if (!channelName) {
        throw new Error("Nao consegui montar um nome valido para o canal.");
      }

      const createdChannel = await guild.channels.create({
        name: channelName,
        type: channelType,
        parent: parentCategory?.id || undefined,
        topic: normalizeText(action.topic || "", 400) || undefined,
        permissionOverwrites: buildPermissionOverwrites(
          guild,
          action,
          templateChannel,
          message,
          {
            allowedRoleIds: resolvedAllowedRoleIds,
            allowedUserIds: resolvedAllowedUserIds,
          },
        ),
        reason: `Criado por solicitacao de ${message.author.tag}`,
      });

      if (parentCategory && !templateChannel && !action.privateChannel && channelType !== ChannelType.GuildCategory) {
        await createdChannel.lockPermissions().catch(() => null);
      }

      if (normalizeText(action.initialMessage || "", 1800)) {
        const mentionPieces = [];
        if (action.mentionAuthor) {
          mentionPieces.push(`<@${message.author.id}>`);
        }
        for (const userId of [
          ...(Array.isArray(action.mentionUserIds) ? action.mentionUserIds : []),
          ...resolvedAllowedUserIds,
        ]) {
          if (userId && userId !== message.author.id) {
            mentionPieces.push(`<@${userId}>`);
          }
        }

        await createdChannel.send({
          content: [mentionPieces.join(" "), normalizeText(action.initialMessage, 1800)]
            .filter(Boolean)
            .join(" "),
          allowedMentions: {
            parse: action.mentionEveryone ? ["everyone"] : [],
            users: action.mentionAuthor ? [message.author.id] : [],
            roles: [],
          },
        });
      }

      createdRefs.push(createdChannel);
      results.push(`Canal criado: ${createdChannel}`);
      continue;
    }

    if (action.type === "send_message") {
      const targetChannel =
        (action.channelId ? guild.channels.cache.get(action.channelId) : null) ||
        findBestChannelByName(guild, action.channelName, (channel) => typeof channel.send === "function") ||
        createdRefs.find((channel) => typeof channel.send === "function") ||
        null;

      if (!targetChannel || typeof targetChannel.send !== "function") {
        throw new Error("Nao consegui localizar o canal para enviar a mensagem.");
      }

      const content = normalizeText(action.content || "", 1800);
      if (!content) {
        throw new Error("Faltou a mensagem que deve ser enviada.");
      }

      await targetChannel.send({
        content,
        allowedMentions: {
          parse: action.mentionEveryone ? ["everyone"] : [],
          roles: [],
          users: [],
        },
      });

      results.push(`Mensagem enviada em ${targetChannel}`);
      continue;
    }

    if (action.type === "send_embed") {
      const targetChannel =
        (action.channelId ? guild.channels.cache.get(action.channelId) : null) ||
        findBestChannelByName(guild, action.channelName, (channel) => typeof channel.send === "function") ||
        createdRefs.find((channel) => typeof channel.send === "function") ||
        null;

      if (!targetChannel || typeof targetChannel.send !== "function") {
        throw new Error("Nao consegui localizar o canal para enviar o embed.");
      }

      const embed = buildEmbedFromAction(action);
      const content = normalizeText(action.content || "", 1800);

      await targetChannel.send({
        content: content || undefined,
        embeds: [embed],
        allowedMentions: {
          parse: action.mentionEveryone ? ["everyone"] : [],
          roles: [],
          users: [],
        },
      });

      results.push(`Embed publicado em ${targetChannel}`);
      continue;
    }

    if (action.type === "purge_messages") {
      const allowed = await ensureBotAdminPermissions(guild, [
        PermissionFlagsBits.ManageMessages,
      ]);
      if (!allowed) {
        throw new Error("Eu nao tenho permissao de `ManageMessages` para limpar o chat.");
      }

      const targetChannel =
        (action.channelId ? guild.channels.cache.get(action.channelId) : null) ||
        message.channel;

      if (!targetChannel || typeof targetChannel.bulkDelete !== "function") {
        throw new Error("Nao consegui localizar um canal valido para limpar mensagens.");
      }

      const requestedCount = Math.min(99, Math.max(1, Number(action.count || 0)));
      if (!requestedCount) {
        throw new Error("Me diga quantas mensagens devem ser limpas.");
      }

      const includeCommandMessage = targetChannel.id === message.channel.id;
      const totalToDelete = includeCommandMessage
        ? Math.min(100, requestedCount + 1)
        : requestedCount;

      const deleted = await targetChannel.bulkDelete(totalToDelete, true).catch((error) => {
        throw error;
      });
      if (includeCommandMessage) {
        results.push(
          `Limpei seu comando e mais ${Math.max(0, (deleted?.size || 0) - 1)} mensagem(ns) em ${targetChannel}`,
        );
      } else {
        results.push(`Limpei ${deleted?.size || 0} mensagem(ns) em ${targetChannel}`);
      }
      continue;
    }

    if (action.type === "close_ticket") {
      const targetChannel =
        (action.channelId ? guild.channels.cache.get(action.channelId) : null) ||
        findBestChannelByName(guild, action.channelName, (channel) => typeof channel.send === "function") ||
        message.channel;

      if (!targetChannel || typeof targetChannel.send !== "function") {
        throw new Error("Nao consegui localizar o canal do ticket para fechar.");
      }

      const ticket = await getOpenTicketByChannel(guild.id, targetChannel.id);
      if (!ticket) {
        throw new Error("Esse canal nao possui ticket aberto vinculado.");
      }

      if (!runtime?.settings || !runtime?.staffSettings) {
        throw new Error("As configuracoes de ticket ainda nao estao prontas neste servidor.");
      }

      const result = await closeOpenTicketChannel({
        client: message.client,
        guild,
        channel: targetChannel,
        ticket,
        actorId: message.author.id,
        runtime: {
          ...runtime,
          accentColor: env.accentColor,
        },
      });

      results.push(
        `Ticket fechado em ${targetChannel} (${result.transcriptAvailable ? "com transcript" : "sem transcript"})`,
      );
      continue;
    }
  }

  return results;
}

async function resolveAdminPlan(message, prompt) {
  const heuristic = heuristicAdminPlan(prompt, message);
  if (heuristic.intent === "execute" || heuristic.intent === "clarify") {
    return heuristic;
  }

  const guildContext = getGuildContext(message.guild);
  const aiPlan = await callOpenAIForAdminPlan(
    prompt,
    await buildAdminActionContext(message, guildContext),
    message.author.id,
  ).catch(() => null);

  if (aiPlan?.intent) {
    return aiPlan;
  }

  return heuristic;
}

async function handleAdminAssistantMessage(message, client) {
  if (!client?.user || !message?.guildId || !isOfficialGuild(message)) {
    return false;
  }

  if (message.author?.bot || message.webhookId) {
    return false;
  }

  const mentionedBot = Boolean(message.mentions?.users?.has?.(client.user.id));
  if (!mentionedBot) {
    return false;
  }

  const prompt = normalizeText(stripBotMention(message.content, client.user.id), 3000);
  if (!prompt || !looksLikeAdminActionRequest(prompt)) {
    return false;
  }

  const authorized = await isAuthorizedAdmin(message);
  if (!authorized) {
    await safeAdminReply(
      message,
      "Eu entendi o pedido, mas esse tipo de acao administrativa eu so executo para quem tem permissao de admin.",
    );
    return true;
  }

  try {
    const plan = await resolveAdminPlan(message, prompt);

    if (!plan || plan.intent === "ignore") {
      return false;
    }

    if (plan.intent === "clarify") {
      await safeAdminReply(
        message,
        plan.clarification || "Consigo fazer isso, mas preciso de um detalhe a mais para executar sem errar.",
      );
      return true;
    }

    const results = await executeAdminActions(message, plan);
    const summary = results.length
      ? results.map((line) => `- ${line}`).join("\n")
      : "- Pedido recebido, mas nao houve nenhuma acao executada.";

    await safeAdminReply(
      message,
      [
        "Feito. Executei isso para voce:",
        summary,
      ].join("\n"),
    );

    return true;
  } catch (error) {
    console.error("[admin-assistant] falha ao executar pedido:", error);
    await safeAdminReply(
      message,
      `Entendi o que voce queria, mas encontrei um problema para executar: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }
}

module.exports = { handleAdminAssistantMessage };

