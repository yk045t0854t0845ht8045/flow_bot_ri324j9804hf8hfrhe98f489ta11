const inviteCache = new Map();

function mapInvites(invites) {
  const snapshot = new Map();

  for (const invite of invites.values()) {
    snapshot.set(invite.code, {
      uses: typeof invite.uses === "number" ? invite.uses : 0,
      inviterId: invite.inviter?.id || null,
    });
  }

  return snapshot;
}

async function primeInviteCacheForGuild(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteCache.set(guild.id, mapInvites(invites));
  } catch {
    // Sem permissao para ler convites; ignora.
  }
}

async function primeInviteCacheForClient(client) {
  for (const guild of client.guilds.cache.values()) {
    await primeInviteCacheForGuild(guild);
  }
}

async function resolveInviterForMemberJoin(guild) {
  let invites;

  try {
    invites = await guild.invites.fetch();
  } catch {
    return null;
  }

  const previous = inviteCache.get(guild.id) || new Map();
  const nextSnapshot = mapInvites(invites);
  inviteCache.set(guild.id, nextSnapshot);

  for (const [code, current] of nextSnapshot.entries()) {
    const before = previous.get(code);
    if (before && current.uses > before.uses) {
      return current.inviterId || null;
    }
  }

  for (const [code, current] of nextSnapshot.entries()) {
    if (!previous.has(code) && current.uses > 0) {
      return current.inviterId || null;
    }
  }

  return null;
}

module.exports = {
  primeInviteCacheForClient,
  primeInviteCacheForGuild,
  resolveInviterForMemberJoin,
};
