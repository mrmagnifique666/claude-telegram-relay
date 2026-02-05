/**
 * Shared path utilities for sandboxed file operations.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "./log.js";

/**
 * Resolve a user-provided path and ensure it stays within the sandbox.
 * Returns null if the path escapes.
 */
export function safeSandboxPath(userPath: string): string | null {
  const sandbox = path.resolve(config.sandboxDir);
  // Ensure sandbox exists
  if (!fs.existsSync(sandbox)) {
    fs.mkdirSync(sandbox, { recursive: true });
  }
  const resolved = path.resolve(sandbox, userPath);
  if (!resolved.startsWith(sandbox)) {
    log.warn(`Path escape attempt blocked: ${userPath}`);
    return null;
  }
  return resolved;
}
