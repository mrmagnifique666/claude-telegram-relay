/**
 * claude-telegram-relay — Entry point
 *
 * Inspired by: https://github.com/godagoo/claude-telegram-relay
 * Original code, written from scratch.
 *
 * Connects Telegram chats to a local Claude Code CLI instance.
 */
import { config } from "./config/env.js";
import { setLogLevel, addRedactPattern, log } from "./utils/log.js";
import { loadBuiltinSkills } from "./skills/loader.js";
import { processCodeRequests } from "./processors/codequeue.js";
import { createBot } from "./bot/telegram.js";
import { startVoiceServer } from "./voice/server.js";
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

  // Redact the bot token from logs
  if (config.telegramToken) {
    addRedactPattern(new RegExp(config.telegramToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
  }

  log.info("Starting claude-telegram-relay...");
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

  // Register cleanup handlers
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(0);
  });

  // Process any pending code requests from Kingston
  await processCodeRequests();

  // Load skills
  await loadBuiltinSkills();

  // Start voice server (before bot.start() which blocks)
  startVoiceServer();

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
