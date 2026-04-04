const { PermissionFlagsBits } = require("discord.js");

function hasAnyRole(member, roleIds) {
  if (!member || !Array.isArray(roleIds) || !roleIds.length) return false;
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function resolveStaffVisibilityRoleIds(staffSettings) {
  if (!staffSettings) return [];

  const unique = new Set();
  const groups = [
    staffSettings.admin_role_id ? [staffSettings.admin_role_id] : [],
    Array.isArray(staffSettings.claim_role_ids) ? staffSettings.claim_role_ids : [],
    Array.isArray(staffSettings.close_role_ids) ? staffSettings.close_role_ids : [],
    Array.isArray(staffSettings.notify_role_ids) ? staffSettings.notify_role_ids : [],
  ];

  for (const group of groups) {
    for (const roleId of group) {
      if (typeof roleId === "string" && roleId.trim()) {
        unique.add(roleId.trim());
      }
    }
  }

  return Array.from(unique);
}

function canClaimTicket(member, staffSettings) {
  if (!member) return false;

  return (
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (typeof staffSettings?.admin_role_id === "string" &&
      member.roles.cache.has(staffSettings.admin_role_id)) ||
    hasAnyRole(member, staffSettings?.claim_role_ids)
  );
}

function canCloseTicket(member, staffSettings) {
  if (!member) return false;

  return (
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (typeof staffSettings?.admin_role_id === "string" &&
      member.roles.cache.has(staffSettings.admin_role_id)) ||
    hasAnyRole(member, staffSettings?.close_role_ids)
  );
}

module.exports = {
  canClaimTicket,
  canCloseTicket,
  resolveStaffVisibilityRoleIds,
};
