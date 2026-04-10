const {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} = require("@discordjs/voice");
const { ChannelType } = require("discord.js");
const { env } = require("../config/env");

const AUTO_JOIN_RECHECK_INTERVAL_MS = 45_000;
const AUTO_JOIN_READY_TIMEOUT_MS = 20_000;

let activeClient = null;
let ensureTimer = null;
let ensurePromise = null;

function getConfiguredVoiceChannelIds() {
  return Array.from(
    new Set(
      (env.autoJoinVoiceChannelIds || [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function isJoinableVoiceChannel(channel) {
  if (!channel?.guild || !channel?.isVoiceBased?.()) {
    return false;
  }

  return (
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice
  );
}

async function resolveTargetChannels(client) {
  const targetChannels = [];

  for (const channelId of getConfiguredVoiceChannelIds()) {
    const channel =
      client.channels.cache.get(channelId) ||
      (await client.channels.fetch(channelId).catch(() => null));

    if (!channel) {
      console.warn(`[voice-presence] canal ${channelId} nao encontrado`);
      continue;
    }

    if (!isJoinableVoiceChannel(channel)) {
      console.warn(
        `[voice-presence] canal ${channelId} nao e uma call compativel`,
      );
      continue;
    }

    targetChannels.push(channel);
  }

  return targetChannels;
}

async function connectToTargetChannel(channel) {
  const existingConnection = getVoiceConnection(channel.guild.id);
  const existingChannelId =
    existingConnection?.joinConfig?.channelId ||
    existingConnection?.state?.adapterData?.channelId ||
    null;

  if (
    existingConnection &&
    existingChannelId === channel.id &&
    existingConnection.state.status !== VoiceConnectionStatus.Destroyed
  ) {
    if (existingConnection.state.status !== VoiceConnectionStatus.Ready) {
      await entersState(
        existingConnection,
        VoiceConnectionStatus.Ready,
        AUTO_JOIN_READY_TIMEOUT_MS,
      ).catch(() => null);
    }
    return;
  }

  if (existingConnection) {
    existingConnection.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: true,
    group: "default",
  });

  connection.on("error", (error) => {
    console.error(
      `[voice-presence] erro em guild ${channel.guild.id} canal ${channel.id}`,
      error,
    );
  });

  connection.on("stateChange", (_, newState) => {
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      queueEnsurePinnedVoiceConnections();
    }
  });

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    AUTO_JOIN_READY_TIMEOUT_MS,
  );

  console.log(
    `[voice-presence] conectado em ${channel.guild.name} -> ${channel.name} (${channel.id})`,
  );
}

async function ensurePinnedVoiceConnectionsInternal(client) {
  const targetChannels = await resolveTargetChannels(client);
  const selectedChannelByGuild = new Map();

  for (const channel of targetChannels) {
    if (selectedChannelByGuild.has(channel.guild.id)) {
      const currentChannel = selectedChannelByGuild.get(channel.guild.id);
      console.warn(
        `[voice-presence] multiplos canais configurados para a guild ${channel.guild.id}; mantendo ${currentChannel.id} e ignorando ${channel.id}`,
      );
      continue;
    }

    selectedChannelByGuild.set(channel.guild.id, channel);
  }

  for (const channel of selectedChannelByGuild.values()) {
    try {
      await connectToTargetChannel(channel);
    } catch (error) {
      console.error(
        `[voice-presence] falha ao conectar em ${channel.id}`,
        error,
      );
    }
  }
}

function queueEnsurePinnedVoiceConnections() {
  if (!activeClient) return Promise.resolve();
  if (ensurePromise) return ensurePromise;

  ensurePromise = ensurePinnedVoiceConnectionsInternal(activeClient).finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

function startVoicePresence(client) {
  activeClient = client;

  if (ensureTimer) {
    clearInterval(ensureTimer);
    ensureTimer = null;
  }

  void queueEnsurePinnedVoiceConnections();

  ensureTimer = setInterval(() => {
    void queueEnsurePinnedVoiceConnections();
  }, AUTO_JOIN_RECHECK_INTERVAL_MS);
}

function shouldRecheckFromVoiceState(oldState, newState, client) {
  const targetChannelIds = new Set(getConfiguredVoiceChannelIds());
  if (!targetChannelIds.size) return false;

  if (oldState?.id === client?.user?.id || newState?.id === client?.user?.id) {
    return true;
  }

  return (
    targetChannelIds.has(String(oldState?.channelId || "")) ||
    targetChannelIds.has(String(newState?.channelId || ""))
  );
}

async function handleVoicePresenceStateUpdate(oldState, newState, client) {
  if (!client?.user) return;
  if (!shouldRecheckFromVoiceState(oldState, newState, client)) return;
  await queueEnsurePinnedVoiceConnections();
}

module.exports = {
  handleVoicePresenceStateUpdate,
  startVoicePresence,
};
