const {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  buildTicketPanelPayload,
  buildTicketSimpleMessagePayload,
} = require("../utils/componentFactory");
const {
  getGuildTicketRuntime,
  updateGuildTicketPanelMessageId,
} = require("../services/supabaseService");

function walkComponents(components, visitor) {
  if (!Array.isArray(components)) return;

  for (const component of components) {
    if (!component) continue;
    visitor(component);

    if (Array.isArray(component.components) && component.components.length) {
      walkComponents(component.components, visitor);
    }
  }
}

function messageLooksLikeTicketPanel(message) {
  if (!message?.author?.bot || message.author.id !== message.client.user.id) {
    return false;
  }

  let foundOpenButton = false;
  walkComponents(message.components, (component) => {
    const customId = component.customId || component.data?.custom_id;
    if (customId === CUSTOM_IDS.openTicket) {
      foundOpenButton = true;
    }
  });

  return foundOpenButton;
}

async function fetchExistingTicketPanelMessage(channel, storedMessageId = null) {
  if (storedMessageId) {
    const storedMessage = await channel.messages
      .fetch(storedMessageId)
      .catch(() => null);

    if (storedMessage && messageLooksLikeTicketPanel(storedMessage)) {
      return storedMessage;
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 25 });
  return (
    recentMessages.find((message) => messageLooksLikeTicketPanel(message)) || null
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ticket-painel")
    .setDescription("Publica o painel com botao para abrir ticket.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((option) =>
      option
        .setName("canal")
        .setDescription("Canal onde o painel sera enviado.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),

  async execute(interaction) {
    const targetChannel =
      interaction.options.getChannel("canal", false) || interaction.channel;

    if (!targetChannel?.isTextBased()) {
      await interaction.reply({
        ...buildTicketSimpleMessagePayload({
          title: "Canal invalido",
          message: "Canal invalido para enviar painel.",
          tone: "error",
        }),
        flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
      });
      return;
    }

    const runtime = await getGuildTicketRuntime(interaction.guild.id);
    const payload = buildTicketPanelPayload({
      settings: runtime.settings,
    });
    const shouldTrackPanelMessage =
      runtime.settings?.menu_channel_id === targetChannel.id;

    let panelMessage = null;
    if (shouldTrackPanelMessage) {
      const existingMessage = await fetchExistingTicketPanelMessage(
        targetChannel,
        runtime.settings?.panel_message_id || null,
      );

      panelMessage = existingMessage
        ? await existingMessage.edit(payload)
        : await targetChannel.send(payload);

      await updateGuildTicketPanelMessageId(interaction.guild.id, panelMessage.id);
    } else {
      panelMessage = await targetChannel.send(payload);
    }

    await interaction.reply({
      ...buildTicketSimpleMessagePayload({
        title: "Painel publicado",
        message: `Painel publicado em <#${targetChannel.id}>${panelMessage?.id ? ` (\`${panelMessage.id}\`)` : ""}.`,
        tone: "success",
      }),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  },
};
