const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { env } = require("./config/env");
const { loadCommands } = require("./handlers/commandHandler");
const { loadEvents } = require("./handlers/eventHandler");
const { initRealtimeListeners } = require("./services/realtimeService");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
});

loadCommands(client);
loadEvents(client);

client.once("ready", () => {
  initRealtimeListeners(client);
});

client.login(env.discordToken);

process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
});
