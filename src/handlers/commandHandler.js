const fs = require("node:fs");
const path = require("node:path");
const { Collection } = require("discord.js");

function loadCommands(client) {
  client.commands = new Collection();

  const commandsPath = path.join(__dirname, "..", "commands");
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((file) => file.endsWith(".js"));

  for (const file of commandFiles) {
    const fullPath = path.join(commandsPath, file);
    const command = require(fullPath);

    if (!command.data || !command.execute) {
      // Ignora arquivos que nao seguem o contrato esperado.
      continue;
    }

    client.commands.set(command.data.name, command);
  }
}

module.exports = { loadCommands };
