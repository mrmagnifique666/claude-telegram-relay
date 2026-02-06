/**
 * Environment configuration loader.
 * All secrets come from .env — never hardcoded.
 * Supports hot-reload via reloadEnv() and watchEnv().
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

// Initial load
dotenv.config();

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

function buildConfig() {
  const relayDir = optional("RELAY_DIR", "./relay");
  return {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUsers: csvList("TELEGRAM_ALLOWED_USERS").map(Number),
    sandboxDir: optional("SANDBOX_DIR", "./sandbox"),
    claudeBin: optional("CLAUDE_BIN", "claude"),
    allowedTools: csvList(
      "CLAUDE_ALLOWED_TOOLS",
      "help,notes.*,files.*,web.fetch,system.*,shell.exec,code.*,api.*,db.*,telegram.*,scheduler.*"
    ),
    memoryTurns: Number(optional("MEMORY_TURNS", "12")),
    rateLimitMs: Number(optional("RATE_LIMIT_MS", "2000")),
    maxToolChain: Number(optional("MAX_TOOL_CHAIN", "5")),
    shellTimeout: Number(optional("SHELL_TIMEOUT_MS", "30000")),
    codeTimeout: Number(optional("CODE_TIMEOUT_MS", "30000")),
    cliTimeoutMs: Number(optional("CLI_TIMEOUT_MS", "180000")),
    claudeModel: optional("CLAUDE_MODEL", "claude-sonnet-4-5-20250929"),
    logLevel: optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
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

    // Outbound calls
    twilioPhoneNumber: optional("TWILIO_PHONE_NUMBER", ""),
    nicolasPhoneNumber: optional("NICOLAS_PHONE_NUMBER", ""),

    // Gemini (image generation)
    geminiApiKey: optional("GEMINI_API_KEY", ""),

    // Anthropic API (for vision / computer-use)
    anthropicApiKey: optional("ANTHROPIC_API_KEY", ""),

    // Browser (Puppeteer)
    browserMode: optional("BROWSER_MODE", "visible") as "headless" | "visible" | "connect",
    browserCdpUrl: optional("BROWSER_CDP_URL", ""),
    browserChromePath: optional("BROWSER_CHROME_PATH", ""),
    browserViewportWidth: Number(optional("BROWSER_VIEWPORT_WIDTH", "1280")),
    browserViewportHeight: Number(optional("BROWSER_VIEWPORT_HEIGHT", "720")),
    browserTimeoutMs: Number(optional("BROWSER_TIMEOUT_MS", "30000")),
    browserIdleMs: Number(optional("BROWSER_IDLE_MS", "300000")),

    // Gmail
    gmailCredentialsPath: optional("GMAIL_CREDENTIALS_PATH", "./relay/gmail/credentials.json"),
    gmailTokenPath: optional("GMAIL_TOKEN_PATH", "./relay/gmail/token.json"),

    // Brave Search
    braveSearchApiKey: optional("BRAVE_SEARCH_API_KEY", ""),

    // OpenClaw enhancements
    reactionsEnabled: optional("REACTIONS_ENABLED", "true") === "true",
    debounceEnabled: optional("DEBOUNCE_ENABLED", "true") === "true",
    debounceMs: Number(optional("DEBOUNCE_MS", "1500")),
    streamingEnabled: optional("STREAMING_ENABLED", "true") === "true",
    draftEditIntervalMs: Number(optional("DRAFT_EDIT_INTERVAL_MS", "300")),
    draftStartThreshold: Number(optional("DRAFT_START_THRESHOLD", "40")),
  };
}

export const config: ReturnType<typeof buildConfig> = buildConfig();

export function reloadEnv(): void {
  dotenv.config({ override: true });
  Object.assign(config, buildConfig());
  log.info("[config] Environment reloaded");
}

export function watchEnv(): void {
  const envPath = path.resolve(".env");
  if (!fs.existsSync(envPath)) return;
  fs.watchFile(envPath, { interval: 2000 }, () => {
    log.info("[config] .env file changed — reloading");
    reloadEnv();
  });
  log.info("[config] Watching .env for changes");
}
