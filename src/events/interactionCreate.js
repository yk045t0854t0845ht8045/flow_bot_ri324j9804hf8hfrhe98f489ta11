const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const { buildTicketSimpleMessagePayload } = require("../utils/componentFactory");
const {
  claimTicketFromInteraction,
  closeTicketFromInteraction,
  openTicketFromModalSubmit,
  showOpenTicketReasonModal,
  showAdminTicketPanelFromInteraction,
  showMemberTicketPanelFromInteraction,
  showStaffTicketPanelFromInteraction,
} = require("../services/ticketService");

function isTicketButtonInteraction(interaction) {
  return (
    interaction.isButton() &&
    [
      CUSTOM_IDS.openTicket,
      CUSTOM_IDS.claimTicket,
      CUSTOM_IDS.closeTicket,
      CUSTOM_IDS.ticketAdminPanel,
      CUSTOM_IDS.ticketStaffPanel,
      CUSTOM_IDS.ticketMemberPanel,
    ].includes(interaction.customId)
  );
}

function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}

async function replyWithTicketErrorPayload(interaction, payload) {
  const normalizedPayload = {
    ...payload,
    flags: (payload.flags || 0) | MessageFlags.Ephemeral,
  };

  if (interaction.deferred && !interaction.replied) {
    await interaction.followUp(normalizedPayload).catch(() => null);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(normalizedPayload).catch(() => null);
    return;
  }

  await interaction.reply(normalizedPayload).catch(() => null);
}

function buildGenericCommandErrorPayload() {
  return {
    content:
      "Nao consegui concluir este comando agora.\nTente novamente em alguns segundos ou acompanhe o status da plataforma.",
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Verificar status")
          .setURL("https://status.flwdesk.com"),
      ),
    ],
  };
}

module.exports = {
  name: "interactionCreate",
  async execute(interaction, client) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        await command.execute(interaction, client);
        return;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === CUSTOM_IDS.openTicketReasonModal) {
          await openTicketFromModalSubmit(interaction);
        }
        return;
      }

      if (!interaction.isButton()) return;

      if (
        interaction.customId === CUSTOM_IDS.openTicket &&
        !interaction.deferred &&
        !interaction.replied
      ) {
        await showOpenTicketReasonModal(interaction);
        return;
      }

      if (isTicketButtonInteraction(interaction) && !interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }

      if (interaction.customId === CUSTOM_IDS.claimTicket) {
        await claimTicketFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.closeTicket) {
        await closeTicketFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.ticketAdminPanel) {
        await showAdminTicketPanelFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.ticketStaffPanel) {
        await showStaffTicketPanelFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.ticketMemberPanel) {
        await showMemberTicketPanelFromInteraction(interaction);
      }
    } catch (error) {
      if (isUnknownInteractionError(error)) {
        const interactionAgeMs =
          typeof interaction?.createdTimestamp === "number"
            ? Date.now() - interaction.createdTimestamp
            : null;
        console.warn("[interactionCreate] Interacao expirada antes de ser reconhecida.", {
          interactionId: interaction?.id || null,
          customId: interaction?.customId || null,
          createdTimestamp: interaction?.createdTimestamp || null,
          interactionAgeMs,
        });
        return;
      }

      console.error(error);

      if (interaction.isChatInputCommand()) {
        await replyWithTicketErrorPayload(
          interaction,
          buildGenericCommandErrorPayload(),
        );
        return;
      }

      const payload = buildTicketSimpleMessagePayload({
        title: "Falha na solicitacao",
        message:
          "Ocorreu um erro ao processar sua solicitacao. Verifique os IDs e permissoes no .env.",
        tone: "error",
      });

      await replyWithTicketErrorPayload(interaction, payload);
    }
  },
};
