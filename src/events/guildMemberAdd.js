const { sendWelcomeMessage } = require("../services/welcomeService");

module.exports = {
  name: "guildMemberAdd",
  async execute(member) {
    try {
      await sendWelcomeMessage({ member, kind: "entry" });
    } catch (error) {
      console.error("[welcome-entry]", error);
    }
  },
};
