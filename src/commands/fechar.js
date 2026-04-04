const { SlashCommandBuilder } = require("discord.js");
const { closeTicketFromInteraction } = require("../services/ticketService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("fechar")
    .setDescription("Fecha o ticket atual, gera transcript e envia no log."),

  async execute(interaction) {
    await closeTicketFromInteraction(interaction);
  },
};
