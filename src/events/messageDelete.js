const { handleMessageDeleteSecurityLog } = require("../services/securityLogsService");

module.exports = {
  name: "messageDelete",
  async execute(message) {
    try {
      await handleMessageDeleteSecurityLog(message);
    } catch (error) {
      console.error("[security-log:messageDelete]", error);
    }
  },
};
