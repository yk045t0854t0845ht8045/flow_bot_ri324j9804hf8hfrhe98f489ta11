const { handleVoiceStateSecurityLog } = require("../services/securityLogsService");
const { handleVoicePresenceStateUpdate } = require("../services/voicePresenceService");

module.exports = {
  name: "voiceStateUpdate",
  async execute(oldState, newState, client) {
    try {
      await handleVoiceStateSecurityLog(oldState, newState);
    } catch (error) {
      console.error("[security-log:voiceStateUpdate]", error);
    }

    try {
      await handleVoicePresenceStateUpdate(oldState, newState, client);
    } catch (error) {
      console.error("[voice-presence:voiceStateUpdate]", error);
    }
  },
};
