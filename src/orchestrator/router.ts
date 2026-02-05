/**
 * Orchestrator / tool router.
 * Receives parsed Claude output, validates tool calls, executes skills,
 * optionally feeds tool results back to Claude for a second pass.
 */
import { isToolAllowed } from "../security/policy.js";
import { getSkill, validateArgs } from "../skills/loader.js";
import { runClaude } from "../llm/claudeCli.js";
import { addTurn } from "../storage/store.js";
import { log } from "../utils/log.js";
import type { ParsedResult } from "../llm/protocol.js";

/**
 * Handle a user message end-to-end:
 * 1. Send to Claude
 * 2. If Claude returns a tool call, validate & execute it
 * 3. Optionally send tool result back to Claude for a final answer
 * 4. Store turns and return the final text
 */
export async function handleMessage(
  chatId: number,
  userMessage: string
): Promise<string> {
  // Store user turn
  addTurn(chatId, { role: "user", content: userMessage });

  // First pass: Claude
  const result = await runClaude(chatId, userMessage);

  if (result.type === "message") {
    addTurn(chatId, { role: "assistant", content: result.text });
    return result.text;
  }

  // Handle tool call
  return handleToolCall(chatId, userMessage, result);
}

async function handleToolCall(
  chatId: number,
  _originalMessage: string,
  call: { type: "tool_call"; tool: string; args: Record<string, unknown> }
): Promise<string> {
  const { tool, args } = call;

  // Security: check allowlist
  if (!isToolAllowed(tool)) {
    const msg = `Tool "${tool}" is not allowed.`;
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
  log.info(`Executing tool: ${tool}`);
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

  // Optional second pass: feed tool result back to Claude for a natural-language summary
  const secondPassPrompt = `The tool "${tool}" returned:\n${toolResult}\n\nPlease provide a concise, helpful summary of this result for the user.`;
  addTurn(chatId, { role: "assistant", content: `[called ${tool}]` });
  addTurn(chatId, { role: "user", content: secondPassPrompt });

  const secondResult = await runClaude(chatId, secondPassPrompt);
  const finalText = secondResult.type === "message" ? secondResult.text : toolResult;

  addTurn(chatId, { role: "assistant", content: finalText });
  return finalText;
}
