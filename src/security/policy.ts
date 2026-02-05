/**
 * Security policy: user allowlist and tool allowlist enforcement.
 * Never execute arbitrary shell commands — only allowlisted tools.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

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

/** Set of user IDs that have authenticated as admin this session. */
const adminSessions = new Set<number>();

export function isAdmin(userId: number): boolean {
  return adminSessions.has(userId);
}

export function tryAdminAuth(userId: number, passphrase: string): boolean {
  if (!config.adminPassphrase) return false;
  if (passphrase === config.adminPassphrase) {
    adminSessions.add(userId);
    log.info(`User ${userId} authenticated as admin.`);
    return true;
  }
  return false;
}
