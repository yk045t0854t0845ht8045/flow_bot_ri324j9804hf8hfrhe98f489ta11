const crypto = require("node:crypto");

function generateProtocol() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();

  return `TK-${y}${m}${d}-${h}${min}-${random}`;
}

module.exports = { generateProtocol };
