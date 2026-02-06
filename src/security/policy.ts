/**
 * Security policy: user allowlist and tool allowlist enforcement.
 * Never execute arbitrary shell commands — only allowlisted tools.
 */
import { config } from "../config/env.js";
import { getSkill } from "../skills/loader.js";
import { log } from "../utils/log.js";
import { saveAdminSession, isAdminSession, clearAdminSession } from "../storage/store.js";

/**
 * Returns true if the Telegram user ID is in the allowlist.
 * An empty allowlist means nobody is allowed (secure default).
 */
export function isUserAllowed(userId: number): boolean {
  if (config.allowedUsers.length === 0) {
    log.warn("TELEGRAM_ALLOWED_USERS is empty — all users are blocked.");
    return false;
  }
  return config.allowedUsers.includes(userId);
}

/**
 * Checks whether a tool name is permitted by the allowlist.
 * Supports wildcards: "notes.*" matches "notes.add", "notes.list", etc.
 */
export function isToolAllowed(toolName: string): boolean {
  for (const pattern of config.allowedTools) {
    if (pattern === toolName) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // "notes."
      if (toolName.startsWith(prefix)) return true;
    }
  }
  log.warn(`Blocked disallowed tool: ${toolName}`);
  return false;
}

export function isAdmin(userId: number): boolean {
  return isAdminSession(userId);
}

export function tryAdminAuth(userId: number, passphrase: string): boolean {
  if (!config.adminPassphrase) return false;
  if (passphrase === config.adminPassphrase) {
    saveAdminSession(userId);
    log.info(`User ${userId} authenticated as admin (persisted to DB).`);
    return true;
  }
  return false;
}

export function revokeAdmin(userId: number): void {
  clearAdminSession(userId);
  log.info(`Revoked admin for user ${userId}.`);
}

/**
 * Combined permission check: tool must be on the allowlist,
 * and if the skill is marked adminOnly, the user must be an admin.
 */
export function isToolPermitted(toolName: string, userId: number): boolean {
  if (!isToolAllowed(toolName)) return false;
  const skill = getSkill(toolName);
  if (skill?.adminOnly) {
    const adminStatus = isAdmin(userId);
    if (!adminStatus) {
      log.warn(`Non-admin user ${userId} blocked from admin tool: ${toolName} (isAdminSession returned false — check /admin auth and 24h expiry)`);
      return false;
    }
    log.debug(`Admin user ${userId} permitted for admin tool: ${toolName}`);
  }
  return true;
}
