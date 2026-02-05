/**
 * Claude CLI integration.
 * Spawns `claude -p ... --output-format json` and captures output.
 * Passes the prompt via stdin to avoid command-line length limits (especially on Windows).
 */
import os from "node:os";
import { spawn } from "node:child_process";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { parseClaudeOutput, type ParsedResult } from "./protocol.js";
import { getTurns } from "../storage/store.js";
import { getToolCatalogPrompt } from "../skills/loader.js";

function buildSystemPolicy(isAdmin: boolean): string {
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
    ``,
    `## Tool use`,
    `You have access to a set of tools. To call a tool, respond with EXACTLY this JSON (no markdown fences):`,
    `{"type":"tool_call","tool":"<tool.name>","args":{...}}`,
    `Only call tools that are listed in the tool catalog below.`,
    `You may chain multiple tool calls in a row — after each tool result you can call another tool or respond to the user.`,
    `If you are not calling a tool, respond with plain text only.`,
    ``,
    `## Guidelines`,
    `- Be concise but thorough.`,
    `- When a task requires multiple steps, chain tool calls to complete it autonomously.`,
    `- If a tool call fails, try an alternative approach before giving up.`,
    `- Format responses for Telegram: use short paragraphs, bullet points, and code blocks where helpful.`,
  ];
  return lines.join("\n");
}

/**
 * Build the full prompt: system policy + tool catalog + conversation history + current message.
 */
function buildPrompt(
  chatId: number,
  userMessage: string,
  isAdmin: boolean
): string {
  const parts: string[] = [];

  // System policy
  parts.push(`[SYSTEM]\n${buildSystemPolicy(isAdmin)}`);

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
 */
export async function runClaude(
  chatId: number,
  userMessage: string,
  isAdmin: boolean = false
): Promise<ParsedResult> {
  const prompt = buildPrompt(chatId, userMessage, isAdmin);

  log.debug("Claude prompt length:", prompt.length);

  return new Promise<ParsedResult>((resolve) => {
    const args = ["-p", "-", "--output-format", "json"];

    log.debug(`Spawning: ${config.claudeBin} ${args.join(" ")}`);

    const proc = spawn(config.claudeBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

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
      log.error("Failed to spawn Claude CLI:", err.message);
      resolve({
        type: "message",
        text: `Error: Could not run Claude CLI. Is "${config.claudeBin}" on your PATH?\n\n${err.message}`,
      });
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        log.warn(`Claude CLI exited with code ${code}. stderr: ${stderr}`);
      }
      if (!stdout.trim()) {
        resolve({
          type: "message",
          text: stderr.trim() || "(Claude returned an empty response)",
        });
        return;
      }
      const result = parseClaudeOutput(stdout);
      log.debug("Parsed Claude result type:", result.type);
      resolve(result);
    });
  });
}
