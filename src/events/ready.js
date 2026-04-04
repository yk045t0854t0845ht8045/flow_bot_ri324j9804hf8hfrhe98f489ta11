const { ensureOfficialLinkPanel } = require("../services/officialLinkPanelService");
const {
  syncAllTicketPanels,
  syncOpenTicketControlMessages,
} = require("../services/ticketService");
const { startDirectMessageQueueWorker } = require("../services/directMessageQueueService");
const { primeInviteCacheForClient } = require("../utils/inviteTracker");
const { env } = require("../config/env");

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    console.log(`Bot online como ${client.user.tag}`);
    console.log(
      `[ai-mention] ${env.openaiApiKey ? "ativo" : "desativado"} | modelo principal: ${env.openaiModel}`,
    );

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

    try {
      await primeInviteCacheForClient(client);
    } catch (error) {
      console.error("[invite-cache]", error);
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
    }, 60 * 1000);
  },
};
