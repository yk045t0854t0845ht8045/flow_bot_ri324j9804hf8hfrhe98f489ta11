const { env } = require("../config/env");

function normalizeText(value, maxLength = 10_000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function buildHeaders() {
  const headers = {
    "Content-Type": "application/json",
  };

  if (env.flowAiApiToken) {
    headers.Authorization = `Bearer ${env.flowAiApiToken}`;
    headers["x-flowai-token"] = env.flowAiApiToken;
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

async function callFlowAiApi(task, input) {
  if (!env.flowAiApiUrl) {
    throw new Error("FLOWAI_API_URL nao configurada.");
  }

  const response = await fetchWithTimeout(
    env.flowAiApiUrl,
    {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        task,
        input,
      }),
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

  if (!response.ok || !payload?.ok) {
    const message =
      normalizeText(payload?.message || rawText || "", 400) ||
      `FlowAI respondeu com HTTP ${response.status}.`;

    throw new Error(message);
  }

  return payload.result;
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
