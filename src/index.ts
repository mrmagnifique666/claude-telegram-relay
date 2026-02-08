/**
 * claude-telegram-relay — Entry point
 *
 * Inspired by: https://github.com/godagoo/claude-telegram-relay
 * Original code, written from scratch.
 *
 * Connects Telegram chats to a local Claude Code CLI instance.
 */
import { config, watchEnv } from "./config/env.js";
import { setLogLevel, addRedactPattern, log } from "./utils/log.js";
import { loadBuiltinSkills } from "./skills/loader.js";
import { migrateNotesToMemories } from "./memory/semantic.js";
import { processCodeRequests } from "./processors/codequeue.js";
import { createBot } from "./bot/telegram.js";
import { startVoiceServer } from "./voice/server.js";
import { startScheduler, stopScheduler } from "./scheduler/scheduler.js";
import { startAgents, shutdownAgents } from "./agents/startup.js";
import { cleanupDatabase } from "./storage/store.js";
import { startDashboard } from "./dashboard/server.js";
import fs from "node:fs";
import path from "node:path";

const LOCK_FILE = path.resolve(config.relayDir, "bot.lock");

interface LockData {
  pid: number;
  timestamp: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): void {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      const lock: LockData = JSON.parse(raw);
      if (isPidAlive(lock.pid)) {
        console.error(
          `Another instance is already running (PID ${lock.pid}, started ${lock.timestamp}).\n` +
          `If this is incorrect, delete ${LOCK_FILE} and try again.`
        );
        process.exit(1);
      }
      log.warn(`Removing stale lock file (PID ${lock.pid} is not running)`);
    } catch {
      log.warn("Removing unreadable lock file");
    }
    fs.unlinkSync(LOCK_FILE);
  }

  const data: LockData = { pid: process.pid, timestamp: new Date().toISOString() };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2));
  log.debug(`Lock file created: PID ${process.pid}`);
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, "utf-8");
      const lock: LockData = JSON.parse(raw);
      // Only remove if it's our lock
      if (lock.pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        log.debug("Lock file removed");
      }
    }
  } catch {
    // Best-effort cleanup
  }
}

async function main() {
  // Configure logging
  setLogLevel(config.logLevel);

  // Redact secrets from logs
  const secretsToRedact = [
    config.telegramToken,
    config.geminiApiKey,
    config.anthropicApiKey,
    config.twilioAuthToken,
    config.deepgramApiKey,
    config.elevenlabsApiKey,
    config.adminPassphrase,
    config.braveSearchApiKey,
  ];
  for (const secret of secretsToRedact) {
    if (secret && secret.length > 4) {
      addRedactPattern(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    }
  }

  log.info("Starting Bastion OS — Kingston online...");
  log.info(`Allowed users: ${config.allowedUsers.length > 0 ? config.allowedUsers.join(", ") : "(none — all blocked!)"}`);
  log.info(`Allowed tools: ${config.allowedTools.join(", ")}`);
  log.info(`Memory turns: ${config.memoryTurns}`);
  log.info(`Rate limit: ${config.rateLimitMs}ms`);

  // Ensure directories exist
  for (const dir of [config.sandboxDir, config.relayDir, config.uploadsDir]) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
      log.info(`Created directory: ${resolved}`);
    }
  }

  // Acquire lock file (exits if another instance is running)
  acquireLock();

  // Register cleanup handlers with graceful shutdown
  process.on("exit", releaseLock);

  let shuttingDown = false;
  function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[bastion] ${signal} received — shutting down gracefully...`);
    shutdownAgents();
    stopScheduler();
    // Give in-flight requests up to 5 seconds to complete
    setTimeout(() => {
      log.info("[bastion] Grace period ended — exiting.");
      releaseLock();
      process.exit(0);
    }, 5000);
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  // Catch unhandled errors — prevent silent crashes
  process.on("uncaughtException", (err) => {
    log.error("[FATAL] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("[FATAL] Unhandled promise rejection:", reason);
  });

  // Process any pending code requests from Kingston
  await processCodeRequests();

  // Load skills
  await loadBuiltinSkills();

  // Migrate notes to semantic memory (one-time, non-blocking)
  migrateNotesToMemories().catch(err =>
    log.warn(`[semantic] Migration failed: ${err instanceof Error ? err.message : String(err)}`)
  );

  // Watch .env for hot-reload
  watchEnv();

  // Cleanup stale database entries on startup
  cleanupDatabase();

  // Start voice server (before bot.start() which blocks)
  startVoiceServer();

  // Start scheduler with its own chatId (1) to avoid polluting Nicolas's CLI session
  // userId stays as Nicolas's so telegram.send reaches him
  startScheduler(1, config.voiceUserId);

  // Start autonomous agents
  startAgents();

  // Start local dashboard UI
  startDashboard();

  // Create and start Telegram bot (long polling)
  const bot = createBot();

  log.info("Starting Telegram long polling...");
  await bot.start({
    onStart: (botInfo) => {
      log.info(`Bot online as @${botInfo.username} (id: ${botInfo.id})`);
    },
  });
}

main().catch((err) => {
  releaseLock();
  console.error("Fatal error:", err);
  process.exit(1);
});
