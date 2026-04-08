const crypto = require("node:crypto");

const DEFAULT_PUBLIC_APP_ORIGIN = "https://flwdesk.com";

function getTranscriptAccessSecret() {
  const secret =
    process.env.TRANSCRIPT_ACCESS_SECRET?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";

  if (!secret) {
    throw new Error("Variavel de segredo do transcript ausente.");
  }

  return secret;
}

function normalizeBaseOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
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

function createTranscriptAccessCode() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function hashTranscriptAccessCode(protocol, code) {
  return crypto
    .createHmac("sha256", getTranscriptAccessSecret())
    .update(`${String(protocol || "").trim()}:${String(code || "").trim()}`)
    .digest("hex");
}

module.exports = {
  buildTranscriptUrl,
  createTranscriptAccessCode,
  hashTranscriptAccessCode,
  resolveAppOrigin,
};
