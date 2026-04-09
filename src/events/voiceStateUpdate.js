const { handleVoiceStateSecurityLog } = require("../services/securityLogsService");

module.exports = {
  name: "voiceStateUpdate",
  async execute(oldState, newState) {
    try {
      await handleVoiceStateSecurityLog(oldState, newState);
    } catch (error) {
      console.error("[security-log:voiceStateUpdate]", error);
    }
  },
};
