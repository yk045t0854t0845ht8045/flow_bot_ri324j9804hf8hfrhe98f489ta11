const { buildLogPayload } = require("../utils/componentFactory");

function resolveDmStatusLabel(dmStatus) {
  switch (dmStatus) {
    case "sent":
      return "enviada no privado";
    case "blocked":
      return "bloqueado ou privado desativado";
    case "failed":
      return "falhou apos varias tentativas";
    default:
      return "na fila de entrega";
  }
}

async function resolveLogChannel(guild, channelId, label) {
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      `Canal de log ${label} invalido. Verifique a configuracao salva no Flowdesk (${channelId}).`,
    );
  }

  return channel;
}

async function sendTicketCreatedLog(guild, ticket, runtime) {
  const logChannel = await resolveLogChannel(
    guild,
    runtime.settings.logs_created_channel_id,
    "de criacao",
  );

  const payload = buildLogPayload({
    accentColor: runtime.accentColor,
    title: "Ticket criado",
    lines: [
      `**Numero:** \`#${String(ticket.id || 0).padStart(4, "0")}\``,
      `**Protocolo:** \`${ticket.protocol}\``,
      `**Canal:** <#${ticket.channel_id}>`,
      `**Cliente:** <@${ticket.user_id}>`,
      ticket.opened_reason
        ? `**Motivo:** \`${String(ticket.opened_reason).slice(0, 300)}\``
        : "",
      `**Status:** aberto`,
    ].filter(Boolean),
  });

  await logChannel.send(payload);
}

async function sendTicketClaimedLog(guild, ticket, staffId, runtime) {
  const logChannel = await resolveLogChannel(
    guild,
    runtime.settings.logs_created_channel_id,
    "de criacao",
  );

  const payload = buildLogPayload({
    accentColor: runtime.accentColor,
    title: "Ticket assumido",
    lines: [
      `**Protocolo:** \`${ticket.protocol}\``,
      `**Canal:** <#${ticket.channel_id}>`,
      `**Cliente:** <@${ticket.user_id}>`,
      `**Staff responsavel:** <@${staffId}>`,
    ],
  });

  await logChannel.send(payload);
}

async function sendTicketClosedLog(
  guild,
  ticket,
  transcriptAccess,
  closedBy,
  runtime,
) {
  const logChannel = await resolveLogChannel(
    guild,
    runtime.settings.logs_closed_channel_id,
    "de fechamento",
  );

  const payload = buildLogPayload({
    accentColor: runtime.accentColor,
    title: "Ticket fechado",
    lines: [
      `**Protocolo:** \`${ticket.protocol}\``,
      `**Canal:** \`${ticket.channel_id}\``,
      `**Cliente:** <@${ticket.user_id}>`,
      `**Atendente:** ${
        ticket.claimed_by ? `<@${ticket.claimed_by}>` : "nao definido"
      }`,
      `**Fechado por:** <@${closedBy}>`,
      transcriptAccess?.available === false
        ? "**Transcript:** indisponivel por falta de mensagens suficientes"
        : `**Transcript:** protegido e disponivel no link abaixo`,
      `**Privado do cliente:** ${resolveDmStatusLabel(transcriptAccess?.dmStatus)}`,
      `**Status:** fechado`,
    ],
    linkUrl: transcriptAccess?.url || "",
    linkLabel: "Abrir transcript",
    actionLabel:
      transcriptAccess?.available === false
        ? "Transcript indisponivel"
        : "",
    actionDisabled: transcriptAccess?.available === false,
  });

  await logChannel.send(payload);
}

module.exports = {
  sendTicketCreatedLog,
  sendTicketClaimedLog,
  sendTicketClosedLog,
};
