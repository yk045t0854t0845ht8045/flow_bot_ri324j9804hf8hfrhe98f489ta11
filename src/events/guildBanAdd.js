const { handleGuildBanAddSecurityLog } = require("../services/securityLogsService");

module.exports = {
  name: "guildBanAdd",
  async execute(ban) {
    try {
      await handleGuildBanAddSecurityLog(ban);
    } catch (error) {
      console.error("[security-log:guildBanAdd]", error);
    }
  },
};
