const { REST, Routes } = require("discord.js");
const { env } = require("../config/env");

function buildSlashCommandsPayload(client) {
  if (!client?.commands?.size) return [];

  return [...client.commands.values()]
    .filter((command) => command?.data && typeof command.data.toJSON === "function")
    .map((command) => command.data.toJSON());
}

async function syncSlashCommandsForClient(client) {
  const commands = buildSlashCommandsPayload(client);
  if (!commands.length) {
    return {
      deployed: false,
      count: 0,
      scope: "none",
      reason: "no-commands",
    };
  }

  const rest = new REST({ version: "10" }).setToken(env.discordToken);
  const applicationId =
    (typeof env.discordClientId === "string" && env.discordClientId.trim()) ||
    client?.user?.id ||
    null;

  if (!applicationId) {
    throw new Error(
      "Nao foi possivel resolver o application id para sincronizar slash commands.",
    );
  }

  if (env.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, env.discordGuildId), {
      body: commands,
    });

    return {
      deployed: true,
      count: commands.length,
      scope: `guild:${env.discordGuildId}`,
      reason: "ok",
    };
  }

  await rest.put(Routes.applicationCommands(applicationId), {
    body: commands,
  });

  return {
    deployed: true,
    count: commands.length,
    scope: "global",
    reason: "ok",
  };
}

module.exports = {
  syncSlashCommandsForClient,
};
