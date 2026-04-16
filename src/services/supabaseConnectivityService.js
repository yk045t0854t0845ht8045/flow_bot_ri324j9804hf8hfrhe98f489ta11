const { env } = require("../config/env");

function getProjectRefFromUrl() {
  try {
    return new URL(env.supabaseUrl).hostname.split(".")[0] || null;
  } catch {
    return null;
  }
}

function getProjectRefFromServiceRoleKey() {
  const token = String(env.supabaseServiceRoleKey || "").trim();
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    );
    return typeof payload?.ref === "string" ? payload.ref : null;
  } catch {
    return null;
  }
}

async function verifySupabaseAdminConnection() {
  const projectRefFromUrl = getProjectRefFromUrl();
  const projectRefFromKey = getProjectRefFromServiceRoleKey();

  try {
    const response = await fetch(`${env.supabaseUrl}/rest/v1/`, {
      headers: {
        apikey: env.supabaseServiceRoleKey,
        Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
      },
    });

    if (response.ok) {
      console.log(
        `[supabase-check] conexao administrativa OK (${projectRefFromUrl || "unknown"})`,
      );
      return true;
    }

    const details = await response.text().catch(() => "");
    console.error("[supabase-check] Falha ao autenticar no Supabase.", {
      status: response.status,
      projectRefFromUrl,
      projectRefFromKey,
      refsMatch:
        projectRefFromUrl && projectRefFromKey
          ? projectRefFromUrl === projectRefFromKey
          : null,
      detail: details.slice(0, 180),
    });
  } catch (error) {
    console.error("[supabase-check] Falha ao validar conexao com o Supabase.", {
      projectRefFromUrl,
      projectRefFromKey,
      refsMatch:
        projectRefFromUrl && projectRefFromKey
          ? projectRefFromUrl === projectRefFromKey
          : null,
      detail: error?.message || String(error),
    });
  }

  console.error(
    "[supabase-check] Confira SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente do deploy e reinicie o processo.",
  );
  return false;
}

module.exports = { verifySupabaseAdminConnection };
