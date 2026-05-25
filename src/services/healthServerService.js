const http = require("http");
const crypto = require("crypto");
const { env } = require("../config/env");

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function buildHealthPayload(client) {
  const ready = typeof client?.isReady === "function" ? client.isReady() : false;
  const wsStatus = typeof client?.ws?.status === "number" ? client.ws.status : null;
  const guildCount = typeof client?.guilds?.cache?.size === "number" ? client.guilds.cache.size : null;
  const uptimeMs = Math.round(process.uptime() * 1000);
  const ping = typeof client?.ws?.ping === "number" ? client.ws.ping : null;

  let status = "major_outage";
  if (ready && wsStatus === 0) {
    status = typeof ping === "number" && ping > 1000 ? "degraded_performance" : "operational";
  } else if (wsStatus === 1 || wsStatus === 2 || wsStatus === 8) {
    status = "degraded_performance";
  } else if (wsStatus === 5) {
    status = "partial_outage";
  }

  return {
    ok: status === "operational",
    service: "discord-bot",
    status,
    ready,
    wsStatus,
    ping,
    guildCount,
    uptimeMs,
    timestamp: new Date().toISOString(),
  };
}

function secureTokenEquals(expected, received) {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const receivedBuffer = Buffer.from(String(received || ""));

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function isAuthorized(request) {
  if (!env.botHealthToken) {
    return !isProduction();
  }

  const token =
    request.headers["x-bot-health-token"] ||
    request.headers["x-status-token"] ||
    request.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    "";

  return secureTokenEquals(env.botHealthToken, token);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

function startHealthServer(client) {
  const server = http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    if (request.url !== "/health") {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    if (!isAuthorized(request)) {
      writeJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const payload = buildHealthPayload(client);
    writeJson(response, payload.ok ? 200 : 503, payload);
  });

  server.listen(env.botHealthPort, env.botHealthHost, () => {
    // 0.0.0.0 = escuta em todas as interfaces; exibe o IP real para clareza
    const displayHost =
      env.botHealthHost === "0.0.0.0" || env.botHealthHost === "::" ? "localhost" : env.botHealthHost;
    console.log(
      `[health-server] online em http://${displayHost}:${env.botHealthPort}/health (bind: ${env.botHealthHost})`,
    );
  });

  server.on("error", (error) => {
    console.error("[health-server]", error);
  });

  return server;
}

module.exports = { startHealthServer };
