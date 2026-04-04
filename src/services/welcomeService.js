const { buildWelcomeMessagePayload } = require("../utils/componentFactory");
const { resolveInviterForMemberJoin } = require("../utils/inviteTracker");
const { getGuildWelcomeRuntime } = require("./supabaseService");

function uniqueChannelIds(channelIds) {
  return Array.from(new Set(channelIds.filter(Boolean)));
}

async function resolveTextChannel(guild, channelId) {
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return null;
  }

  return channel;
}

async function sendWelcomeMessage({ member, kind }) {
  if (!member?.guild) {
    return { status: "skipped", reason: "missing_guild" };
  }

  const guild = member.guild;
  const runtime = await getGuildWelcomeRuntime(guild.id);

  if (!runtime.settings || !runtime.settings.enabled) {
    return { status: "skipped", reason: "disabled" };
  }

  if (!runtime.licenseUsable) {
    return { status: "skipped", reason: "license_off" };
  }

  const settings = runtime.settings;
  const isEntry = kind === "entry";
  const channelIds = uniqueChannelIds(
    isEntry
      ? [settings.entry_public_channel_id, settings.entry_log_channel_id]
      : [settings.exit_public_channel_id, settings.exit_log_channel_id],
  );

  if (!channelIds.length) {
    return { status: "skipped", reason: "no_channels" };
  }

  let inviterUser = null;
  if (isEntry) {
    const inviterId = await resolveInviterForMemberJoin(guild);
    if (inviterId) {
      inviterUser = await guild.client.users.fetch(inviterId).catch(() => null);
    }
  }

  const fallbackMarkdown = isEntry
    ? "## Bem-vindo, {user}!\nAgora voce faz parte do **{server}**.\n-# Convite de {inviter}"
    : "## {user} saiu do servidor\nEsperamos te ver de volta em breve.";

  const payload = buildWelcomeMessagePayload({
    layout: isEntry ? settings.entry_layout : settings.exit_layout,
    fallbackMarkdown,
    member,
    guild,
    inviter: inviterUser,
    thumbnailMode: isEntry
      ? settings.entry_thumbnail_mode
      : settings.exit_thumbnail_mode,
  });

  const results = [];

  for (const channelId of channelIds) {
    const channel = await resolveTextChannel(guild, channelId);
    if (!channel) {
      results.push({ channelId, status: "skipped", reason: "invalid_channel" });
      continue;
    }

    try {
      await channel.send(payload);
      results.push({ channelId, status: "sent" });
    } catch (error) {
      results.push({
        channelId,
        status: "failed",
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    status: "completed",
    results,
  };
}

module.exports = {
  sendWelcomeMessage,
};
