const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config();
const { REST, Routes } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  throw new Error("Defina DISCORD_TOKEN e DISCORD_CLIENT_ID no .env.");
}

const commandsPath = path.join(__dirname, "commands");
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith(".js"));

const commands = commandFiles
  .map((file) => require(path.join(commandsPath, file)))
  .filter((command) => command.data)
  .map((command) => command.data.toJSON());

const rest = new REST({ version: "10" }).setToken(token);

async function deploy() {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(
      `Slash commands registrados no servidor ${guildId}: ${commands.length}`,
    );
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log(`Slash commands globais registrados: ${commands.length}`);
}

deploy().catch((error) => {
  console.error("Falha ao registrar comandos:", error);
  process.exit(1);
});
