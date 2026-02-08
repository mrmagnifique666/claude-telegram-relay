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
import { runGemini, GeminiRateLimitError, GeminiSafetyError } from "../llm/gemini.js";
import { addTurn, logError, getTurns, clearSession } from "../storage/store.js";
import { autoCompact } from "./compaction.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { extractAndStoreMemories } from "../memory/semantic.js";
import { selectModel, getModelId, modelLabel, type ModelTier } from "../llm/modelSelector.js";
import type { DraftController } from "../bot/draftMessage.js";

/**
 * Callback to send intermediate progress updates to the user.
 */
/** Fire-and-forget background memory extraction — adds no latency */
function backgroundExtract(chatId: number, userMessage: string, assistantResponse: string): void {
  // Only extract for real user chats, not agents/scheduler/dashboard
  if (chatId <= 1000) return;
  extractAndStoreMemories(chatId, `User: ${userMessage}\nAssistant: ${assistantResponse}`)
    .then(count => { if (count > 0) log.debug(`[memory] Extracted ${count} new memories`); })
    .catch(err => log.debug(`[memory] Extraction failed: ${err instanceof Error ? err.message : String(err)}`));
}

export let progressCallback: ((chatId: number, message: string) => Promise<void>) | null = null;

export function setProgressCallback(cb: (chatId: number, message: string) => Promise<void>) {
  progressCallback = cb;
}

/** Safe progress update — never throws (prevents Telegram API errors from crashing router) */
async function safeProgress(chatId: number, message: string): Promise<void> {
  if (!progressCallback || chatId <= 1000) return;
  try {
    await progressCallback(chatId, message);
  } catch (err) {
    log.warn(`[router] progressCallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check if Gemini should be used for this request */
function shouldUseGemini(chatId: number): boolean {
  // Must be enabled and have API key
  if (!config.geminiOrchestratorEnabled || !config.geminiApiKey) return false;
  // Agents (chatId 100-103) always use Claude CLI to preserve Gemini rate limit for user
  if (chatId >= 100 && chatId <= 103) return false;
  return true;
}

/**
 * Handle a user message end-to-end:
 * 1. Try Gemini (if enabled) — handles tool chain internally
 * 2. On Gemini failure, fall back to Claude CLI with manual tool chain
 * 3. Store turns and return the final text
 */
export async function handleMessage(
  chatId: number,
  userMessage: string,
  userId: number,
  contextHint: "user" | "scheduler" = "user"
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  // Auto-compact if context is bloated (prevents session timeouts)
  const currentTurns = getTurns(chatId);
  if (currentTurns.length > 20) {
    log.info(`[router] Auto-compacting: ${currentTurns.length} turns exceed threshold (20)`);
    await autoCompact(chatId, userId).catch(err =>
      log.warn(`[router] Auto-compact failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  // Store user turn
  addTurn(chatId, { role: "user", content: userMessage });

  // --- Gemini path (primary) ---
  if (shouldUseGemini(chatId)) {
    try {
      log.info(`[router] Gemini: sending message (chatId=${chatId}, admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);
      const geminiResult = await runGemini({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      addTurn(chatId, { role: "assistant", content: geminiResult });
      backgroundExtract(chatId, userMessage, geminiResult);
      log.info(`[router] Gemini success (${geminiResult.length} chars)`);
      return geminiResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[router] Gemini failed, falling back to Claude CLI: ${errMsg}`);
      logError(err instanceof Error ? err : errMsg, "router:gemini_fallback");
    }
  }

  // --- Claude CLI path (fallback or agents) ---
  // Select model tier based on message content
  const tier = selectModel(userMessage, contextHint);
  const model = getModelId(tier);

  // First pass: Claude
  log.info(`[router] ${modelLabel(tier)} Sending to Claude (admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);
  let result = await runClaude(chatId, userMessage, userIsAdmin, model);
  log.info(`[router] Claude responded with type: ${result.type}`);

  if (result.type === "message") {
    const isEmpty = !result.text || !result.text.trim() || result.text.includes("(Claude returned an empty response)");
    if (isEmpty) {
      // Auto-recovery: clear corrupt session and retry with fresh context
      log.warn(`[router] Empty CLI response — clearing session ${chatId} and retrying`);
      clearSession(chatId);
      result = await runClaude(chatId, userMessage, userIsAdmin, model);
      log.info(`[router] Retry responded with type: ${result.type}`);
      if (result.type === "message") {
        const text = result.text && result.text.trim()
          ? result.text
          : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
        addTurn(chatId, { role: "assistant", content: text });
        backgroundExtract(chatId, userMessage, text);
        return text;
      }
      // Retry returned a tool_call — continue to tool chain below
    } else {
      addTurn(chatId, { role: "assistant", content: result.text });
      backgroundExtract(chatId, userMessage, result.text);
      return result.text;
    }
  }

  // Tool chaining loop — use sonnet for follow-ups (better reasoning, $0 on Max plan)
  const followUpModel = getModelId("sonnet");
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

    // Agent chatId fix: agents use fake chatIds (100-103) for session isolation.
    // When they call telegram.send/voice, replace with the real admin chatId.
    if (chatId >= 100 && chatId <= 103 && tool.startsWith("telegram.") && config.adminChatId > 0) {
      safeArgs.chatId = String(config.adminChatId);
      log.debug(`[router] Agent ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${tool}`);
    }

    // Hard block: agents (chatId 100-103) cannot use browser.* tools — they open visible windows
    if (chatId >= 100 && chatId <= 103 && tool.startsWith("browser.")) {
      const msg = `Tool "${tool}" is blocked for agents — use web.search instead.`;
      log.warn(`[router] Agent chatId=${chatId} tried to call ${tool} — blocked`);
      const followUp = `[Tool "${tool}" error]:\n${msg}`;
      addTurn(chatId, { role: "assistant", content: `[blocked ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    // Security: check allowlist + admin — hard block, no retry
    if (!isToolPermitted(tool, userId)) {
      const msg = tool
        ? `Tool "${tool}" is not permitted${getSkill(tool)?.adminOnly ? " (admin only)" : ""}.`
        : "Tool not permitted.";
      await safeProgress(chatId, `❌ ${msg}`);
      addTurn(chatId, { role: "assistant", content: msg });
      return msg;
    }

    // Look up skill — feed error back to Claude so it can retry
    const skill = getSkill(tool);
    if (!skill) {
      const errorMsg = `Error: Unknown tool "${tool}". Check the tool catalog and try again.`;
      log.warn(`[router] ${errorMsg}`);
      logError(errorMsg, "router:unknown_tool", tool);
      await safeProgress(chatId, `❌ Unknown tool: ${tool}`);
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
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
      logError(errorMsg, "router:validation", tool);
      await safeProgress(chatId, `❌ Arg error on ${tool}`);
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
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
      logError(err instanceof Error ? err : errorMsg, `router:exec:${tool}`, tool);
      await safeProgress(chatId, `❌ ${tool} failed`);
      const followUp = `[Tool "${tool}" error]:\n${errorMsg}`;
      addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
      if (result.type === "message") {
        addTurn(chatId, { role: "assistant", content: result.text });
        return result.text;
      }
      continue;
    }

    log.debug(`Tool result (${tool}):`, toolResult.slice(0, 200));

    // Heartbeat: send intermediate progress to Telegram (skip dashboard/agent chatIds)
    const preview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
    await safeProgress(chatId, `⚙️ **${tool}**\n\`\`\`\n${preview}\n\`\`\``);

    // Feed tool result back to Claude for next step or final answer
    const followUp = `[Tool "${tool}" returned]:\n${toolResult}`;
    addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
    addTurn(chatId, { role: "user", content: followUp });

    log.info(`[router] Feeding tool result back to Claude (step ${step + 1}, ${modelLabel("sonnet")})...`);
    result = await runClaude(chatId, followUp, userIsAdmin, followUpModel);
    log.info(`[router] Claude follow-up response type: ${result.type}`);

    // If Claude responds with a message, we're done
    if (result.type === "message") {
      addTurn(chatId, { role: "assistant", content: result.text });
      backgroundExtract(chatId, userMessage, result.text);
      return result.text;
    }

    // Otherwise loop continues with next tool call
    log.info(`[router] Continuing chain — next tool: ${result.type === "tool_call" ? result.tool : "unknown"}`);
  }

  // If we exhausted the chain limit and still got a tool_call
  if (result.type === "tool_call") {
    const msg = `Reached tool chain limit (${config.maxToolChain} steps). Last pending tool: ${result.tool}.`;
    logError(msg, "router:chain_limit");
    await safeProgress(chatId, `⚠️ Chain limit reached (${config.maxToolChain} steps)`);
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
 * Tries Gemini first (batch mode — no streaming with function calling),
 * then falls back to Claude CLI streaming on failure.
 */
export async function handleMessageStreaming(
  chatId: number,
  userMessage: string,
  userId: number,
  draft: DraftController
): Promise<string> {
  const userIsAdmin = isAdmin(userId);

  // Auto-compact if context is bloated
  const streamTurns = getTurns(chatId);
  if (streamTurns.length > 20) {
    log.info(`[router-stream] Auto-compacting: ${streamTurns.length} turns exceed threshold (20)`);
    await autoCompact(chatId, userId).catch(err =>
      log.warn(`[router-stream] Auto-compact failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  }

  addTurn(chatId, { role: "user", content: userMessage });

  // --- Gemini path (batch mode — Gemini doesn't support streaming + function calling) ---
  if (shouldUseGemini(chatId)) {
    try {
      log.info(`[router-stream] Gemini: sending message (chatId=${chatId}): ${userMessage.slice(0, 100)}...`);
      const geminiResult = await runGemini({
        chatId,
        userMessage,
        isAdmin: userIsAdmin,
        userId,
        onToolProgress: async (cid, msg) => safeProgress(cid, msg),
      });
      // Update draft with final text and finalize
      await draft.update(geminiResult);
      await draft.finalize();
      addTurn(chatId, { role: "assistant", content: geminiResult });
      backgroundExtract(chatId, userMessage, geminiResult);
      log.info(`[router-stream] Gemini success (${geminiResult.length} chars)`);
      return geminiResult;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(`[router-stream] Gemini failed, falling back to Claude CLI streaming: ${errMsg}`);
      logError(err instanceof Error ? err : errMsg, "router:gemini_stream_fallback");
      // Cancel any partial draft from Gemini attempt
      await draft.cancel();
    }
  }

  // --- Claude CLI streaming path (fallback or agents) ---
  // Select model tier based on message content
  const tier = selectModel(userMessage, "user");
  const model = getModelId(tier);

  log.info(`[router] ${modelLabel(tier)} Streaming to Claude (admin=${userIsAdmin}): ${userMessage.slice(0, 100)}...`);

  // First pass: try streaming (with safety timeout to prevent hanging)
  let streamResult: StreamResult;
  try {
    const streamPromise = runClaudeStreamAsync(chatId, userMessage, userIsAdmin, draft, model);
    const safetyTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Stream response safety timeout")), config.cliTimeoutMs + 10_000)
    );
    streamResult = await Promise.race([streamPromise, safetyTimeout]);
  } catch (streamErr) {
    // Streaming failed (empty response, timeout, process crash) — fall back to batch mode
    log.warn(`[router-stream] Stream failed: ${streamErr instanceof Error ? streamErr.message : String(streamErr)} — clearing session and falling back to batch`);
    await draft.cancel();
    // Clear potentially corrupt session before retry
    clearSession(chatId);
    const batchResponse = await runClaude(chatId, userMessage, userIsAdmin, model);
    if (batchResponse.type === "message") {
      const text = batchResponse.text && batchResponse.text.trim() ? batchResponse.text : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
      addTurn(chatId, { role: "assistant", content: text });
      backgroundExtract(chatId, userMessage, text);
      return text;
    }
    // If batch also returned a tool call, process it below
    streamResult = {
      text: batchResponse.text || "",
      session_id: batchResponse.session_id,
      is_tool_call: batchResponse.type === "tool_call",
      tool: batchResponse.tool,
      args: batchResponse.args,
    };
  }
  log.info(`[router-stream] Stream completed: is_tool_call=${streamResult.is_tool_call}, text=${streamResult.text.length} chars, tool=${streamResult.tool || "none"}`);

  // If it's a plain text response, we're done (draft already has the content)
  if (!streamResult.is_tool_call) {
    // Guard against empty responses sneaking through
    if (!streamResult.text || !streamResult.text.trim()) {
      // Auto-recovery: clear session and retry once
      log.warn(`[router-stream] Empty stream response — clearing session and retrying`);
      await draft.cancel();
      clearSession(chatId);
      const retryResult = await runClaude(chatId, userMessage, userIsAdmin, model);
      const retryText = retryResult.type === "message" && retryResult.text?.trim()
        ? retryResult.text
        : "Désolé, je n'ai pas pu générer de réponse. Réessaie.";
      addTurn(chatId, { role: "assistant", content: retryText });
      backgroundExtract(chatId, userMessage, retryText);
      return retryText;
    }
    addTurn(chatId, { role: "assistant", content: streamResult.text });
    await draft.finalize();
    backgroundExtract(chatId, userMessage, streamResult.text);
    log.info(`[router-stream] Returning plain text (${streamResult.text.length} chars)`);
    return streamResult.text;
  }

  // It's a tool call — cancel the draft and process the tool chain in batch mode
  log.info(`[router-stream] Tool call detected: ${streamResult.tool} — switching to batch mode`);
  await draft.cancel();

  let result = {
    type: streamResult.is_tool_call ? "tool_call" as const : "message" as const,
    text: streamResult.text,
    tool: streamResult.tool || "",
    args: streamResult.args || {},
    session_id: streamResult.session_id,
  };

  // Tool chaining loop (batch mode, sonnet for better reasoning)
  const streamFollowUpModel = getModelId("sonnet");
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

    // Agent chatId fix: rewrite fake agent chatIds to real admin chatId for telegram.*
    if (chatId >= 100 && chatId <= 103 && tool.startsWith("telegram.") && config.adminChatId) {
      safeArgs.chatId = String(config.adminChatId);
      log.debug(`[router-stream] Agent ${chatId}: rewrote chatId to admin ${config.adminChatId} for ${tool}`);
    }

    // Hard block: agents (chatId 100-103) cannot use browser.* tools
    if (chatId >= 100 && chatId <= 103 && tool.startsWith("browser.")) {
      const msg = `Tool "${tool}" is blocked for agents — use web.search instead.`;
      log.warn(`[router] Agent chatId=${chatId} tried to call ${tool} — blocked`);
      const followUp = `[Tool "${tool}" error]:\n${msg}`;
      addTurn(chatId, { role: "assistant", content: `[blocked ${tool}]` });
      addTurn(chatId, { role: "user", content: followUp });
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
      if (batchResult.type === "message") {
        addTurn(chatId, { role: "assistant", content: batchResult.text });
        return batchResult.text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
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
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
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
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
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
      const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
      if (batchResult.type === "message") {
        addTurn(chatId, { role: "assistant", content: batchResult.text });
        return batchResult.text;
      }
      result = batchResultToRouterResult(batchResult);
      continue;
    }

    const sPreview = toolResult.length > 200 ? toolResult.slice(0, 200) + "..." : toolResult;
    await safeProgress(chatId, `⚙️ **${tool}**\n\`\`\`\n${sPreview}\n\`\`\``);

    const followUp = `[Tool "${tool}" returned]:\n${toolResult}`;
    addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
    addTurn(chatId, { role: "user", content: followUp });

    // For the final step (or if this is the last tool), try streaming the response
    const batchResult = await runClaude(chatId, followUp, userIsAdmin, streamFollowUpModel);
    if (batchResult.type === "message") {
      addTurn(chatId, { role: "assistant", content: batchResult.text });
      backgroundExtract(chatId, userMessage, batchResult.text);
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
  draft: DraftController,
  modelOverride?: string
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    let draftSuppressed = false;
    runClaudeStream(chatId, userMessage, isAdminUser, {
      onDelta(text: string) {
        if (draftSuppressed) return;
        // Detect tool_call JSON appearing anywhere in the stream
        // If found, cancel the draft immediately — this is thinking text, not a real response
        if (text.includes('{"type":"tool_call"')) {
          draftSuppressed = true;
          draft.cancel().catch(() => {});
          return;
        }
        draft.update(text).catch(() => {});
      },
      onComplete(result: StreamResult) {
        resolve(result);
      },
      onError(error: Error) {
        reject(error);
      },
    }, modelOverride);
  });
}

/** Convert a batch ParsedResult to the router's internal format. */
function batchResultToRouterResult(r: { type: string; text?: string; tool?: string; args?: Record<string, unknown> }) {
  if (r.type === "tool_call") {
    return { type: "tool_call" as const, text: "", tool: r.tool || "", args: r.args || {} };
  }
  return { type: "message" as const, text: (r as any).text || "", tool: "", args: {} };
}
