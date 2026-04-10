const { env } = require("../config/env");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  getConfiguredTicketGuildRuntimes,
  updateGuildTicketPanelMessageId,
} = require("./supabaseService");
const {
  buildTicketPanelPayload,
  buildTicketSystemDisabledPayload,
} = require("../utils/componentFactory");

let activeTicketPanelSyncPromise = null;

function walkComponents(components, visitor) {
  if (!Array.isArray(components)) return;

  for (const component of components) {
    if (!component) continue;
    visitor(component);

    if (Array.isArray(component.components) && component.components.length) {
      walkComponents(component.components, visitor);
    }
  }
}

function messageLooksLikeTicketPanel(message) {
  if (!message?.author?.bot || message.author.id !== message.client.user.id) {
    return false;
  }

  let foundOpenButton = false;
  walkComponents(message.components, (component) => {
    const customId = component.customId || component.data?.custom_id;
    if (customId === CUSTOM_IDS.openTicket) {
      foundOpenButton = true;
    }
  });

  return foundOpenButton;
}

async function fetchExistingTicketPanelMessage(channel, storedMessageId = null) {
  if (storedMessageId) {
    const storedMessage = await channel.messages
      .fetch(storedMessageId)
      .catch(() => null);

    if (
      storedMessage &&
      storedMessage.author?.bot &&
      storedMessage.author.id === storedMessage.client.user.id
    ) {
      return storedMessage;
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 25 });
  const matchingMessage = recentMessages.find((message) =>
    messageLooksLikeTicketPanel(message),
  );

  if (matchingMessage) {
    return matchingMessage;
  }
  return null;
}

async function syncTicketPanelForRuntime(client, runtime) {
  if (!runtime?.settings?.menu_channel_id) {
    return { status: "skipped", reason: "missing_menu_channel" };
  }

  const guild = client.guilds.cache.get(runtime.guildId) ||
    (await client.guilds.fetch(runtime.guildId).catch(() => null));

  if (!guild) {
    return { status: "skipped", reason: "guild_unavailable" };
  }

  const channel =
    guild.channels.cache.get(runtime.settings.menu_channel_id) ||
    (await guild.channels.fetch(runtime.settings.menu_channel_id).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return { status: "skipped", reason: "channel_unavailable" };
  }

  const payload =
    runtime.settings.enabled === true && runtime.licenseUsable
      ? buildTicketPanelPayload({
          settings: runtime.settings,
        })
      : buildTicketSystemDisabledPayload({
          reason:
            runtime.settings.enabled !== true
              ? "module_disabled"
              : "license_unavailable",
          accentColor: env.accentColor,
        });

  const existingMessage = await fetchExistingTicketPanelMessage(
    channel,
    runtime.settings.panel_message_id || null,
  );
  if (existingMessage) {
    await existingMessage.edit(payload);
    if (runtime.settings.panel_message_id !== existingMessage.id) {
      await updateGuildTicketPanelMessageId(runtime.guildId, existingMessage.id);
      runtime.settings.panel_message_id = existingMessage.id;
    }
    return {
      status: "updated",
      guildId: runtime.guildId,
      channelId: channel.id,
      messageId: existingMessage.id,
      licenseStatus: runtime.licenseStatus,
    };
  }

  const sentMessage = await channel.send(payload);
  await updateGuildTicketPanelMessageId(runtime.guildId, sentMessage.id);
  runtime.settings.panel_message_id = sentMessage.id;
  return {
    status: "created",
    guildId: runtime.guildId,
    channelId: channel.id,
    messageId: sentMessage.id,
    licenseStatus: runtime.licenseStatus,
  };
}

async function ensureTicketPanels(client) {
  if (activeTicketPanelSyncPromise) {
    return activeTicketPanelSyncPromise;
  }

  activeTicketPanelSyncPromise = (async () => {
    const runtimes = await getConfiguredTicketGuildRuntimes();
    const applied = [];
    const skipped = [];

    for (const runtime of runtimes) {
      if (!runtime.isConfigured) {
        skipped.push({ guildId: runtime.guildId, reason: "incomplete_config" });
        continue;
      }

      try {
        const result = await syncTicketPanelForRuntime(client, runtime);
        if (result.status === "created" || result.status === "updated") {
          applied.push(result);
        } else {
          skipped.push({ guildId: runtime.guildId, reason: result.reason });
        }
      } catch (error) {
        skipped.push({
          guildId: runtime.guildId,
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    }

    return {
      applied,
      skipped,
      total: runtimes.length,
    };
  })();

  try {
    return await activeTicketPanelSyncPromise;
  } finally {
    activeTicketPanelSyncPromise = null;
  }
}

function buildTicketDisabledInteractionPayload(runtime = null) {
  return buildTicketSystemDisabledPayload({
    reason:
      runtime?.settings?.enabled !== true
        ? "module_disabled"
        : "license_unavailable",
    accentColor: env.accentColor,
  });
}

module.exports = {
  buildTicketDisabledInteractionPayload,
  ensureTicketPanels,
};
