const { handleUserAvatarUpdate } = require("../services/securityLogsService");

module.exports = {
  name: "userUpdate",
  async execute(oldUser, newUser, client) {
    try {
      await handleUserAvatarUpdate(oldUser, newUser, client);
    } catch (error) {
      console.error("[security-log:userUpdate]", error);
    }
  },
};
