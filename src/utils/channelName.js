function slugifyUsername(username) {
  return (
    username
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20) || "usuario"
  );
}

function buildTicketChannelName(username, protocol) {
  const userSlug = slugifyUsername(username);
  const suffix = protocol.slice(-4).toLowerCase();
  return `ticket-${userSlug}-${suffix}`.slice(0, 95);
}

module.exports = {
  buildTicketChannelName,
};
