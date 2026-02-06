/**
 * Claude CLI integration.
 * Spawns `claude -p ... --output-format json` and captures output.
 * Passes the prompt via stdin to avoid command-line length limits (especially on Windows).
 * Supports session resumption via --resume <sessionId>.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { parseClaudeOutput, type ParsedResult } from "./protocol.js";
import { getTurns, getSession, saveSession } from "../storage/store.js";
import { getToolCatalogPrompt } from "../skills/loader.js";

const CLI_TIMEOUT_MS = 120_000; // 2 minutes max per Claude CLI call

/** Load AUTONOMOUS.md if it exists */
function loadAutonomousPrompt(): string {
  try {
    const p = path.resolve(process.cwd(), "AUTONOMOUS.md");
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, "utf-8");
    }
  } catch { /* ignore */ }
  return "";
}

function buildSystemPolicy(isAdmin: boolean, chatId?: number): string {
  const lines = [
    `You are OpenClaw, an autonomous assistant operating through a Telegram relay on the user's machine.`,
    `You are proactive, capable, and concise.`,
    ``,
    `## Environment`,
    `- Platform: ${os.platform()} ${os.arch()}`,
    `- OS: ${os.type()} ${os.release()}`,
    `- Hostname: ${os.hostname()}`,
    `- Node: ${process.version}`,
    `- Working directory: ${process.cwd()}`,
    `- Date: ${new Date().toISOString().split("T")[0]}`,
    `- Admin: ${isAdmin ? "yes" : "no"}`,
    ...(chatId ? [`- Telegram chat ID: ${chatId} (auto-injected for telegram.send — you can omit chatId)`] : []),
    ``,
    `## Tool use`,
    `You have access to a set of tools. To call a tool, respond with EXACTLY this JSON (no markdown fences):`,
    `{"type":"tool_call","tool":"<tool.name>","args":{...}}`,
    `Only call tools that are listed in the tool catalog below. There is NO "self.notify" tool — to message the user, use telegram.send.`,
    `You may chain multiple tool calls in a row — after each tool result you can call another tool or respond to the user.`,
    `If you are not calling a tool, respond with plain text only.`,
    ``,
    `## Guidelines`,
    `- Be concise but thorough.`,
    `- When a task requires multiple steps, chain tool calls to complete it autonomously.`,
    `- If a tool call fails, try an alternative approach before giving up.`,
    `- Format responses for Telegram: use short paragraphs, bullet points, and code blocks where helpful.`,
    ``,
    `## Self-modification (admin only)`,
    `- Your source code is at: ${process.cwd()}`,
    `- You can read your own code with files.read_anywhere`,
    `- You can modify your own code with files.write_anywhere`,
    `- You can run shell commands with shell.exec`,
    `- You can execute code with code.run`,
    `- After modifying code, the bot must be restarted to apply changes.`,
  ];

  // Append AUTONOMOUS.md content if it exists
  const autonomousPrompt = loadAutonomousPrompt();
  if (autonomousPrompt) {
    lines.push("", autonomousPrompt);
  }

  return lines.join("\n");
}

/**
 * Build the full prompt: system policy + tool catalog + conversation history + current message.
 * Used only for new sessions (no --resume).
 */
function buildFullPrompt(
  chatId: number,
  userMessage: string,
  isAdmin: boolean
): string {
  const parts: string[] = [];

  // System policy
  parts.push(`[SYSTEM]\n${buildSystemPolicy(isAdmin, chatId)}`);

  // Tool catalog
  const catalog = getToolCatalogPrompt(isAdmin);
  if (catalog) {
    parts.push(`\n[TOOLS]\n${catalog}`);
  }

  // Conversation history
  const turns = getTurns(chatId);
  if (turns.length > 0) {
    parts.push("\n[CONVERSATION HISTORY]");
    for (const t of turns) {
      const label = t.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${t.content}`);
    }
  }

  // Current message
  parts.push(`\n[CURRENT MESSAGE]\nUser: ${userMessage}`);

  return parts.join("\n");
}

/**
 * Run the Claude CLI with the given prompt and return parsed output.
 * Uses stdin to pass the prompt to avoid shell quoting issues.
 * Resumes existing sessions when available for token savings.
 */
export async function runClaude(
  chatId: number,
  userMessage: string,
  isAdmin: boolean = false
): Promise<ParsedResult> {
  const existingSession = getSession(chatId);
  const isResume = !!existingSession;

  // For resumed sessions, prepend context + tool catalog so Claude knows exact param names.
  // For new sessions, build the full prompt with system policy + tools + history.
  let prompt: string;
  if (isResume) {
    const catalog = getToolCatalogPrompt(isAdmin);
    const catalogBlock = catalog ? `\n[TOOLS]\n${catalog}\n` : "";
    prompt = `[Context: chatId=${chatId}, admin=${isAdmin}]${catalogBlock}\n${userMessage}`;
  } else {
    prompt = buildFullPrompt(chatId, userMessage, isAdmin);
  }

  log.debug(`Claude prompt length: ${prompt.length} (resume: ${isResume})`);

  return new Promise<ParsedResult>((resolve) => {
    const args = ["-p", "-", "--output-format", "json", "--model", config.claudeModel];

    if (isResume) {
      args.push("--resume", existingSession);
      log.debug(`Resuming session: ${existingSession}`);
    }

    log.debug(`Spawning: ${config.claudeBin} ${args.join(" ")}`);

    const proc = spawn(config.claudeBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    // Timeout: kill the process if it takes too long
    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      log.warn(`Claude CLI timed out after ${CLI_TIMEOUT_MS}ms`);
    }, CLI_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Write the prompt to stdin and close it
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.error("Failed to spawn Claude CLI:", err.message);
      resolve({
        type: "message",
        text: `Error: Could not run Claude CLI. Is "${config.claudeBin}" on your PATH?\n\n${err.message}`,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (killed) {
        resolve({
          type: "message",
          text: "(Claude CLI timed out — response took too long)",
        });
        return;
      }

      if (code !== 0) {
        log.warn(`Claude CLI exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
      }
      if (!stdout.trim()) {
        log.warn("Claude CLI returned empty stdout. stderr:", stderr.slice(0, 500));
        resolve({
          type: "message",
          text: stderr.trim() || "(Claude returned an empty response)",
        });
        return;
      }

      log.debug(`Claude raw output (first 300 chars): ${stdout.slice(0, 300)}`);
      const result = parseClaudeOutput(stdout);
      log.debug("Parsed Claude result type:", result.type);
      if (result.type === "tool_call") {
        log.debug(`Parsed tool_call: ${result.tool}(${JSON.stringify(result.args).slice(0, 200)})`);
      }

      // Save session_id for future resumption
      if (result.session_id) {
        saveSession(chatId, result.session_id);
        log.debug(`Session saved: ${result.session_id}`);
      }

      resolve(result);
    });
  });
}
