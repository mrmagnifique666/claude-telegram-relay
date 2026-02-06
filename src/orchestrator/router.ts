/**
 * Orchestrator / tool router.
 * Receives parsed Claude output, validates tool calls, executes skills,
 * and supports multi-step tool chaining (up to MAX_TOOL_CHAIN iterations).
 */
import { isToolPermitted } from "../security/policy.js";
import { isAdmin } from "../security/policy.js";
import { getSkill, validateArgs } from "../skills/loader.js";
import { runClaude } from "../llm/claudeCli.js";
import { runClaudeStream, type StreamResult } from "../llm/claudeStream.js";
import { addTurn, logError } from "../storage/store.js";
import { autoCompact } from "./compaction.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import type { DraftController } from "../bot/draftMessage.js";

/**
 * Callback to send intermediate progress updates to the user.
 */
export let progressCallback: ((chatId: number, message: string) => Promise<void>) | null = null;

export function setProgressCallback(cb: (chatId: number, message: string) => Promise<void>) {
  progressCallback = cb;
}

/**
 * Handle a user message end-to-end:
 * 1. Send to Claude
 * 2. If Claude returns a tool call, validate & execute it
 * 3. Feed tool result back to Claude — repeat up to maxToolChain times
 * 4. Store turns and return the final text
 */
export async function handleMessage(
  chatId: number,
  userMessage: string,
  userId: number
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  // Store user turn
  addTurn(chatId, { role: "user", content: userMessage });

  // First pass: Claude
  log.info(`[router] Sending to Claude (admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);
  let result = await runClaude(chatId, userMessage, userIsAdmin);
  log.info(`[router] Claude responded with type: ${result.type}`);

  if (result.type === "message") {
    addTurn(chatId, { role: "assistant", content: result.text });
    return result.text;
  }

  // Tool chaining loop
  for (let step = 0; step < config.maxToolChain; step++) {
    if (result.type !== "tool_call") break;

    const { tool, args } = result;

    // Guard against malformed tool calls
    if (!tool || typeof tool !== "string") {
      const errorMsg = "Tool call missing or invalid tool name.";
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:malformed_tool");
      addTurn(chatId, { role: "assistant", content: errorMsg });
      return errorMsg;
    }
    if (!args || typeof args !== "object") {
      log.debug(`[router] Tool "${tool}" called with missing args — defaulting to {}`);
      result.args = {};
    }
    const safeArgs = result.args as Record<string, unknown>;

    // Normalize common arg aliases (snake_case → camelCase)
    if (safeArgs.chat_id !== undefined && safeArgs.chatId === undefined) {
      safeArgs.chatId = safeArgs.chat_id;
      delete safeArgs.chat_id;
      log.debug(`[router] Normalized chat_id → chatId for ${tool}`);
    }
    if (safeArgs.message !== undefined && safeArgs.text === undefined) {
      safeArgs.text = safeArgs.message;
      delete safeArgs.message;
      log.debug(`[router] Normalized message → text for ${tool}`);
    }

    // Auto-inject chatId for telegram.*/browser.* skills when missing
    if ((tool.startsWith("telegram.") || tool.startsWith("browser.")) && !safeArgs.chatId) {
      safeArgs.chatId = String(chatId);
      log.debug(`[router] Auto-injected chatId=${chatId} for ${tool}`);
    }

    // Security: check allowlist + admin — hard block, no retry
    if (!isToolPermitted(tool, userId)) {
      const msg = tool
        ? `Tool "${tool}" is not permitted${getSkill(tool)?.adminOnly ? " (admin only)" : ""}.`
        : "Tool not permitted.";
      if (progressCallback) {
        await progressCallback(chatId, `❌ ${msg}`);
      }
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Look up skill — feed error back to Claude so it can retry
    const skill = getSkill(tool);
    if (!skill) {
      const errorMsg = `Error: Unknown tool "${tool}". Check the tool catalog and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:unknown_tool");
      if (progressCallback) {
        await progressCallback(chatId, `❌ Unknown tool: ${tool}`);
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    // Validate args — feed error back to Claude so it can fix & retry
    const validationError = validateArgs(safeArgs, skill.argsSchema);
    if (validationError) {
      const errorMsg = `Tool "${tool}" argument error: ${validationError}. Fix the arguments and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:validation");
      if (progressCallback) {
        await progressCallback(chatId, `❌ Arg error on ${tool}`);
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    // Execute skill — feed errors back to Claude so it can adapt
    log.info(`Executing tool (step ${step + 1}/${config.maxToolChain}): ${tool}`);
    let toolResult: string;
    try {
      toolResult = await skill.execute(safeArgs);
    } catch (err) {
      const errorMsg = `Tool "${tool}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(errorMsg);
      logError(err instanceof Error ? err : errorMsg, `router:exec:${tool}`);
      if (progressCallback) {
        await progressCallback(chatId, `❌ ${tool} failed`);
      }
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    log.debug(`Tool result (${tool}):`, toolResult.slice(0, 200));

    // Heartbeat: send intermediate progress to Telegram
    if (progressCallback) {
      const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
      await progressCallback(chatId, `⚙️ **${tool}**\n\`\`\`\n${preview}\n\`\`\``);
    }

    // Feed tool result back to Claude for next step or final answer
    const followUp = `[Tool "${tool}" returned]:\n${toolResult}`;
    addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
    addTurn(chatId, { role: "user", content: followUp });

    log.info(`[router] Feeding tool result back to Claude (step ${step + 1})...`);
    result = await runClaude(chatId, followUp, userIsAdmin);
    log.info(`[router] Claude follow-up response type: ${result.type}`);

    // If Claude responds with a message, we're done
    if (result.type === "message") {
      addTurn(chatId, { role: "assistant", content: result.text });
      return result.text;
    }

    // Otherwise loop continues with next tool call
    log.info(`[router] Continuing chain — next tool: ${result.type === "tool_call" ? result.tool : "unknown"}`);
  }

  // If we exhausted the chain limit and still got a tool_call
  if (result.type === "tool_call") {
    const msg = `Reached tool chain limit (${config.maxToolChain} steps). Last pending tool: ${result.tool}.`;
    logError(msg, "router:chain_limit");
    if (progressCallback) {
      await progressCallback(chatId, `⚠️ Chain limit reached (${config.maxToolChain} steps)`);
    }
    addTurn(chatId, { role: "assistant", content: msg });
    return msg;
  }

  // Shouldn't reach here, but safety fallback
  const text = result.type === "message" ? result.text : "(unexpected state)";
  addTurn(chatId, { role: "assistant", content: text });
  return text;
}

/**
 * Handle a user message with streaming output.
 * The final text response is streamed to the draft controller in real-time.
 * Tool calls during streaming suppress the draft and execute normally.
 * Only the final response is streamed — intermediate tool chain steps use batch mode.
 */
export async function handleMessageStreaming(
  chatId: number,
  userMessage: string,
  userId: number,
  draft: DraftController
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  addTurn(chatId, { role: "user", content: userMessage });

  log.info(`[router] Streaming to Claude (admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);

  // First pass: try streaming
  const streamResult = await runClaudeStreamAsync(chatId, userMessage, userIsAdmin, draft);

  // If it's a plain text response, we're done (draft already has the content)
  if (!streamResult.is_tool_call) {
    addTurn(chatId, { role: "assistant", content: streamResult.text });
    await draft.finalize();
    return streamResult.text;
  }

  // It's a tool call — cancel the draft and process the tool chain in batch mode
  await draft.cancel();

  let result = {
    type: streamResult.is_tool_call ? "tool_call" as const : "message" as const,
    text: streamResult.text,
    tool: streamResult.tool || "",
    args: streamResult.args || {},
    session_id: streamResult.session_id,
  };

  // Tool chaining loop (batch mode for intermediate steps)
  for (let step = 0; step < config.maxToolChain; step++) {
    if (result.type !== "tool_call") break;

    const { tool, args: rawArgs } = result;

    if (!tool || typeof tool !== "string") {
      const errorMsg = "Tool call missing or invalid tool name.";
      addTurn(chatId, { role: "assistant", content: errorMsg });
      return errorMsg;
    }
    const safeArgs = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;

    // Normalize arg aliases
    if (safeArgs.chat_id !== undefined && safeArgs.chatId === undefined) {
      safeArgs.chatId = safeArgs.chat_id;
      delete safeArgs.chat_id;
    }
    if (safeArgs.message !== undefined && safeArgs.text === undefined) {
      safeArgs.text = safeArgs.message;
      delete safeArgs.message;
    }
    if ((tool.startsWith("telegram.") || tool.startsWith("browser.")) && !safeArgs.chatId) {
      safeArgs.chatId = String(chatId);
    }

    if (!isToolPermitted(tool, userId)) {
      const msg = `Tool "${tool}" is not permitted.`;
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    const skill = getSkill(tool);
    if (!skill) {
      const followUp = `[Tool "${tool}" error]:\nUnknown tool "${tool}".`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin);
      if (batchResult.type === "message") {
        addTurn(chatId, { role: "assistant", content: batchResult.text });
        return batchResult.text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    const validationError = validateArgs(safeArgs, skill.argsSchema);
    if (validationError) {
      const followUp = `[Tool "${tool}" error]:\nArgument error: ${validationError}.`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin);
      if (batchResult.type === "message") {
        addTurn(chatId, { role: "assistant", content: batchResult.text });
        return batchResult.text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    log.info(`[router-stream] Executing tool (step ${step + 1}): ${tool}`);
    let toolResult: string;
    try {
      toolResult = await skill.execute(safeArgs);
    } catch (err) {
      const errorMsg = `Tool "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`;
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin);
      if (batchResult.type === "message") {
        addTurn(chatId, { role: "assistant", content: batchResult.text });
        return batchResult.text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    if (progressCallback) {
      const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
      await progressCallback(chatId, `⚙️ **${tool}**\n\`\`\`\n${preview}\n\`\`\``);
    }

    const followUp = `[Tool "${tool}" returned]:\n${toolResult}`;
    addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
    addTurn(chatId, { role: "user", content: followUp });

    // For the final step (or if this is the last tool), try streaming the response
    const batchResult = await runClaude(chatId, followUp, userIsAdmin);
    if (batchResult.type === "message") {
      addTurn(chatId, { role: "assistant", content: batchResult.text });
      return batchResult.text;
    }
    result = batchResultToRouterResult(batchResult);
  }

  if (result.type === "tool_call") {
    const msg = `Reached tool chain limit (${config.maxToolChain} steps).`;
    addTurn(chatId, { role: "assistant", content: msg });
    return msg;
  }

  const text = result.type === "message" ? result.text : "(unexpected state)";
  addTurn(chatId, { role: "assistant", content: text });
  return text;
}

/** Run Claude stream and return a promise that resolves with the result. */
function runClaudeStreamAsync(
  chatId: number,
  userMessage: string,
  isAdminUser: boolean,
  draft: DraftController
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    runClaudeStream(chatId, userMessage, isAdminUser, {
      onDelta(text: string) {
        // Only update draft if it doesn't look like a tool call
        if (!text.trimStart().startsWith('{"type":"tool_call"')) {
          draft.update(text).catch(() => {});
        }
      },
      onComplete(result: StreamResult) {
        resolve(result);
      },
      onError(error: Error) {
        reject(error);
      },
    });
  });
}

/** Convert a batch ParsedResult to the router's internal format. */
function batchResultToRouterResult(r: { type: string; text?: string; tool?: string; args?: Record<string, unknown> }) {
  if (r.type === "tool_call") {
    return { type: "tool_call" as const, text: "", tool: r.tool || "", args: r.args || {} };
  }
  return { type: "message" as const, text: (r as any).text || "", tool: "", args: {} };
}
