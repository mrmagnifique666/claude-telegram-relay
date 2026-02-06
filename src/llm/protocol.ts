/**
 * JSON protocol parser for Claude CLI output.
 *
 * Expected shapes:
 *   { "type": "message", "text": "..." }
 *   { "type": "tool_call", "tool": "notes.add", "args": {...} }
 *
 * Claude CLI with --output-format json returns:
 *   { "type": "result", "result": "...", "session_id": "..." }
 *
 * CRITICAL: The `result` field often contains MIXED content —
 * natural language text WITH an embedded JSON tool_call object.
 * Example: "Let me fetch that for you.\n\n{\"type\":\"tool_call\",...}"
 * A simple JSON.parse() on the whole string will fail.
 * We must SCAN for embedded JSON objects within the text.
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
    // Not valid JSON at top level — maybe plain text with embedded JSON
    const extracted = extractToolCallFromText(trimmed);
    if (extracted) return extracted;
    return { type: "message", text: extractPlainText(trimmed) };
  }

  // Handle the real Claude CLI --output-format json shape
  if (isObject(parsed) && parsed.type === "result" && typeof parsed.result === "string") {
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
    return parseResultString(parsed.result, sessionId);
  }

  // Handle arrays (CLI may return an array of content blocks)
  if (Array.isArray(parsed)) {
    let sessionId: string | undefined;
    for (const block of parsed) {
      if (isObject(block) && block.type === "result" && typeof block.result === "string") {
        if (typeof block.session_id === "string") sessionId = block.session_id;
        return parseResultString(block.result, sessionId);
      }
    }
    // Collect text blocks
    const texts = parsed
      .filter((b: unknown) => isObject(b) && b.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text);
    if (texts.length > 0) {
      // Even in text blocks, check for embedded tool calls
      const combined = texts.join("\n");
      const extracted = extractToolCallFromText(combined);
      if (extracted) {
        extracted.session_id = sessionId;
        return extracted;
      }
      return { type: "message", text: combined, session_id: sessionId };
    }
  }

  // Handle our ideal protocol format (direct tool_call or message)
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

  // Fallback
  return { type: "message", text: extractPlainText(trimmed) };
}

/**
 * Parse a result string which may be:
 * 1. Pure JSON (tool_call or message)
 * 2. Mixed text with embedded JSON tool_call
 * 3. Plain text
 */
function parseResultString(result: string, sessionId?: string): ParsedResult {
  // 1. Try pure JSON parse
  try {
    const inner = JSON.parse(result);
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
    // Not pure JSON — continue to extraction
  }

  // 2. Scan for embedded tool_call JSON in mixed text
  const extracted = extractToolCallFromText(result);
  if (extracted) {
    extracted.session_id = sessionId;
    return extracted;
  }

  // 3. Plain text
  return { type: "message", text: result, session_id: sessionId };
}

/**
 * Scan a text string for an embedded JSON tool_call object.
 * Handles cases like:
 *   "Let me fetch that.\n\n{\"type\":\"tool_call\",\"tool\":\"web.fetch\",\"args\":{\"url\":\"...\"}}"
 *   "Sure! ```json\n{\"type\":\"tool_call\",...}\n```"
 *
 * Uses brace-matching to extract the complete JSON object.
 */
function extractToolCallFromText(text: string): ToolCallResult | null {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "");

  // Look for {"type":"tool_call" pattern
  const marker = /"type"\s*:\s*"tool_call"/;
  const match = marker.exec(stripped);
  if (!match) return null;

  // Walk backwards from the match to find the opening brace
  let start = match.index;
  while (start > 0 && stripped[start] !== "{") start--;
  if (stripped[start] !== "{") return null;

  // Walk forward with brace-matching to find the complete JSON object
  let depth = 0;
  let end = start;
  let inString = false;
  let escape = false;

  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (depth !== 0) return null;

  const jsonStr = stripped.slice(start, end + 1);

  try {
    const obj = JSON.parse(jsonStr);
    if (
      isObject(obj) &&
      obj.type === "tool_call" &&
      typeof obj.tool === "string" &&
      isObject(obj.args)
    ) {
      return {
        type: "tool_call",
        tool: obj.tool,
        args: obj.args as Record<string, unknown>,
      };
    }
  } catch {
    // Couldn't parse the extracted substring
  }

  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractPlainText(raw: string): string {
  // Strip ANSI escape codes if any
  const clean = raw.replace(/\x1b\[[0-9;]*m/g, "");
  return clean || "(empty response)";
}
