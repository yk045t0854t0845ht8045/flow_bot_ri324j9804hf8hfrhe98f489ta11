const { sendWelcomeMessage } = require("../services/welcomeService");
const { handleMemberRemoveSecurityLog } = require("../services/securityLogsService");

module.exports = {
  name: "guildMemberRemove",
  async execute(member) {
    try {
      await handleMemberRemoveSecurityLog(member);
    } catch (error) {
      console.error("[security-log:guildMemberRemove]", error);
    }

    try {
      await sendWelcomeMessage({ member, kind: "exit" });
    } catch (error) {
      console.error("[welcome-exit]", error);
    }
  },
};
