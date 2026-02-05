/**
 * JSON protocol parser for Claude CLI output.
 *
 * Expected shapes:
 *   { "type": "message", "text": "..." }
 *   { "type": "tool_call", "tool": "notes.add", "args": {...} }
 *
 * Claude CLI with --output-format json returns an array of content blocks:
 *   { "type": "result", "result": "...", ... }
 *
 * We handle both the ideal protocol and the real CLI output format.
 */

export interface MessageResult {
  type: "message";
  text: string;
}

export interface ToolCallResult {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

export type ParsedResult = MessageResult | ToolCallResult;

/**
 * Attempt to parse Claude CLI JSON output into our protocol types.
 * Falls back to plain text extraction on failure.
 */
export function parseClaudeOutput(raw: string): ParsedResult {
  const trimmed = raw.trim();

  // Try parsing as JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not valid JSON — extract as plain text
    return { type: "message", text: extractPlainText(trimmed) };
  }

  // Handle the real Claude CLI --output-format json shape
  // The CLI outputs: { type: "result", result: "the text", ... }
  if (isObject(parsed) && parsed.type === "result" && typeof parsed.result === "string") {
    return { type: "message", text: parsed.result };
  }

  // Handle arrays (CLI may return an array of content blocks)
  if (Array.isArray(parsed)) {
    // Look for result block
    for (const block of parsed) {
      if (isObject(block) && block.type === "result" && typeof block.result === "string") {
        return { type: "message", text: block.result };
      }
    }
    // Collect text blocks
    const texts = parsed
      .filter((b: unknown) => isObject(b) && b.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text);
    if (texts.length > 0) {
      return { type: "message", text: texts.join("\n") };
    }
  }

  // Handle our ideal protocol format
  if (isObject(parsed)) {
    if (parsed.type === "message" && typeof parsed.text === "string") {
      return { type: "message", text: parsed.text };
    }
    if (
      parsed.type === "tool_call" &&
      typeof parsed.tool === "string" &&
      isObject(parsed.args)
    ) {
      return {
        type: "tool_call",
        tool: parsed.tool,
        args: parsed.args as Record<string, unknown>,
      };
    }
  }

  // Fallback: stringify whatever we got
  return { type: "message", text: extractPlainText(trimmed) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractPlainText(raw: string): string {
  // Strip ANSI escape codes if any
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  return clean || "(empty response)";
}
