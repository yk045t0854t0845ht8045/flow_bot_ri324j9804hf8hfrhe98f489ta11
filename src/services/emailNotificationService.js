const nodemailer = require("nodemailer");
const { getAuthUserContactByDiscordUserId } = require("./supabaseService");

let cachedTransporter = null;
let cachedTransporterKey = null;

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveSmtpConfig() {
  const host = String(process.env.AUTH_SMTP_HOST || "").trim();
  const port = Number(process.env.AUTH_SMTP_PORT || "587");
  const secure =
    String(process.env.AUTH_SMTP_SECURE || "false").trim().toLowerCase() === "true";
  const user = String(process.env.AUTH_SMTP_USER || "").trim() || null;
  const pass = String(process.env.AUTH_SMTP_PASS || "").trim() || null;
  const fromEmail =
    String(process.env.AUTH_SMTP_FROM_EMAIL || "").trim() ||
    String(process.env.AUTH_SMTP_USER || "").trim();
  const fromName = String(process.env.AUTH_SMTP_FROM_NAME || "Flowdesk").trim();
  const envelopeFrom =
    String(process.env.AUTH_SMTP_ENVELOPE_FROM || "").trim() || fromEmail;
  const replyTo = String(process.env.AUTH_SMTP_REPLY_TO || "").trim() || null;

  if (!host || !Number.isFinite(port) || !fromEmail || !isValidEmail(fromEmail)) {
    return null;
  }

  return {
    host,
    port,
    secure,
    user,
    pass,
    fromEmail,
    fromName,
    envelopeFrom,
    replyTo: isValidEmail(replyTo) ? replyTo : null,
  };
}

function getTransporter() {
  const config = resolveSmtpConfig();
  if (!config) return null;

  const cacheKey = JSON.stringify({
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    fromEmail: config.fromEmail,
  });

  if (cachedTransporter && cachedTransporterKey === cacheKey) {
    return { transporter: cachedTransporter, config };
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.user && config.pass
        ? {
            user: config.user,
            pass: config.pass,
          }
        : undefined,
  });
  cachedTransporterKey = cacheKey;

  return { transporter: cachedTransporter, config };
}

function buildSupportTicketEmailHtml(input) {
  return `
    <!doctype html>
    <html lang="pt-BR">
      <body style="margin:0;padding:0;background:#EEF3F8;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF3F8;border-collapse:collapse;">
          <tr>
            <td align="center" style="padding:32px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#FFFFFF;border:1px solid #D8E1EC;border-radius:24px;border-collapse:separate;overflow:hidden;">
                <tr>
                  <td style="padding:32px 36px;font-family:Arial,Helvetica,sans-serif;color:#0F172A;">
                    <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#64748B;">Flowdesk Suporte</div>
                    <h1 style="margin:12px 0 0;font-size:30px;line-height:1.15;">Ticket de suporte aberto</h1>
                    <p style="margin:14px 0 0;font-size:16px;line-height:1.7;color:#475569;">
                      Recebemos sua solicitacao no Discord e abrimos o atendimento.
                    </p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border:1px solid #E2E8F0;border-radius:18px;background:#F8FAFC;">
                      <tr>
                        <td style="padding:14px 16px;font-size:13px;color:#64748B;">Protocolo</td>
                        <td align="right" style="padding:14px 16px;font-size:15px;font-weight:700;color:#0F172A;">${escapeHtml(input.protocol)}</td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-top:1px solid #E2E8F0;font-size:13px;color:#64748B;">Servidor</td>
                        <td align="right" style="padding:14px 16px;border-top:1px solid #E2E8F0;font-size:15px;font-weight:700;color:#0F172A;">${escapeHtml(input.guildName || "Discord")}</td>
                      </tr>
                    </table>
                    ${
                      input.channelUrl
                        ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(input.channelUrl)}" style="display:inline-block;padding:14px 20px;border-radius:14px;background:#0F172A;color:#FFFFFF;text-decoration:none;font-size:14px;font-weight:700;">ABRIR TICKET</a></p>`
                        : ""
                    }
                    <p style="margin:24px 0 0;font-size:13px;line-height:1.7;color:#64748B;">
                      Este email foi enviado automaticamente para confirmar a abertura do atendimento.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

async function sendSupportTicketOpenedEmail(input) {
  try {
    const contact = await getAuthUserContactByDiscordUserId(input.discordUserId);
    if (!contact || !isValidEmail(contact.email)) return;

    const resolved = getTransporter();
    if (!resolved) return;

    const { transporter, config } = resolved;
    const from = config.fromName
      ? `"${config.fromName.replace(/"/g, "")}" <${config.fromEmail}>`
      : config.fromEmail;

    await transporter.sendMail({
      from,
      to: contact.email,
      replyTo: config.replyTo || undefined,
      envelope: {
        from: config.envelopeFrom,
        to: contact.email,
      },
      subject: `Flowdesk | Ticket ${input.protocol} aberto`,
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
        "X-Flowdesk-Email-Type": "support-ticket-opened",
      },
      text: [
        "Flowdesk Suporte",
        "",
        "Ticket de suporte aberto.",
        `Protocolo: ${input.protocol}`,
        `Servidor: ${input.guildName || "Discord"}`,
        input.channelUrl ? `Abrir ticket: ${input.channelUrl}` : "",
      ].filter(Boolean).join("\n"),
      html: buildSupportTicketEmailHtml(input),
    });
  } catch (error) {
    console.warn("[email-notification] support-ticket-opened failed:", error);
  }
}

module.exports = {
  sendSupportTicketOpenedEmail,
};
