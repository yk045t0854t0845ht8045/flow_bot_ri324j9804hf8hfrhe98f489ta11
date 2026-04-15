const http = require("http");
const { env } = require("../config/env");

function buildHealthPayload(client) {
  const ready = typeof client?.isReady === "function" ? client.isReady() : false;
  const wsStatus = typeof client?.ws?.status === "number" ? client.ws.status : null;
  const guildCount = typeof client?.guilds?.cache?.size === "number" ? client.guilds.cache.size : null;
  const userTag = client?.user?.tag || null;
  const uptimeMs = Math.round(process.uptime() * 1000);

  let status = "major_outage";
  if (ready && wsStatus === 0) {
    status = "operational";
  } else if (wsStatus === 0) {
    status = "degraded_performance";
  }

  return {
    ok: status === "operational",
    service: "discord-bot",
    status,
    ready,
    wsStatus,
    guildCount,
    userTag,
    uptimeMs,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
}

function isAuthorized(request) {
  if (!env.botHealthToken) {
    return true;
  }

  const token =
    request.headers["x-bot-health-token"] ||
    request.headers["x-status-token"] ||
    request.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    "";

  return token === env.botHealthToken;
}

function startHealthServer(client) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    if (!isAuthorized(request)) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const payload = buildHealthPayload(client);
    response.writeHead(payload.ok ? 200 : 503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(payload));
  });

  server.listen(env.botHealthPort, env.botHealthHost, () => {
    console.log(
      `[health-server] online em http://${env.botHealthHost}:${env.botHealthPort}/health`,
    );
  });

  server.on("error", (error) => {
    console.error("[health-server]", error);
  });

  return server;
}

module.exports = { startHealthServer };
