/**
 * Streaming Claude CLI integration.
 * Spawns `claude -p - --output-format stream-json --verbose` and parses NDJSON output.
 * Provides real-time text deltas for draft message updates.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { getTurns, getSession, saveSession } from "../storage/store.js";
import { getToolCatalogPrompt } from "../skills/loader.js";

export interface StreamResult {
  text: string;
  session_id?: string;
  is_tool_call: boolean;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface StreamCallbacks {
  onDelta(text: string): void;
  onComplete(result: StreamResult): void;
  onError(error: Error): void;
}

export interface StreamHandle {
  cancel(): void;
}

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
    `You are Kingston, an autonomous AI assistant operating through a Telegram relay on the user's machine.`,
    `Your name is Kingston. You are proactive, capable, and concise.`,
    `IMPORTANT: Your identity is Kingston. Never identify as Émile, OpenClaw, Claude, or any other name.`,
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
    `## Guidelines (CRITICAL — READ CAREFULLY)`,
    `- EXECUTE IMMEDIATELY. Never ask "would you like me to...?" or "should I...?" — JUST DO IT.`,
    `- If Nicolas asks you to do something, USE TOOLS RIGHT NOW. Do not describe what you would do.`,
    `- You have FULL admin access. You can write files, run shell commands, deploy via FTP, browse the web.`,
    `- When a task requires multiple steps, chain ALL tool calls autonomously until completion.`,
    `- If a tool call fails, try an alternative approach before giving up.`,
    `- NEVER ask for permission to write files, execute code, or use any tool. You already have permission.`,
    `- The ONLY time to ask a question is when the task itself is ambiguous (e.g. "which color?").`,
    `- Format responses for Telegram: use short paragraphs, bullet points, and code blocks where helpful.`,
    ``,
    `## Image Analysis (CRITICAL - Prevent Hallucination)`,
    `- When analyzing images, describe ONLY what is clearly visible in the image.`,
    `- Do NOT fabricate, invent, or hallucinate details that are not present.`,
    `- If you're uncertain about details, say "I can see [X] but I'm not confident about [Y]".`,
    `- Never elaborate beyond what's shown in the image.`,
    `- If an image is ambiguous, acknowledge the ambiguity rather than guessing.`,
    `- Trust the image data provided — it is accurate and complete.`,
    ``,
    `## Self-modification (admin only)`,
    `- Your source code is at: ${process.cwd()}`,
    `- You can read your own code with files.read_anywhere`,
    `- You can modify your own code with files.write_anywhere`,
    `- You can run shell commands with shell.exec`,
    `- You can execute code with code.run`,
    `- After modifying code, the bot must be restarted to apply changes.`,
  ];

  const autonomousPrompt = loadAutonomousPrompt();
  if (autonomousPrompt) {
    lines.push("", autonomousPrompt);
  }

  return lines.join("\n");
}

function buildFullPrompt(chatId: number, userMessage: string, isAdmin: boolean): string {
  const parts: string[] = [];
  parts.push(`[SYSTEM]\n${buildSystemPolicy(isAdmin, chatId)}`);
  const catalog = getToolCatalogPrompt(isAdmin);
  if (catalog) parts.push(`\n[TOOLS]\n${catalog}`);
  const turns = getTurns(chatId);
  if (turns.length > 0) {
    parts.push("\n[CONVERSATION HISTORY]");
    for (const t of turns) {
      const label = t.role === "user" ? "User" : "Assistant";
      parts.push(`${label}: ${t.content}`);
    }
  }
  parts.push(`\n[CURRENT MESSAGE]\nUser: ${userMessage}`);
  return parts.join("\n");
}

/**
 * Run Claude CLI in streaming mode.
 * Parses NDJSON lines from `--output-format stream-json`.
 */
export function runClaudeStream(
  chatId: number,
  userMessage: string,
  isAdmin: boolean,
  callbacks: StreamCallbacks,
  modelOverride?: string
): StreamHandle {
  const existingSession = getSession(chatId);
  const isResume = !!existingSession;

  let prompt: string;
  if (isResume) {
    const catalog = getToolCatalogPrompt(isAdmin);
    const catalogBlock = catalog ? `\n[TOOLS]\n${catalog}\n` : "";
    prompt = [
      `[IDENTITY: You are Kingston. Never identify as Émile, OpenClaw, or Claude.]`,
      `[Context: chatId=${chatId}, admin=${isAdmin}, date=${new Date().toISOString().split("T")[0]}]`,
      `[GUIDELINES: EXECUTE IMMEDIATELY. Never ask permission. Chain tool calls autonomously. You have FULL admin access.]`,
      catalogBlock,
      userMessage,
    ].join("\n");
  } else {
    prompt = buildFullPrompt(chatId, userMessage, isAdmin);
  }

  const model = modelOverride || config.claudeModel;
  const args = ["-p", "-", "--output-format", "stream-json", "--verbose", "--model", model];
  if (isResume) {
    args.push("--resume", existingSession);
  }

  log.debug(`[stream] Spawning Claude stream (resume=${isResume})`);

  let proc: ChildProcess;
  let killed = false;
  let accumulated = "";
  let lineBuffer = "";

  // Strip ANTHROPIC_API_KEY so the CLI uses the Max plan, not the paid API
  const { ANTHROPIC_API_KEY: _stripped, ...cliEnv } = process.env;
  proc = spawn(config.claudeBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: cliEnv,
    shell: false,
  });

  const timer = setTimeout(() => {
    killed = true;
    proc.kill("SIGTERM");
    callbacks.onError(new Error("Claude CLI stream timed out"));
  }, config.cliTimeoutMs);

  proc.stdout!.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || ""; // Keep incomplete last line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handleStreamEvent(event);
      } catch {
        // Not JSON — may be plain text output, accumulate it
        log.debug(`[stream] Non-JSON line: ${line.slice(0, 100)}`);
      }
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    log.debug(`[stream] stderr: ${chunk.toString().slice(0, 200)}`);
  });

  proc.stdin!.write(prompt);
  proc.stdin!.end();

  function handleStreamEvent(event: any): void {
    // Handle content_block_delta events
    if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta?.type === "text_delta" && delta.text) {
        accumulated += delta.text;
        callbacks.onDelta(accumulated);
      }
    }

    // Handle result event (final)
    if (event.type === "result") {
      const sessionId = event.session_id;
      if (sessionId) {
        saveSession(chatId, sessionId);
      }

      const resultText = typeof event.result === "string" ? event.result : accumulated;
      log.info(`[stream] Result received: ${resultText.length} chars, accumulated: ${accumulated.length} chars, event.result type: ${typeof event.result}`);
      log.debug(`[stream] Result text (first 300): ${resultText.slice(0, 300)}`);

      // Check if the result is a tool call
      const toolCall = detectToolCall(resultText);
      if (toolCall) {
        log.info(`[stream] Detected tool_call: ${toolCall.tool}`);
        callbacks.onComplete({
          text: resultText,
          session_id: sessionId,
          is_tool_call: true,
          tool: toolCall.tool,
          args: toolCall.args,
        });
      } else {
        log.info(`[stream] Plain text response (no tool call)`);
        callbacks.onComplete({
          text: resultText,
          session_id: sessionId,
          is_tool_call: false,
        });
      }
    }

    // Handle message_start with session info
    if (event.type === "message_start" && event.message?.id) {
      log.debug(`[stream] Message started: ${event.message.id}`);
    }
  }

  proc.on("error", (err) => {
    clearTimeout(timer);
    callbacks.onError(err);
  });

  proc.on("close", (code) => {
    clearTimeout(timer);
    if (killed) return; // Already handled via timeout

    // Process any remaining line buffer
    if (lineBuffer.trim()) {
      try {
        const event = JSON.parse(lineBuffer);
        handleStreamEvent(event);
      } catch {
        // If we have accumulated text but no result event, emit it
        if (accumulated) {
          const toolCall = detectToolCall(accumulated);
          if (toolCall) {
            callbacks.onComplete({
              text: accumulated,
              is_tool_call: true,
              tool: toolCall.tool,
              args: toolCall.args,
            });
          } else {
            callbacks.onComplete({ text: accumulated, is_tool_call: false });
          }
        } else if (lineBuffer.trim()) {
          // Last resort — treat non-JSON output as text result
          callbacks.onComplete({ text: lineBuffer.trim(), is_tool_call: false });
        }
      }
    } else if (!accumulated && code !== 0) {
      callbacks.onError(new Error(`Claude CLI exited with code ${code}`));
    } else if (accumulated) {
      // Stream ended without a result event — finalize what we have
      const toolCall = detectToolCall(accumulated);
      callbacks.onComplete({
        text: accumulated,
        is_tool_call: !!toolCall,
        tool: toolCall?.tool,
        args: toolCall?.args,
      });
    } else {
      // Stream ended cleanly (code 0) with NO output — must still resolve the promise
      log.warn(`[stream] CLI exited cleanly but produced no output`);
      callbacks.onComplete({ text: "", is_tool_call: false });
    }
  });

  return {
    cancel() {
      killed = true;
      clearTimeout(timer);
      proc.kill("SIGTERM");
    },
  };
}

/**
 * Detect if accumulated text contains a tool_call JSON.
 */
function detectToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  // Strip markdown fences
  const stripped = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  const marker = /"type"\s*:\s*"tool_call"/;
  const match = marker.exec(stripped);
  if (!match) return null;

  // Walk backwards to find opening brace
  let start = match.index;
  while (start > 0 && stripped[start] !== "{") start--;
  if (stripped[start] !== "{") return null;

  // Brace-matching to find complete JSON
  let depth = 0;
  let end = start;
  let inString = false;
  let escape = false;

  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (depth !== 0) return null;

  try {
    const obj = JSON.parse(stripped.slice(start, end + 1));
    if (obj.type === "tool_call" && typeof obj.tool === "string") {
      return { tool: obj.tool, args: obj.args || {} };
    }
  } catch { /* ignore */ }
  return null;
}
