const { SlashCommandBuilder } = require("discord.js");
const { claimTicketFromInteraction } = require("../services/ticketService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("assumir")
    .setDescription("Assume o ticket atual para a equipe de suporte."),

  async execute(interaction) {
    await claimTicketFromInteraction(interaction);
  },
};
