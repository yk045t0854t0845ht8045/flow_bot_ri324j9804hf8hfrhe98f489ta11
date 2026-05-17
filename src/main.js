const fs = require("node:fs");
const path = require("node:path");

function writeErrorLog(type, error) {
  try {
    const logDir = path.resolve(__dirname, "..", "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFilePath = path.join(logDir, "startup-error.log");
    const rootLogFilePath = path.resolve(__dirname, "..", "startup-error.log");

    const errorMessage = `[${new Date().toISOString()}] [${type}] ${error?.stack || error || "Erro desconhecido"}\n`;

    fs.appendFileSync(logFilePath, errorMessage, "utf8");
    fs.appendFileSync(rootLogFilePath, errorMessage, "utf8");
  } catch (err) {
    console.error("Falha ao gravar arquivo de log fisico:", err);
  }
}

// Inicializa ouvintes de eventos de exceção globais na linha 1
process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error);
  writeErrorLog("unhandledRejection", error);
});

process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error);
  writeErrorLog("uncaughtException", error);
});

try {
  const { Client, GatewayIntentBits, Partials } = require("discord.js");
  const { env } = require("./config/env");
  const { loadCommands } = require("./handlers/commandHandler");
  const { loadEvents } = require("./handlers/eventHandler");
  const { startHealthServer } = require("./services/healthServerService");

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
  startHealthServer(client);

  client.login(env.discordToken).catch((loginError) => {
    console.error("[login-error] Falha ao logar no Discord. Verifique o TOKEN!", loginError);
    writeErrorLog("login-error", loginError);
  });

} catch (bootstrapError) {
  console.error("==========================================================");
  console.error("[bootstrap-error] FALHA CRITICA NA INICIALIZACAO DO BOT:");
  console.error(bootstrapError);
  console.error("==========================================================");
  
  writeErrorLog("bootstrap-error", bootstrapError);

  console.error("O erro foi gravado no arquivo 'startup-error.log' na raiz.");
  console.error("O processo permanecera aberto por 25 segundos para leitura.");

  setTimeout(() => {
    process.exit(1);
  }, 25000);
}
