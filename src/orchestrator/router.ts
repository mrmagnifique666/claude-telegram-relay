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

    // Security: check allowlist + admin
    if (!isToolPermitted(tool, userId)) {
      const msg = tool
        ? `Tool "${tool}" is not permitted${getSkill(tool)?.adminOnly ? " (admin only)" : ""}.`
        : "Tool not permitted.";
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Look up skill
    const skill = getSkill(tool);
    if (!skill) {
      const msg = `Unknown tool: "${tool}".`;
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Validate args
    const validationError = validateArgs(args, skill.argsSchema);
    if (validationError) {
      const msg = `Tool "${tool}" argument error: ${validationError}`;
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Execute skill
    log.info(`Executing tool (step ${step + 1}/${config.maxToolChain}): ${tool}`);
    let toolResult: string;
    try {
      toolResult = await skill.execute(args);
    } catch (err) {
      const msg = `Tool "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(msg);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
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
    addTurn(chatId, { role: "assistant", content: msg });
    return msg;
  }

  // Shouldn't reach here, but safety fallback
  const text = result.type === "message" ? result.text : "(unexpected state)";
  addTurn(chatId, { role: "assistant", content: text });
  return text;
}
