const {
  enqueueTicketDirectMessage,
  getDueTicketDirectMessages,
  markTicketDirectMessageBlocked,
  markTicketDirectMessageSent,
  rescheduleTicketDirectMessage,
} = require("./supabaseService");
const { buildTicketClosureDmPayload } = require("../utils/componentFactory");

const DM_QUEUE_RETRY_DELAYS_MS = [
  20 * 1000,
  60 * 1000,
  3 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
];
const DM_QUEUE_PROCESS_INTERVAL_MS = 20 * 1000;

let processingPromise = null;
let intervalHandle = null;

function buildTicketClosureNotificationKey(ticketId) {
  return `ticket:${ticketId}:closure_dm`;
}

function resolveNextRetryTimestamp(attemptCount) {
  const delay =
    DM_QUEUE_RETRY_DELAYS_MS[
      Math.min(attemptCount - 1, DM_QUEUE_RETRY_DELAYS_MS.length - 1)
    ] || DM_QUEUE_RETRY_DELAYS_MS[DM_QUEUE_RETRY_DELAYS_MS.length - 1];

  return new Date(Date.now() + delay).toISOString();
}

function isDirectMessageBlockedError(error) {
  const code = error?.code || error?.rawError?.code;
  return code === 50007 || code === 50013 || code === 50001;
}

async function enqueueTicketClosureDirectMessage({
  ticket,
  closedBy,
  transcriptAvailable,
  transcriptUrl,
  accessCode,
}) {
  const notificationKey = buildTicketClosureNotificationKey(ticket.id);
  const payload = buildTicketClosureDmPayload({
    ticket,
    closedBy,
    transcriptAvailable,
    transcriptUrl,
    accessCode,
  });

  const queueItem = await enqueueTicketDirectMessage({
    notificationKey,
    kind: "ticket_closure_dm",
    ticketId: ticket.id,
    protocol: ticket.protocol,
    guildId: ticket.guild_id,
    userId: ticket.user_id,
    payload,
  });

  return {
    notificationKey,
    queueItem,
  };
}

async function processDirectMessageQueue(client, options = {}) {
  const { limit = 10, notificationKey = null } = options;

  if (processingPromise) {
    return processingPromise;
  }

  processingPromise = (async () => {
    const queueItems = await getDueTicketDirectMessages(limit, notificationKey);
    const results = [];

    for (const queueItem of queueItems) {
      const nextAttemptCount = Number(queueItem.attempt_count || 0) + 1;

      try {
        const targetUser =
          client.users.cache.get(queueItem.user_id) ||
          (await client.users.fetch(queueItem.user_id).catch(() => null));

        if (!targetUser) {
          throw new Error("Usuario nao localizado para envio do privado.");
        }

        const deliveredMessage = await targetUser.send(queueItem.payload || {});

        await markTicketDirectMessageSent(queueItem.id, {
          dmChannelId: deliveredMessage.channel?.id || null,
          deliveredMessageId: deliveredMessage.id || null,
        });

        results.push({
          id: queueItem.id,
          notificationKey: queueItem.notification_key,
          status: "sent",
          dmChannelId: deliveredMessage.channel?.id || null,
          deliveredMessageId: deliveredMessage.id || null,
        });
      } catch (error) {
        const lastError =
          error instanceof Error ? error.message : "Falha ao enviar mensagem privada.";

        if (isDirectMessageBlockedError(error)) {
          await markTicketDirectMessageBlocked(queueItem.id, {
            attemptCount: nextAttemptCount,
            lastError,
          });

          results.push({
            id: queueItem.id,
            notificationKey: queueItem.notification_key,
            status: "blocked",
            lastError,
          });
          continue;
        }

        const reachedMaxAttempts =
          nextAttemptCount >= Number(queueItem.max_attempts || 12);

        await rescheduleTicketDirectMessage(queueItem.id, {
          attemptCount: nextAttemptCount,
          nextAttemptAt: resolveNextRetryTimestamp(nextAttemptCount),
          lastError,
          finalFailure: reachedMaxAttempts,
        });

        results.push({
          id: queueItem.id,
          notificationKey: queueItem.notification_key,
          status: reachedMaxAttempts ? "failed" : "queued",
          lastError,
        });
      }
    }

    return results;
  })();

  try {
    return await processingPromise;
  } finally {
    processingPromise = null;
  }
}

function startDirectMessageQueueWorker(client) {
  if (intervalHandle) {
    return intervalHandle;
  }

  void processDirectMessageQueue(client).catch((error) => {
    console.error("[ticket-dm-queue]", error);
  });

  intervalHandle = setInterval(() => {
    void processDirectMessageQueue(client).catch((error) => {
      console.error("[ticket-dm-queue]", error);
    });
  }, DM_QUEUE_PROCESS_INTERVAL_MS);

  return intervalHandle;
}

module.exports = {
  buildTicketClosureNotificationKey,
  enqueueTicketClosureDirectMessage,
  processDirectMessageQueue,
  startDirectMessageQueueWorker,
};
