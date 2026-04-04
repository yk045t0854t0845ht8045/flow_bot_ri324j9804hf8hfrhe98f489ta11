const { sendWelcomeMessage } = require("../services/welcomeService");

module.exports = {
  name: "guildMemberRemove",
  async execute(member) {
    try {
      await sendWelcomeMessage({ member, kind: "exit" });
    } catch (error) {
      console.error("[welcome-exit]", error);
    }
  },
};
