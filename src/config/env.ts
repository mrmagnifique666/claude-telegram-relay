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
    "help,notes.*,files.*,web.fetch,system.*,shell.exec,code.*,api.*,db.*,telegram.*"
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
  elevenlabsApiKey: optional("ELEVENLABS_API_KEY", ""),
  elevenlabsVoiceId: optional("ELEVENLABS_VOICE_ID", "onwK4e9ZLuTAKqWW03F9"),

  // Voice (Twilio phone calls)
  voiceEnabled: optional("VOICE_ENABLED", "false") === "true",
  voicePort: Number(optional("VOICE_PORT", "3100")),
  voicePublicUrl: optional("VOICE_PUBLIC_URL", ""),
  twilioAccountSid: optional("TWILIO_ACCOUNT_SID", ""),
  twilioAuthToken: optional("TWILIO_AUTH_TOKEN", ""),
  deepgramApiKey: optional("DEEPGRAM_API_KEY", ""),
  voiceChatId: Number(optional("VOICE_CHAT_ID", "0")),
  voiceUserId: Number(optional("VOICE_USER_ID", "0")),
  voiceLanguage: optional("VOICE_LANGUAGE", "fr"),
} as const;
