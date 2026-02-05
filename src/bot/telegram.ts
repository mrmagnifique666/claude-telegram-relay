/**
 * Telegram bot setup using grammY with long polling.
 * Handles text messages, user allowlist checks, and rate limiting.
 * Sends messages with HTML parse mode and converts markdown code blocks.
 */
import { Bot } from "grammy";
import { config } from "../config/env.js";
import { isUserAllowed, tryAdminAuth } from "../security/policy.js";
import { consumeToken } from "../security/rateLimit.js";
import { handleMessage } from "../orchestrator/router.js";
import { clearTurns } from "../storage/store.js";
import { log } from "../utils/log.js";

const MAX_TG_MESSAGE = 4096;

/**
 * Convert basic markdown formatting to Telegram HTML.
 * Handles: ```code blocks```, `inline code`, **bold**, *italic*
 */
function mdToHtml(text: string): string {
  // Escape HTML entities first (except in code blocks which we'll handle)
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre>${code}</pre>`;
  });

  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *...*  (but not inside bold which we already converted)
  html = html.replace(/(?<![<b>])\*(.+?)\*(?![</b>])/g, "<i>$1</i>");

  return html;
}

export function createBot(): Bot {
  const bot = new Bot(config.telegramToken);

  // --- Commands ---

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Hello! I'm an OpenClaw relay bot. Send me a message and I'll pass it to Claude.\n\n" +
        "Commands:\n" +
        "/clear — reset conversation history\n" +
        "/help — list available tools\n" +
        "/admin &lt;passphrase&gt; — unlock admin tools",
      { parse_mode: "HTML" }
    );
  });

  bot.command("clear", async (ctx) => {
    const chatId = ctx.chat.id;
    clearTurns(chatId);
    await ctx.reply("Conversation history cleared.");
  });

  bot.command("help", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId)) {
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }
    const response = await handleMessage(
      ctx.chat.id,
      "/help — list all available tools",
      userId
    );
    await sendLong(ctx, response);
  });

  bot.command("admin", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const passphrase = ctx.match?.trim();
    if (!passphrase) {
      await ctx.reply("Usage: /admin <passphrase>");
      return;
    }
    if (tryAdminAuth(userId, passphrase)) {
      await ctx.reply("Admin mode activated for this session.");
    } else {
      await ctx.reply("Invalid passphrase.");
    }
  });

  // --- Text message handler ---

  bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Allowlist check
    if (!isUserAllowed(userId)) {
      log.warn(`Blocked message from unauthorised user ${userId}`);
      await ctx.reply("You are not authorised to use this bot.");
      return;
    }

    // Rate limit
    if (!consumeToken(userId)) {
      await ctx.reply(
        "Slow down! Please wait a moment before sending another message."
      );
      return;
    }

    log.info(
      `Message from user ${userId} in chat ${chatId}: ${text.slice(0, 80)}...`
    );

    // Show typing indicator
    await ctx.replyWithChatAction("typing");

    try {
      const response = await handleMessage(chatId, text, userId);
      await sendLong(ctx, response);
    } catch (err) {
      log.error("Error handling message:", err);
      await ctx.reply("Sorry, something went wrong processing your message.");
    }
  });

  // --- Voice message stub (behind feature flag) ---
  if (config.featureVoice) {
    bot.on("message:voice", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !isUserAllowed(userId)) return;
      await ctx.reply(
        "Voice message received. Transcription is not yet implemented — please send text instead."
      );
    });
  }

  // --- Image/file stub (behind feature flag) ---
  if (config.featureImage) {
    bot.on("message:photo", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !isUserAllowed(userId)) return;
      await ctx.reply(
        "Image received. Image processing is not yet implemented — please send text instead."
      );
    });
  }

  // Error handler
  bot.catch((err) => {
    log.error("Bot error:", err.message || err);
  });

  return bot;
}

/**
 * Send a potentially long message, splitting at Telegram's 4096 char limit.
 * Uses HTML parse mode with markdown-to-HTML conversion.
 */
async function sendLong(
  ctx: {
    reply: (
      text: string,
      options?: { parse_mode?: string }
    ) => Promise<unknown>;
  },
  text: string
) {
  const html = mdToHtml(text);

  if (html.length <= MAX_TG_MESSAGE) {
    try {
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch {
      // Fallback to plain text if HTML parsing fails
      await ctx.reply(text);
    }
    return;
  }

  // Split on newlines or hard-cut
  let remaining = html;
  while (remaining.length > 0) {
    let chunk: string;
    if (remaining.length <= MAX_TG_MESSAGE) {
      chunk = remaining;
      remaining = "";
    } else {
      const cutAt = remaining.lastIndexOf("\n", MAX_TG_MESSAGE);
      const splitPos = cutAt > MAX_TG_MESSAGE * 0.5 ? cutAt : MAX_TG_MESSAGE;
      chunk = remaining.slice(0, splitPos);
      remaining = remaining.slice(splitPos);
    }
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(chunk);
    }
  }
}
