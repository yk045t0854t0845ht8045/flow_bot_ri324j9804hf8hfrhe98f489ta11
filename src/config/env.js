const { existsSync } = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const projectRoot = path.resolve(__dirname, "..", "..");
const envCandidates = [
  path.resolve(projectRoot, ".env"),
  path.resolve(projectRoot, "site", ".env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "site", ".env"),
];

for (const envPath of [...new Set(envCandidates)]) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }
}

const DEFAULT_PUBLIC_APP_URL = "https://www.flwdesk.com";

const REQUIRED_KEYS = [
  "DISCORD_CLIENT_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function requireEnv(key) {
  const value = process.env[key];

  if (!value) {
    throw new Error(`Variavel obrigatoria ausente no .env: ${key}`);
  }

  return value;
}

function requireAnyEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  throw new Error(`Variavel obrigatoria ausente no .env: ${keys.join(" ou ")}`);
}

function optionalEnv(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseListEnv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAccentColor(value) {
  if (!value) return 0x2d7ff9;

  if (value.startsWith("#")) {
    return Number.parseInt(value.slice(1), 16);
  }

  if (value.toLowerCase().startsWith("0x")) {
    return Number.parseInt(value.slice(2), 16);
  }

  return Number.parseInt(value, 10);
}

function parseBoolean(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

for (const key of REQUIRED_KEYS) {
  requireEnv(key);
}

const env = {
  discordToken: requireAnyEnv("DISCORD_TOKEN", "DISCORD_BOT_TOKEN"),
  discordClientId: requireEnv("DISCORD_CLIENT_ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID || null,
  officialSupportGuildId:
    process.env.OFFICIAL_SUPPORT_GUILD_ID || "1353259338759671838",
  officialLinkChannelId:
    process.env.OFFICIAL_LINK_CHANNEL_ID || "1358209486363295885",
  officialLinkedRoleId:
    process.env.OFFICIAL_LINKED_ROLE_ID || "1358203612672692495",
  officialAccountLinkUrl:
    process.env.OFFICIAL_ACCOUNT_LINK_URL ||
    `${DEFAULT_PUBLIC_APP_URL}/discord/link/start`,
  officialTermsUrl:
    process.env.OFFICIAL_TERMS_URL || `${DEFAULT_PUBLIC_APP_URL}/terms`,
  officialPrivacyUrl:
    process.env.OFFICIAL_PRIVACY_URL || `${DEFAULT_PUBLIC_APP_URL}/privacy`,
  autoDeployCommands: parseBoolean(process.env.DISCORD_AUTO_DEPLOY_COMMANDS, true),
  appUrl:
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    process.env.SITE_URL ||
    DEFAULT_PUBLIC_APP_URL,
  supportRoleId: optionalEnv("TICKET_SUPPORT_ROLE_ID"),
  ticketCategoryId: optionalEnv("TICKET_CATEGORY_ID"),
  ticketLogChannelId: optionalEnv("TICKET_LOG_CHANNEL_ID"),
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseServiceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  openCooldownSeconds: parseNumber(process.env.TICKET_OPEN_COOLDOWN_SECONDS, 120),
  maxOpenTicketsPerUser: parseNumber(process.env.TICKET_MAX_OPEN_PER_USER, 1),
  deleteDelaySeconds: parseNumber(process.env.TICKET_DELETE_DELAY_SECONDS, 8),
  accentColor: parseAccentColor(process.env.TICKET_ACCENT_COLOR),
  panelTitle: process.env.TICKET_PANEL_TITLE || "Central de Atendimento",
  panelDescription:
    process.env.TICKET_PANEL_DESCRIPTION ||
    "Use o botao abaixo para abrir seu ticket privado.",
  openaiApiKey: optionalEnv("OPENAI_API_KEY"),
  openaiModel: optionalEnv("OPENAI_MODEL") || "gpt-4",
  openaiModelFallbacks: parseListEnv(process.env.OPENAI_MODEL_FALLBACKS),
  openaiBaseUrl: optionalEnv("OPENAI_BASE_URL") || "https://api.openai.com/v1",
  aiMentionLogChannelId:
    optionalEnv("AI_MENTION_LOG_CHANNEL_ID") || "1490014859344085242",
  autoJoinVoiceChannelIds: parseListEnv(
    process.env.DISCORD_AUTO_JOIN_VOICE_CHANNEL_IDS ||
      "1491968642492010548,1486467867380682852",
  ),
};

module.exports = { env };
