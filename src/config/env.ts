/**
 * Environment configuration loader.
 * All secrets come from .env — never hardcoded.
 */
import "dotenv/config";
import path from "node:path";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function csvList(key: string, fallback: string = ""): string[] {
  const raw = process.env[key] || fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const relayDir = optional("RELAY_DIR", "./relay");

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUsers: csvList("TELEGRAM_ALLOWED_USERS").map(Number),
  sandboxDir: optional("SANDBOX_DIR", "./sandbox"),
  claudeBin: optional("CLAUDE_BIN", "claude"),
  allowedTools: csvList(
    "CLAUDE_ALLOWED_TOOLS",
    "help,notes.*,files.*,web.fetch,system.*,shell.exec,code.*,api.*,db.*"
  ),
  memoryTurns: Number(optional("MEMORY_TURNS", "12")),
  rateLimitMs: Number(optional("RATE_LIMIT_MS", "2000")),
  maxToolChain: Number(optional("MAX_TOOL_CHAIN", "5")),
  shellTimeout: Number(optional("SHELL_TIMEOUT_MS", "30000")),
  codeTimeout: Number(optional("CODE_TIMEOUT_MS", "30000")),
  claudeModel: optional("CLAUDE_MODEL", "claude-sonnet-4-5-20250929"),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  relayDir,
  uploadsDir: path.join(relayDir, "uploads"),
  adminPassphrase: process.env["ADMIN_PASSPHRASE"] || "",
} as const;
