const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { env } = require("./config/env");
const { loadCommands } = require("./handlers/commandHandler");
const { loadEvents } = require("./handlers/eventHandler");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

loadCommands(client);
loadEvents(client);

client.login(env.discordToken);

process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});
