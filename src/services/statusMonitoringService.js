const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const dns = require("dns").promises;
const https = require("https");
const os = require("os");
const { requestFlowAiHealth } = require("./flowAiClient");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
const STATUS_RPC_NAME = "system_status_ingest_check";
const MONITOR_LEASE_RPC = "system_status_acquire_runtime_lease";
const CLAIM_OUTBOX_RPC = "system_status_claim_outbox_batch";
const COMPLETE_OUTBOX_RPC = "system_status_complete_outbox_item";
const FAIL_OUTBOX_RPC = "system_status_fail_outbox_item";
const RECONCILE_INCIDENTS_RPC = "system_status_reconcile_open_incidents";
const MONITOR_LEASE_NAME = "status-heartbeat-primary";
const MONITOR_WORKER_ID = `${os.hostname()}:${process.pid}:status-heartbeat`;

const webhookCooldowns = {};
let hasLoggedRpcFallback = false;
let hasLoggedLeaseFallback = false;
let hasLoggedOutboxFallback = false;
let hasLoggedReconcileFallback = false;
let heartbeatInFlight = false;

async function withRetry(fn, retries = 2) {
  let lastError = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  try {
    return await fn();
  } catch (error) {
    throw error || lastError || new Error("Falha apos retentativas");
  }
}

function normalizeStatusMessage(value, maxLength = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function statusWeight(status) {
  switch (status) {
    case "major_outage":
      return 4;
    case "partial_outage":
      return 3;
    case "degraded_performance":
      return 2;
    case "under_maintenance":
      return 1;
    case "operational":
    default:
      return 1;
  }
}

function median(values) {
  const sorted = [...values]
    .filter((value) => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return sorted[middle];
}

function summarizeProbeSeries(samples, metadata = {}) {
  const safeSamples = Array.isArray(samples) ? samples : [];
  const sampleSize = safeSamples.length || 1;
  const majorCount = safeSamples.filter((sample) => sample.status === "major_outage").length;
  const partialCount = safeSamples.filter((sample) => sample.status === "partial_outage").length;
  const degradedCount = safeSamples.filter((sample) => sample.status === "degraded_performance").length;
  const successCount = safeSamples.filter((sample) => sample.status === "operational").length;
  const failureCount = majorCount + partialCount;
  const confidenceScore = Math.round(
    (Math.max(successCount, degradedCount, failureCount, 1) / sampleSize) * 10000,
  ) / 100;

  let rawStatus = "operational";
  if (majorCount >= 2) {
    rawStatus = "major_outage";
  } else if (failureCount >= 2) {
    rawStatus = "partial_outage";
  } else if (degradedCount >= 2) {
    rawStatus = "degraded_performance";
  }

  const worstSample = [...safeSamples].sort(
    (left, right) => statusWeight(right.status) - statusWeight(left.status),
  )[0];
  const latencyMs = median(safeSamples.map((sample) => sample.latencyMs));
  const responseCode =
    worstSample?.responseCode ??
    safeSamples.find((sample) => sample.responseCode != null)?.responseCode ??
    null;
  const message =
    normalizeStatusMessage(
      worstSample?.message ||
        safeSamples.find((sample) => sample.message)?.message ||
        "",
      260,
    ) || null;

  return {
    rawStatus,
    status: rawStatus,
    latencyMs,
    responseCode,
    message,
    metadata: {
      ...metadata,
      sampleSize,
      successCount,
      degradedCount,
      failureCount,
      majorCount,
      partialCount,
      confidenceScore,
      sampleStatuses: safeSamples.map((sample) => sample.status),
    },
  };
}

async function runSeriesCheck({ attempts = 3, metadata = {}, run }) {
  const samples = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const sample = await run(attempt);
      samples.push({
        status: sample?.status || "partial_outage",
        latencyMs:
          typeof sample?.latencyMs === "number" && Number.isFinite(sample.latencyMs)
            ? Math.round(sample.latencyMs)
            : null,
        responseCode:
          typeof sample?.responseCode === "number" && Number.isFinite(sample.responseCode)
            ? sample.responseCode
            : null,
        message: normalizeStatusMessage(sample?.message, 260),
      });
    } catch (error) {
      samples.push({
        status: "partial_outage",
        latencyMs: null,
        responseCode: null,
        message: normalizeStatusMessage(error?.message || error, 260),
      });
    }
  }

  return summarizeProbeSeries(samples, metadata);
}

function isLocalHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  );
}

function isLocalFlowAiEndpoint() {
  try {
    return isLocalHostname(new URL(env.flowAiApiUrl).hostname);
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function persistStatusResult(result, observedAt) {
  const payload = {
    p_component_name: result.name,
    p_raw_status: result.rawStatus || result.status,
    p_latency_ms:
      typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs)
        ? Math.round(result.latencyMs)
        : null,
    p_message: normalizeStatusMessage(result.message),
    p_response_code:
      typeof result.responseCode === "number" && Number.isFinite(result.responseCode)
        ? result.responseCode
        : null,
    p_source_key: result.sourceKey || null,
    p_metadata: result.metadata || {},
    p_observed_at: observedAt.toISOString(),
  };

  try {
    const row = await withRetry(async () => {
      const response = await supabase.rpc(STATUS_RPC_NAME, payload);
      if (response.error) {
        throw response.error;
      }
      return response.data?.[0] || null;
    }, 1);

    if (row) {
      return {
        ...result,
        rawStatus: row.raw_status || payload.p_raw_status,
        status: row.stable_status || result.status,
        shouldAlert: Boolean(row.should_alert),
      };
    }
  } catch (error) {
    if (!hasLoggedRpcFallback) {
      hasLoggedRpcFallback = true;
      console.warn(
        `[status-system] RPC ${STATUS_RPC_NAME} indisponivel, usando fallback local: ${error?.message || error}`,
      );
    }
  }

  const { data: component, error: componentError } = await supabase
    .from("system_components")
    .select("id")
    .eq("name", result.name)
    .single();

  if (componentError) {
    throw componentError;
  }

  await supabase
    .from("system_components")
    .update({
      status: result.status,
      latency_ms: payload.p_latency_ms,
      source_key: payload.p_source_key,
      status_message: payload.p_message || null,
      last_checked_at: payload.p_observed_at,
      last_raw_status: payload.p_raw_status,
      last_raw_checked_at: payload.p_observed_at,
      updated_at: observedAt.toISOString(),
    })
    .eq("id", component.id);

  await supabase.from("system_status_history").upsert(
    {
      component_id: component.id,
      recorded_at: observedAt.toISOString().split("T")[0],
      status: result.status,
    },
    { onConflict: "component_id,recorded_at" },
  );

  return {
    ...result,
    shouldAlert: result.status === "major_outage",
  };
}

async function acquireMonitorLease() {
  try {
    const { data, error } = await supabase.rpc(MONITOR_LEASE_RPC, {
      p_lease_name: MONITOR_LEASE_NAME,
      p_holder_id: MONITOR_WORKER_ID,
      p_ttl_seconds: 110,
      p_metadata: {
        pid: process.pid,
        hostname: os.hostname(),
        service: "status-heartbeat",
      },
    });

    if (error) {
      throw error;
    }

    return Boolean(data);
  } catch (error) {
    if (!hasLoggedLeaseFallback) {
      hasLoggedLeaseFallback = true;
      console.warn(
        `[status-system] Lease distribuido indisponivel, usando modo local: ${error?.message || error}`,
      );
    }
    return true;
  }
}

async function claimNotificationBatch(limit = 10) {
  try {
    const { data, error } = await supabase.rpc(CLAIM_OUTBOX_RPC, {
      p_worker_id: MONITOR_WORKER_ID,
      p_limit: limit,
      p_visibility_timeout_seconds: 300,
    });

    if (error) {
      throw error;
    }

    return Array.isArray(data) ? data : [];
  } catch (error) {
    if (!hasLoggedOutboxFallback) {
      hasLoggedOutboxFallback = true;
      console.warn(
        `[status-system] Worker do outbox indisponivel, usando alerta direto: ${error?.message || error}`,
      );
    }
    return null;
  }
}

async function completeNotification(id, metadata = {}) {
  const { error } = await supabase.rpc(COMPLETE_OUTBOX_RPC, {
    p_notification_id: id,
    p_delivery_metadata: metadata,
  });

  if (error) {
    throw error;
  }
}

async function failNotification(id, errorDetails, metadata = {}) {
  const { error } = await supabase.rpc(FAIL_OUTBOX_RPC, {
    p_notification_id: id,
    p_error: normalizeStatusMessage(errorDetails, 500),
    p_retry_seconds: 300,
    p_max_attempts: 8,
    p_error_metadata: metadata,
  });

  if (error) {
    throw error;
  }
}

async function reconcileOpenIncidents() {
  try {
    const { error } = await supabase.rpc(RECONCILE_INCIDENTS_RPC);
    if (error) {
      throw error;
    }
  } catch (error) {
    if (!hasLoggedReconcileFallback) {
      hasLoggedReconcileFallback = true;
      console.warn(
        `[status-system] Conciliacao automatica de incidentes indisponivel: ${error?.message || error}`,
      );
    }
  }
}

async function sendCriticalWebhook(systemName, errorDetails, options = {}) {
  const WEBHOOK_URL =
    "https://ptb.discord.com/api/webhooks/1494175603396579378/GwwNok_2Wh0AFsZJf4W6kn-Egwnr_oWiVzoIzabCtuV2wt3R-r7HpzZQb56r541Gmvsh";
  const { bypassCooldown = false } = options;
  const now = Date.now();
  const lastSent = webhookCooldowns[systemName] || 0;

  if (!bypassCooldown && now - lastSent < 1000 * 60 * 30) {
    return false;
  }

  const formattedDetails = errorDetails
    ? String(errorDetails)
    : "Nenhum detalhe adicional (timeout ou rede).";
  let firstPart = formattedDetails;
  let secondPart = null;

  if (formattedDetails.length > 3800) {
    firstPart = formattedDetails.substring(0, 3800);
    secondPart = formattedDetails.substring(3800, 7600);
  }

  const embeds = [
    {
      title: "Falha Critica Detectada",
      color: 0xff0000,
      description: `O componente **${systemName}** entrou em falha critica.\n\n**Causa capturada:**\n\`\`\`json\n${firstPart}\n\`\`\``,
      timestamp: new Date().toISOString(),
    },
  ];

  if (secondPart) {
    embeds.push({
      title: "Continuacao do Log",
      color: 0xff0000,
      description: `\`\`\`json\n${secondPart}\n\`\`\``,
    });
  }

  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds }),
  });

  if (!response.ok) {
    throw new Error(`Webhook respondeu com HTTP ${response.status}`);
  }

  webhookCooldowns[systemName] = now;
  return true;
}

async function drainStatusNotificationOutbox() {
  const notifications = await claimNotificationBatch(10);
  if (notifications === null) {
    return false;
  }

  for (const notification of notifications) {
    try {
      const payload = notification.payload || {};
      const stableStatus = payload.stable_status || null;

      if (notification.event_type === "component_alert" && stableStatus !== "major_outage") {
        await completeNotification(notification.id, {
          delivered_by: MONITOR_WORKER_ID,
          skipped_reason: "non_critical_component_alert",
          processed_at: new Date().toISOString(),
        });
        continue;
      }

      await sendCriticalWebhook(
        payload.component_name || "Componente",
        payload.message || `Status confirmado: ${stableStatus || "unknown"}`,
        { bypassCooldown: true },
      );

      await completeNotification(notification.id, {
        delivered_by: MONITOR_WORKER_ID,
        processed_at: new Date().toISOString(),
      });
    } catch (error) {
      try {
        await failNotification(notification.id, error?.message || error, {
          failed_by: MONITOR_WORKER_ID,
          processed_at: new Date().toISOString(),
        });
      } catch (failError) {
        console.error("[status-system] erro ao reencaminhar outbox:", failError);
      }
    }
  }

  return true;
}

function startStatusHeartbeat(client) {
  console.log("[status-system] Iniciando monitoramento real-time profissional...");
  void checkAllSystems(client);
  setInterval(() => {
    void checkAllSystems(client);
  }, 60000);
}

async function checkAllSystems(client) {
  if (heartbeatInFlight) {
    return;
  }

  heartbeatInFlight = true;

  try {
    const hasLease = await acquireMonitorLease();
    if (!hasLease) {
      return;
    }

    const observedAt = new Date();
    const results = [];

    const botPing =
      typeof client?.ws?.ping === "number" && Number.isFinite(client.ws.ping)
        ? client.ws.ping
        : null;
    const botStatus =
      client && client.ws && client.ws.status === 0 && (botPing === null || botPing <= 1000)
        ? "operational"
        : "degraded_performance";
    results.push({
      name: "DISCORD BOT",
      rawStatus: botStatus,
      status: botStatus,
      latencyMs: botPing,
      sourceKey: "discord-bot",
      message:
        botStatus === "operational"
          ? "Gateway do Discord respondendo normalmente."
          : "Gateway do Discord com atraso ou reconexao em andamento.",
      metadata: {
        sampleSize: 1,
        successCount: botStatus === "operational" ? 1 : 0,
        degradedCount: botStatus === "degraded_performance" ? 1 : 0,
        failureCount: 0,
        confidenceScore: 100,
        checkerKey: "discord-gateway",
        wsStatus: client?.ws?.status ?? null,
        ping: botPing,
      },
    });

    const { error: dbError } = await supabase
      .from("system_components")
      .select("id")
      .limit(1);
    results.push({
      name: "Armazenamento DB",
      rawStatus: dbError ? "major_outage" : "operational",
      status: dbError ? "major_outage" : "operational",
      sourceKey: "database-storage",
      message: dbError
        ? normalizeStatusMessage(dbError.message, 240)
        : "Conexao administrativa com o banco operacional.",
      metadata: {
        sampleSize: 1,
        successCount: dbError ? 0 : 1,
        degradedCount: 0,
        failureCount: dbError ? 1 : 0,
        confidenceScore: 100,
        checkerKey: "supabase-admin-select",
      },
    });

    const apiProbe = await runSeriesCheck({
      attempts: 3,
      metadata: {
        checkerKey: "supabase-rest-api",
      },
      run: async () => {
        const startedAt = Date.now();
        const response = await fetchWithTimeout(
          `${env.supabaseUrl}/rest/v1/`,
          {
            headers: { apikey: env.supabaseServiceRoleKey },
          },
          7000,
        ).catch(() => null);
        const latencyMs = Date.now() - startedAt;

        if (!response) {
          return {
            status: "major_outage",
            latencyMs,
            message: "Falha ao consultar a API principal do Supabase.",
          };
        }

        let status = "operational";
        if (response.status >= 500 || latencyMs > 3500) {
          status = "partial_outage";
        } else if (latencyMs > 1800) {
          status = "degraded_performance";
        }

        return {
          status,
          latencyMs,
          responseCode: response.status,
          message: `Latencia da API: ${latencyMs}ms.`,
        };
      },
    });
    const apiLatency = apiProbe.latencyMs ?? null;
    results.push({
      name: "API",
      rawStatus: apiProbe.rawStatus,
      status: apiProbe.status,
      latencyMs: apiProbe.latencyMs,
      responseCode: apiProbe.responseCode,
      sourceKey: "api",
      message: apiProbe.message || "Latencia atual da API coletada.",
      metadata: apiProbe.metadata,
    });

    let flowAiErrorStr = "";
    let flowAiMessage = "";
    const flowAiEndpointLocal = isLocalFlowAiEndpoint();
    const flowAiProbe = await runSeriesCheck({
      attempts: 3,
      metadata: {
        checkerKey: "flowai-health",
        endpoint: env.flowAiApiUrl,
        localEndpoint: flowAiEndpointLocal,
      },
      run: async () => {
        try {
          const response = await requestFlowAiHealth();
          const rawStatus = response?.overall?.status || response?.status || "operational";
          const latencyMs =
            typeof response?.overall?.latencyMs === "number"
              ? response.overall.latencyMs
              : typeof response?.latencyMs === "number"
                ? response.latencyMs
                : null;
          const message = normalizeStatusMessage(
            response?.overall?.message || response?.message || "Health check da FlowAI concluido.",
            260,
          );
          flowAiMessage = message || flowAiMessage;
          return {
            status: rawStatus,
            latencyMs,
            message,
          };
        } catch (error) {
          const message = error?.message || String(error) || "";
          const isNetworkError =
            /ECONNREFUSED|ENOTFOUND|fetch failed|network|timeout|connect/i.test(message);
          if (isNetworkError && flowAiEndpointLocal) {
            console.log(
              "[status-system] FlowAI local inacessivel (ignorado em dev):",
              message.slice(0, 120),
            );
            flowAiMessage = "Endpoint local da FlowAI inacessivel neste ambiente.";
            return {
              status: "degraded_performance",
              message: flowAiMessage,
            };
          }
          flowAiErrorStr = message.slice(0, 300);
          flowAiMessage = normalizeStatusMessage(message, 260);
          return {
            status: "partial_outage",
            message: flowAiMessage,
          };
        }
      },
    });

    results.push({
      name: "Flow AI",
      rawStatus: flowAiProbe.rawStatus,
      status: flowAiProbe.status,
      latencyMs: flowAiProbe.latencyMs,
      sourceKey: "flowai",
      message:
        flowAiMessage ||
        (flowAiProbe.status === "operational"
          ? "Fluxo da FlowAI respondendo normalmente."
          : "Health check da FlowAI retornou sinal de degradacao."),
      metadata: flowAiProbe.metadata,
    });

    let cdnErrorStr = "";
    const cdnProbe = await runSeriesCheck({
      attempts: 3,
      metadata: {
        checkerKey: "supabase-cdn",
      },
      run: async (attempt) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const startedAt = Date.now();
        try {
          const method = attempt === 0 ? "HEAD" : "GET";
          const response = await fetch(
            `${env.supabaseUrl}/storage/v1/object/public/cdn/logos/logo.png`,
            { method, signal: controller.signal },
          );
          const latencyMs = Date.now() - startedAt;
          let status = "operational";
          if (!response.ok && response.status >= 500) {
            status = "partial_outage";
          } else if (!response.ok) {
            status = "degraded_performance";
          }
          cdnErrorStr = `HTTP ${response.status} ${response.statusText}`;
          return {
            status,
            latencyMs,
            responseCode: response.status,
            message:
              response.ok || response.status === 200
                ? "Assets da CDN carregando normalmente."
                : cdnErrorStr,
          };
        } catch (error) {
          cdnErrorStr = error?.message || String(error);
          return {
            status: "partial_outage",
            message: cdnErrorStr,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      },
    });
    results.push({
      name: "CDN",
      rawStatus: cdnProbe.rawStatus,
      status: cdnProbe.status,
      latencyMs: cdnProbe.latencyMs,
      responseCode: cdnProbe.responseCode,
      sourceKey: "cdn",
      message:
        cdnProbe.status === "operational"
          ? "Assets da CDN carregando normalmente."
          : normalizeStatusMessage(cdnErrorStr || cdnProbe.message || "Falha ao acessar asset publico da CDN.", 260),
      metadata: cdnProbe.metadata,
    });

    const domain = new URL(env.supabaseUrl).hostname;
    const dnsProbe = await runSeriesCheck({
      attempts: 3,
      metadata: {
        checkerKey: "dns-resolve",
      },
      run: async () => {
        try {
          await dns.resolve(domain);
          return {
            status: "operational",
            message: "Resolucao DNS concluida com sucesso.",
          };
        } catch (error) {
          return {
            status: "partial_outage",
            message: normalizeStatusMessage(error?.message || "Falha na resolucao DNS.", 220),
          };
        }
      },
    });
    results.push({
      name: "DNS",
      rawStatus: dnsProbe.rawStatus,
      status: dnsProbe.status,
      sourceKey: "dns",
      message: dnsProbe.message || "Resolucao DNS monitorada.",
      metadata: dnsProbe.metadata,
    });

    const sslProbe = await runSeriesCheck({
      attempts: 2,
      metadata: {
        checkerKey: "ssl-handshake",
      },
      run: async () => ({
        status: await checkSSL(domain),
        message: "Handshake SSL validado.",
      }),
    });
    results.push({
      name: "Certificado SSL",
      rawStatus: sslProbe.rawStatus,
      status: sslProbe.status,
      latencyMs: sslProbe.latencyMs,
      sourceKey: "ssl",
      message:
        sslProbe.status === "operational"
          ? "Handshake SSL concluido."
          : "Falha ou lentidao ao validar o certificado SSL.",
      metadata: sslProbe.metadata,
    });

    results.push({
      name: "Rede",
      rawStatus:
        apiProbe.rawStatus === "major_outage" || apiProbe.rawStatus === "partial_outage"
          ? apiProbe.rawStatus
          : typeof apiLatency === "number" && apiLatency > 2000
            ? "degraded_performance"
            : "operational",
      status:
        apiProbe.rawStatus === "major_outage" || apiProbe.rawStatus === "partial_outage"
          ? apiProbe.rawStatus
          : typeof apiLatency === "number" && apiLatency > 2000
            ? "degraded_performance"
            : "operational",
      latencyMs: apiLatency,
      sourceKey: "network",
      message: `Latencia base de rede medida pela API: ${apiLatency ?? "n/a"}ms.`,
      metadata: {
        ...(apiProbe.metadata || {}),
        checkerKey: "network-derived-from-api",
      },
    });

    const persistedResults = [];
    for (const result of results) {
      persistedResults.push(await persistStatusResult(result, observedAt));
    }

    const outboxHandled = await drainStatusNotificationOutbox();
    if (!outboxHandled) {
      const flowAiPersisted = persistedResults.find((result) => result.name === "Flow AI");
      if (flowAiPersisted?.status === "major_outage" && flowAiPersisted.shouldAlert) {
        try {
          await sendCriticalWebhook(
            "Flow AI",
            flowAiErrorStr || flowAiPersisted.message || `Status retornado: ${flowAiPersisted.status}`,
          );
        } catch (error) {
          console.error("[status-system] erro webhook Flow AI:", error);
        }
      }

      const cdnPersisted = persistedResults.find((result) => result.name === "CDN");
      if (cdnPersisted?.status === "major_outage" && cdnPersisted.shouldAlert) {
        try {
          await sendCriticalWebhook(
            "CDN Storage",
            cdnPersisted.message || cdnErrorStr || "Falha critica confirmada na CDN.",
          );
        } catch (error) {
          console.error("[status-system] erro webhook CDN:", error);
        }
      }
    }

    await reconcileOpenIncidents();

    if (persistedResults.some((result) => result.status !== "operational")) {
      await logStatusIssues(persistedResults);
    }
  } catch (error) {
    console.error("[status-system] Erro critico no heartbeat:", error);
  } finally {
    heartbeatInFlight = false;
  }
}

async function checkSSL(hostname) {
  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname,
        port: 443,
        method: "GET",
        rejectUnauthorized: true,
        timeout: 5000,
      },
      () => {
        resolve("operational");
      },
    );

    request.on("error", () => resolve("partial_outage"));
    request.on("timeout", () => resolve("degraded_performance"));
    request.end();
  });
}

async function logStatusIssues(results) {
  const issues = results.filter((result) => result.status !== "operational");
  if (!issues.length) return;

  if (issues.some((issue) => issue.status === "major_outage")) {
    console.warn(
      "[status-system] Falha critica confirmada pelo heartbeat:",
      issues.map((issue) => `${issue.name}:${issue.status}`).join(" | "),
    );
  }
}

module.exports = { startStatusHeartbeat };
