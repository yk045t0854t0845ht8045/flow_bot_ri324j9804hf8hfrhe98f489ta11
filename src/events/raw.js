const { handleRawSecurityPacket } = require("../services/securityLogsService");

module.exports = {
  name: "raw",
  async execute(packet, shardId, client) {
    try {
      await handleRawSecurityPacket(packet, client);
    } catch (error) {
      console.error("[security-log:raw]", error);
    }
  },
};
