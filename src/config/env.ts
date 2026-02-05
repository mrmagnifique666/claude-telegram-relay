/**
 * Environment configuration loader.
 * All secrets come from .env — never hardcoded.
 */
import "dotenv/config";

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

export const config = {
  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUsers: csvList("TELEGRAM_ALLOWED_USERS").map(Number),
  sandboxDir: optional("SANDBOX_DIR", "./sandbox"),
  claudeBin: optional("CLAUDE_BIN", "claude"),
  allowedTools: csvList(
    "CLAUDE_ALLOWED_TOOLS",
    "help,notes.*,files.*,web.fetch,system.*,shell.exec"
  ),
  memoryTurns: Number(optional("MEMORY_TURNS", "12")),
  rateLimitMs: Number(optional("RATE_LIMIT_MS", "2000")),
  maxToolChain: Number(optional("MAX_TOOL_CHAIN", "5")),
  shellTimeout: Number(optional("SHELL_TIMEOUT_MS", "30000")),
  logLevel: optional("LOG_LEVEL", "info") as
    | "debug"
    | "info"
    | "warn"
    | "error",
  featureVoice: optional("FEATURE_VOICE", "false") === "true",
  featureImage: optional("FEATURE_IMAGE", "false") === "true",
  adminPassphrase: process.env["ADMIN_PASSPHRASE"] || "",
} as const;
