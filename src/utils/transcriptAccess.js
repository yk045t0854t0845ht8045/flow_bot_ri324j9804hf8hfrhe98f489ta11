const crypto = require("node:crypto");

const DEFAULT_PUBLIC_APP_ORIGIN = "https://www.flwdesk.com";
const LEGACY_PUBLIC_APP_HOSTS = new Set(["flwdesk.com"]);

function getTranscriptAccessSecret() {
  const transcriptSecret = process.env.TRANSCRIPT_ACCESS_SECRET?.trim() || "";
  if (transcriptSecret) return transcriptSecret;

  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new Error("Variavel TRANSCRIPT_ACCESS_SECRET ausente.");
  }

  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";

  if (!secret) {
    throw new Error("Variavel de segredo do transcript ausente.");
  }

  return secret;
}

function normalizeBaseOrigin(value) {
  const normalizedValue = String(value || "").trim().replace(/\/+$/, "");
  if (!normalizedValue) {
    return "";
  }

  try {
    const parsed = new URL(normalizedValue);
    if (LEGACY_PUBLIC_APP_HOSTS.has(parsed.hostname.toLowerCase())) {
      return DEFAULT_PUBLIC_APP_ORIGIN;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    const legacyHostPattern = /^https?:\/\/flwdesk\.com(?:\/.*)?$/i;
    if (legacyHostPattern.test(normalizedValue)) {
      return DEFAULT_PUBLIC_APP_ORIGIN;
    }
    return normalizedValue;
  }
}

function resolveAppOrigin() {
  const explicitOrigin =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    process.env.SITE_URL?.trim() ||
    "";

  if (explicitOrigin) {
    return normalizeBaseOrigin(explicitOrigin);
  }

  const officialLinkUrl =
    process.env.OFFICIAL_ACCOUNT_LINK_URL?.trim() ||
    `${DEFAULT_PUBLIC_APP_ORIGIN}/discord/link/start`;

  if (officialLinkUrl) {
    try {
      return normalizeBaseOrigin(new URL(officialLinkUrl).origin);
    } catch {
      // Ignore invalid URL and continue to fallbacks below.
    }
  }

  return DEFAULT_PUBLIC_APP_ORIGIN;
}

function buildTranscriptUrl(protocol) {
  return `${resolveAppOrigin()}/transcripts/${encodeURIComponent(
    String(protocol || "").trim(),
  )}/`;
}

function normalizeTranscriptAccessCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32);
}

function formatTranscriptAccessCode(code) {
  const normalized = normalizeTranscriptAccessCode(code);
  if (!normalized) return "";
  return normalized.match(/.{1,4}/g)?.join("-") || normalized;
}

function buildTranscriptAccessUrl(protocol, code) {
  const formattedCode = formatTranscriptAccessCode(code);
  const baseUrl = buildTranscriptUrl(protocol).replace(/\/+$/, "");
  return formattedCode ? `${baseUrl}/${encodeURIComponent(formattedCode)}` : `${baseUrl}/`;
}

function createTranscriptAccessCode() {
  return normalizeTranscriptAccessCode(crypto.randomBytes(6).toString("base64url")).slice(0, 8);
}

function hashTranscriptAccessCode(protocol, code) {
  return crypto
    .createHmac("sha256", getTranscriptAccessSecret())
    .update(`${String(protocol || "").trim()}:${normalizeTranscriptAccessCode(code)}`)
    .digest("hex");
}

module.exports = {
  buildTranscriptAccessUrl,
  buildTranscriptUrl,
  createTranscriptAccessCode,
  formatTranscriptAccessCode,
  hashTranscriptAccessCode,
  normalizeTranscriptAccessCode,
  resolveAppOrigin,
};
