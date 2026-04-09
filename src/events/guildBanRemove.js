const { handleGuildBanRemoveSecurityLog } = require("../services/securityLogsService");

module.exports = {
  name: "guildBanRemove",
  async execute(ban) {
    try {
      await handleGuildBanRemoveSecurityLog(ban);
    } catch (error) {
      console.error("[security-log:guildBanRemove]", error);
    }
  },
};
