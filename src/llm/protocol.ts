/**
 * JSON protocol parser for Claude CLI output.
 *
 * Expected shapes:
 *   { "type": "message", "text": "..." }
 *   { "type": "tool_call", "tool": "notes.add", "args": {...} }
 *
 * Claude CLI with --output-format json returns an array of content blocks:
 *   { "type": "result", "result": "...", "session_id": "..." }
 *
 * The `result` field may contain a stringified JSON tool_call or message,
 * so we must try to JSON-parse it before treating it as plain text.
 */

export interface MessageResult {
  type: "message";
  text: string;
  session_id?: string;
}

export interface ToolCallResult {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
  session_id?: string;
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
  // The CLI outputs: { type: "result", result: "the text", session_id: "..." }
  if (isObject(parsed) && parsed.type === "result" && typeof parsed.result === "string") {
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;

    // Try JSON-parsing the result string — it may contain a tool_call or message
    try {
      const inner = JSON.parse(parsed.result);
      if (isObject(inner)) {
        if (
          inner.type === "tool_call" &&
          typeof inner.tool === "string" &&
          isObject(inner.args)
        ) {
          return {
            type: "tool_call",
            tool: inner.tool,
            args: inner.args as Record<string, unknown>,
            session_id: sessionId,
          };
        }
        if (inner.type === "message" && typeof inner.text === "string") {
          return { type: "message", text: inner.text, session_id: sessionId };
        }
      }
    } catch {
      // Not valid JSON inside result — treat as plain text
    }

    return { type: "message", text: parsed.result, session_id: sessionId };
  }

  // Handle arrays (CLI may return an array of content blocks)
  if (Array.isArray(parsed)) {
    let sessionId: string | undefined;
    // Look for result block
    for (const block of parsed) {
      if (isObject(block) && block.type === "result" && typeof block.result === "string") {
        if (typeof block.session_id === "string") sessionId = block.session_id;

        // Try JSON-parsing the result string
        try {
          const inner = JSON.parse(block.result);
          if (isObject(inner)) {
            if (
              inner.type === "tool_call" &&
              typeof inner.tool === "string" &&
              isObject(inner.args)
            ) {
              return {
                type: "tool_call",
                tool: inner.tool,
                args: inner.args as Record<string, unknown>,
                session_id: sessionId,
              };
            }
            if (inner.type === "message" && typeof inner.text === "string") {
              return { type: "message", text: inner.text, session_id: sessionId };
            }
          }
        } catch {
          // Not JSON inside — treat as plain text
        }

        return { type: "message", text: block.result, session_id: sessionId };
      }
    }
    // Collect text blocks
    const texts = parsed
      .filter((b: unknown) => isObject(b) && b.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text);
    if (texts.length > 0) {
      return { type: "message", text: texts.join("\n"), session_id: sessionId };
    }
  }

  // Handle our ideal protocol format
  if (isObject(parsed)) {
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
    if (parsed.type === "message" && typeof parsed.text === "string") {
      return { type: "message", text: parsed.text, session_id: sessionId };
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
        session_id: sessionId,
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
