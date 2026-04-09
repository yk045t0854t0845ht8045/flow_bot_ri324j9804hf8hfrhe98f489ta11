const { handleNicknameOrAvatarUpdate } = require("../services/securityLogsService");

module.exports = {
  name: "guildMemberUpdate",
  async execute(oldMember, newMember) {
    try {
      await handleNicknameOrAvatarUpdate(oldMember, newMember);
    } catch (error) {
      console.error("[security-log:guildMemberUpdate]", error);
    }
  },
};
