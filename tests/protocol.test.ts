/**
 * Tests for the JSON protocol parser and tool allowlist.
 */
import { describe, it, expect } from "vitest";
import { parseClaudeOutput } from "../src/llm/protocol.js";
import { isToolAllowed } from "../src/security/policy.js";

describe("parseClaudeOutput", () => {
  it("parses a valid message result", () => {
    const raw = JSON.stringify({ type: "result", result: "Hello world" });
    const result = parseClaudeOutput(raw);
    expect(result).toEqual({ type: "message", text: "Hello world" });
  });

  it("parses the ideal protocol message format", () => {
    const raw = JSON.stringify({ type: "message", text: "Hi there" });
    const result = parseClaudeOutput(raw);
    expect(result).toEqual({ type: "message", text: "Hi there" });
  });

  it("parses a tool_call result", () => {
    const raw = JSON.stringify({
      type: "tool_call",
      tool: "notes.add",
      args: { text: "buy milk" },
    });
    const result = parseClaudeOutput(raw);
    expect(result).toEqual({
      type: "tool_call",
      tool: "notes.add",
      args: { text: "buy milk" },
    });
  });

  it("handles invalid JSON gracefully — returns plain text", () => {
    const raw = "This is not JSON at all";
    const result = parseClaudeOutput(raw);
    expect(result.type).toBe("message");
    expect(result).toHaveProperty("text");
    expect((result as { text: string }).text).toBe("This is not JSON at all");
  });

  it("handles empty string", () => {
    const result = parseClaudeOutput("");
    expect(result.type).toBe("message");
    expect((result as { text: string }).text).toBe("(empty response)");
  });

  it("handles CLI array output with result block", () => {
    const raw = JSON.stringify([
      { type: "text", text: "thinking..." },
      { type: "result", result: "Final answer" },
    ]);
    const result = parseClaudeOutput(raw);
    expect(result).toEqual({ type: "message", text: "Final answer" });
  });

  it("strips ANSI escape codes from plain text fallback", () => {
    const raw = "\x1b[31mRed text\x1b[0m";
    const result = parseClaudeOutput(raw);
    expect(result).toEqual({ type: "message", text: "Red text" });
  });
});

describe("isToolAllowed", () => {
  // Allowlist from env: "help,notes.*,files.*,web.fetch,system.*,shell.exec"

  it("allows an exact match", () => {
    expect(isToolAllowed("help")).toBe(true);
  });

  it("allows a wildcard match", () => {
    expect(isToolAllowed("notes.add")).toBe(true);
    expect(isToolAllowed("notes.list")).toBe(true);
    expect(isToolAllowed("files.read")).toBe(true);
    expect(isToolAllowed("system.info")).toBe(true);
    expect(isToolAllowed("system.kill")).toBe(true);
  });

  it("allows exact match for new tools", () => {
    expect(isToolAllowed("shell.exec")).toBe(true);
    expect(isToolAllowed("web.fetch")).toBe(true);
  });

  it("rejects an unknown tool", () => {
    expect(isToolAllowed("danger.exec")).toBe(false);
  });

  it("rejects a tool that partially matches but is not in allowlist", () => {
    expect(isToolAllowed("helpx")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isToolAllowed("")).toBe(false);
  });
});
