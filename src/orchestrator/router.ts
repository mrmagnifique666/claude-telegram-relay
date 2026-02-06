/**
 * Orchestrator / tool router.
 * Receives parsed Claude output, validates tool calls, executes skills,
 * and supports multi-step tool chaining (up to MAX_TOOL_CHAIN iterations).
 */
import { isToolPermitted } from "../security/policy.js";
import { isAdmin } from "../security/policy.js";
import { getSkill, validateArgs } from "../skills/loader.js";
import { runClaude } from "../llm/claudeCli.js";
import { addTurn } from "../storage/store.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

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

    // Normalize common arg aliases (snake_case → camelCase)
    if (args.chat_id !== undefined && args.chatId === undefined) {
      args.chatId = args.chat_id;
      delete args.chat_id;
    }
    if (args.message !== undefined && args.text === undefined) {
      args.text = args.message;
      delete args.message;
    }

    // Auto-inject chatId for telegram.* skills when missing
    if (tool.startsWith("telegram.") && !args.chatId) {
      args.chatId = String(chatId);
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
    const validationError = validateArgs(args, skill.argsSchema);
    if (validationError) {
      const errorMsg = `Tool "${tool}" argument error: ${validationError}. Fix the arguments and try again.`;
      log.warn(`[router] ${errorMsg}`);
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
      toolResult = await skill.execute(args);
    } catch (err) {
      const errorMsg = `Tool "${tool}" execution failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(errorMsg);
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
