const crypto = require("node:crypto");
const { env } = require("../config/env");

const FLOWAI_SIGNATURE_VERSION = "v1";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_RETRIES = 2;

function nowMs() {
  return Date.now();
}

function normalizeText(value, maxLength = 10_000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function readRetryAfterMs(headers) {
  const rawValue = headers?.get?.("retry-after") || "";
  const numericSeconds = Number(rawValue);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return numericSeconds * 1000;
  }

  const retryAt = new Date(rawValue);
  const retryAtMs = retryAt.getTime();
  if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
    return retryAtMs - Date.now();
  }

  return null;
}

function createBodyDigest(rawBody) {
  return crypto.createHash("sha256").update(rawBody).digest("hex");
}

function createRequestSignature(secret, timestamp, rawBody) {
  return crypto
    .createHmac("sha256", secret)
    .update(
      `${FLOWAI_SIGNATURE_VERSION}:${timestamp}:${createBodyDigest(rawBody)}`,
      "utf8",
    )
    .digest("hex");
}

function buildHeaders(rawBody) {
  const headers = {
    "Content-Type": "application/json",
    "x-flowai-client": "flowdesk-discord-bot",
    "x-flowai-signature-version": FLOWAI_SIGNATURE_VERSION,
  };

  if (env.flowAiApiToken) {
    headers.Authorization = `Bearer ${env.flowAiApiToken}`;
    headers["x-flowai-token"] = env.flowAiApiToken;
  }

  if (env.flowAiSigningSecret) {
    const timestamp = String(nowMs());
    headers["x-flowai-timestamp"] = timestamp;
    headers["x-flowai-signature"] = createRequestSignature(
      env.flowAiSigningSecret,
      timestamp,
      rawBody,
    );
  }

  return headers;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function sendFlowAiRequest(rawBody) {
  if (!env.flowAiApiUrl) {
    throw new Error("FLOWAI_API_URL nao configurada.");
  }

  const bodyBytes = Buffer.byteLength(rawBody, "utf8");
  if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
    throw new Error("Payload da FlowAI excedeu o limite seguro.");
  }

  const maxRetries =
    Number.isFinite(env.flowAiApiMaxRetries) && env.flowAiApiMaxRetries >= 0
      ? env.flowAiApiMaxRetries
      : DEFAULT_MAX_RETRIES;

  let lastResponse = null;
  let lastPayload = null;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        env.flowAiApiUrl,
        {
          method: "POST",
          headers: buildHeaders(rawBody),
          body: rawBody,
        },
        env.flowAiApiTimeoutMs,
      );

      const rawText = await response.text().catch(() => "");
      let payload = null;

      try {
        payload = rawText ? JSON.parse(rawText) : null;
      } catch {
        payload = null;
      }

      lastResponse = response;
      lastPayload = payload;

      if (response.ok && payload?.ok) {
        return payload.result;
      }

      const message =
        normalizeText(payload?.message || rawText || "", 400) ||
        `FlowAI respondeu com HTTP ${response.status}.`;
      const error = new Error(message);
      lastError = error;

      if (attempt >= maxRetries || !isRetryableStatus(response.status)) {
        break;
      }

      const retryAfterMs = readRetryAfterMs(response.headers);
      await delay(
        retryAfterMs !== null
          ? Math.max(250, retryAfterMs)
          : Math.min(2500, 300 * (attempt + 1)),
      );
    } catch (error) {
      const abortError =
        error instanceof DOMException && error.name === "AbortError";
      lastError = new Error(
        abortError
          ? "Timeout ao consultar a FlowAI interna."
          : `Falha de rede ao consultar a FlowAI: ${normalizeText(error?.message || error || "", 320)}`,
      );

      if (attempt >= maxRetries) {
        break;
      }

      await delay(Math.min(2500, 350 * (attempt + 1)));
    }
  }

  if (lastError) {
    throw lastError;
  }

  if (lastResponse && lastPayload) {
    const message =
      normalizeText(lastPayload?.message || "", 400) ||
      `FlowAI respondeu com HTTP ${lastResponse.status}.`;
    throw new Error(message);
  }

  throw new Error("Falha desconhecida ao consultar a FlowAI.");
}

async function callFlowAiApi(task, input) {
  const rawBody = JSON.stringify({
    task,
    input,
  });

  return await sendFlowAiRequest(rawBody);
}

async function requestFlowAiChat({
  taskKey,
  messages,
  userId,
  temperature,
  maxTokens,
  cacheKey,
  cacheTtlMs,
  preferredModel,
  timeoutMs,
}) {
  const result = await callFlowAiApi("chat", {
    taskKey,
    messages,
    userId,
    temperature,
    maxTokens,
    cacheKey,
    cacheTtlMs,
    preferredModel,
    timeoutMs,
  });

  return {
    content: normalizeText(result?.content || "", 9_000),
    model: result?.model || null,
    latencyMs:
      typeof result?.latencyMs === "number" ? result.latencyMs : null,
    adaptive: result?.adaptive || null,
  };
}

async function requestFlowAiJson({
  taskKey,
  messages,
  userId,
  temperature,
  maxTokens,
  cacheKey,
  cacheTtlMs,
  preferredModel,
  timeoutMs,
}) {
  const result = await callFlowAiApi("json", {
    taskKey,
    messages,
    userId,
    temperature,
    maxTokens,
    cacheKey,
    cacheTtlMs,
    preferredModel,
    timeoutMs,
  });

  return {
    object: result?.object || null,
    rawContent: normalizeText(result?.rawContent || "", 9_000),
    model: result?.model || null,
    latencyMs:
      typeof result?.latencyMs === "number" ? result.latencyMs : null,
    adaptive: result?.adaptive || null,
  };
}

async function requestFlowAiHealth() {
  return await callFlowAiApi("health", {});
}

module.exports = {
  requestFlowAiChat,
  requestFlowAiJson,
  requestFlowAiHealth,
};
