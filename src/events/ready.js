const { ensureOfficialLinkPanel } = require("../services/officialLinkPanelService");
const {
  syncAllTicketPanels,
  syncOpenTicketControlMessages,
} = require("../services/ticketService");
const { primeVoiceStateSnapshots } = require("../services/securityLogsService");
const { startDirectMessageQueueWorker } = require("../services/directMessageQueueService");
const { startAutoRoleWorker } = require("../services/autoRoleService");
const { primeInviteCacheForClient } = require("../utils/inviteTracker");
const { syncSlashCommandsForClient } = require("../services/slashCommandSyncService");
const { startVoicePresence } = require("../services/voicePresenceService");
const { env } = require("../config/env");

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    console.log(`Bot online como ${client.user.tag}`);
    console.log(
      `[ai-mention] ${env.openaiApiKey ? "ativo" : "desativado"} | modelo principal: ${env.openaiModel}`,
    );
    if (env.autoDeployCommands) {
      try {
        const slashSync = await syncSlashCommandsForClient(client);
        if (slashSync.deployed) {
          console.log(
            `[slash-commands] synced ${slashSync.count} command(s) (${slashSync.scope})`,
          );
        } else {
          console.log(
            `[slash-commands] sincronizacao ignorada (${slashSync.reason})`,
          );
        }
      } catch (error) {
        console.error("[slash-commands]", error);
      }
    } else {
      console.log("[slash-commands] sincronizacao automatica desativada no .env");
    }

    try {
      const panelResult = await ensureOfficialLinkPanel(client);
      console.log(
        `[official-link-panel] ${panelResult.mode} message ${panelResult.messageId}`,
      );
    } catch (error) {
      console.error("[official-link-panel]", error);
    }

    try {
      const result = await syncAllTicketPanels(client);
      console.log(
        `[ticket-panels] synced ${result.applied.length}/${result.total} paineis`,
      );
    } catch (error) {
      console.error("[ticket-panels]", error);
    }

    try {
      const result = await syncOpenTicketControlMessages(client);
      if (result.applied.length || result.total) {
        console.log(
          `[ticket-open-messages] synced ${result.applied.length}/${result.total} mensagens`,
        );
      }
    } catch (error) {
      console.error("[ticket-open-messages]", error);
    }

    startDirectMessageQueueWorker(client);
    startAutoRoleWorker(client);

    try {
      await primeInviteCacheForClient(client);
    } catch (error) {
      console.error("[invite-cache]", error);
    }

    try {
      startVoicePresence(client);
    } catch (error) {
      console.error("[voice-presence]", error);
    }

    try {
      const primedVoiceStates = primeVoiceStateSnapshots(client);
      if (primedVoiceStates > 0) {
        console.log(`[security-logs] snapshots de voz inicializados: ${primedVoiceStates}`);
      }
    } catch (error) {
      console.error("[security-logs:prime-voice-states]", error);
    }

    setInterval(async () => {
      try {
        const result = await syncAllTicketPanels(client);
        if (result.applied.length) {
          console.log(
            `[ticket-panels] synced ${result.applied.length}/${result.total} paineis`,
          );
        }
      } catch (error) {
        console.error("[ticket-panels]", error);
      }
    }, env.ticketPanelSyncIntervalMs);

    setInterval(async () => {
      try {
        const result = await syncOpenTicketControlMessages(client);
        if (result.applied.length) {
          console.log(
            `[ticket-open-messages] synced ${result.applied.length}/${result.total} mensagens`,
          );
        }
      } catch (error) {
        console.error("[ticket-open-messages]", error);
      }
    }, env.ticketOpenMessageSyncIntervalMs);
  },
};
