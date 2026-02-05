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
import { createBot } from "./bot/telegram.js";
import fs from "node:fs";
import path from "node:path";

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

  // Ensure sandbox directory exists
  const sandboxPath = path.resolve(config.sandboxDir);
  if (!fs.existsSync(sandboxPath)) {
    fs.mkdirSync(sandboxPath, { recursive: true });
    log.info(`Created sandbox directory: ${sandboxPath}`);
  }

  // Load skills
  await loadBuiltinSkills();

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
  console.error("Fatal error:", err);
  process.exit(1);
});
