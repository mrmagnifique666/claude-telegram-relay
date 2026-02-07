/**
 * MISS/FIX Auto-Graduation.
 *
 * Tracks repeated error patterns. When an error pattern occurs 5+ times,
 * it auto-promotes to a permanent learned rule injected into the system prompt.
 * This turns systematic mistakes into systematic fixes.
 *
 * Storage: relay/self-review.json (error patterns)
 *          relay/learned-rules.md  (graduated rules)
 */
import fs from "node:fs";
import path from "node:path";
import { log } from "../utils/log.js";

const RELAY_DIR = path.resolve(process.cwd(), "relay");
const PATTERNS_FILE = path.join(RELAY_DIR, "self-review.json");
const RULES_FILE = path.join(RELAY_DIR, "learned-rules.md");
const GRADUATION_THRESHOLD = 5;

interface ErrorPattern {
  /** Normalized key for grouping (e.g. "router:unknown_tool:telegram.notify") */
  key: string;
  /** Human-readable description */
  description: string;
  /** Number of occurrences */
  count: number;
  /** First seen timestamp */
  firstSeen: string;
  /** Last seen timestamp */
  lastSeen: string;
  /** Whether this pattern has been graduated to a rule */
  graduated: boolean;
  /** The fix/rule that was generated */
  rule?: string;
}

function ensureDir(): void {
  if (!fs.existsSync(RELAY_DIR)) fs.mkdirSync(RELAY_DIR, { recursive: true });
}

function loadPatterns(): ErrorPattern[] {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return [];
    return JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function savePatterns(patterns: ErrorPattern[]): void {
  ensureDir();
  fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
}

/**
 * Normalize an error into a grouping key.
 * Groups by context + first significant word of the message.
 */
function normalizeKey(context: string, message: string): string {
  // Extract the most significant part of the error message
  const significant = message
    .replace(/["'`]/g, "")
    .replace(/\d+/g, "N") // normalize numbers
    .split(/[:\-\n]/)[0]
    .trim()
    .slice(0, 60);
  return `${context}:${significant}`.toLowerCase();
}

/**
 * Derive a fix rule from an error pattern.
 */
function deriveRule(pattern: ErrorPattern): string {
  const { key, description, count } = pattern;

  // Common patterns and their fixes
  if (key.includes("unknown_tool")) {
    const toolName = description.match(/Unknown tool "([^"]+)"/)?.[1];
    return `RULE: The tool "${toolName || "?"}" does not exist. Use the tool catalog to find the correct tool name.`;
  }
  if (key.includes("validation")) {
    return `RULE: ${description.split(".")[0]}. Always check required arguments before calling tools.`;
  }
  if (key.includes("parse entities")) {
    return `RULE: Telegram messages with special characters (*, _, [, ]) may fail Markdown parsing. Avoid raw Markdown in dynamic content like email subjects.`;
  }
  if (key.includes("timeout")) {
    return `RULE: Long-running operations may timeout. Break large tasks into smaller steps.`;
  }
  if (key.includes("not permitted")) {
    return `RULE: ${description.split(".")[0]}. Check permissions before attempting restricted tools.`;
  }

  // Generic rule
  return `RULE (auto-learned from ${count} occurrences): Avoid pattern "${description.slice(0, 100)}". This error has occurred ${count} times.`;
}

/**
 * Record an error occurrence and check for graduation.
 * Called from the error logging pipeline.
 */
export function recordErrorPattern(context: string, message: string): void {
  const key = normalizeKey(context, message);
  const patterns = loadPatterns();
  const now = new Date().toISOString();

  let pattern = patterns.find((p) => p.key === key);
  if (pattern) {
    pattern.count++;
    pattern.lastSeen = now;
    pattern.description = message.slice(0, 200); // update with latest
  } else {
    pattern = {
      key,
      description: message.slice(0, 200),
      count: 1,
      firstSeen: now,
      lastSeen: now,
      graduated: false,
    };
    patterns.push(pattern);
  }

  // Check for graduation
  if (pattern.count >= GRADUATION_THRESHOLD && !pattern.graduated) {
    const rule = deriveRule(pattern);
    pattern.graduated = true;
    pattern.rule = rule;
    appendRule(rule, pattern);
    log.info(`[self-review] Auto-graduated pattern "${key}" (${pattern.count} occurrences) → rule`);
  }

  savePatterns(patterns);
}

/**
 * Append a graduated rule to the learned-rules file.
 */
function appendRule(rule: string, pattern: ErrorPattern): void {
  ensureDir();
  const entry = `\n- ${rule} _(graduated ${new Date().toISOString().split("T")[0]}, ${pattern.count} occurrences)_\n`;

  let content = "";
  if (fs.existsSync(RULES_FILE)) {
    content = fs.readFileSync(RULES_FILE, "utf-8");
  } else {
    content = "# Learned Rules\n\n> Auto-graduated from repeated error patterns (MISS/FIX system).\n> These rules are injected into the system prompt.\n";
  }

  content += entry;
  fs.writeFileSync(RULES_FILE, content);
}

/**
 * Get all learned rules as a prompt section.
 * Returns empty string if no rules exist.
 */
export function getLearnedRulesPrompt(): string {
  try {
    if (!fs.existsSync(RULES_FILE)) return "";
    const content = fs.readFileSync(RULES_FILE, "utf-8");
    const rules = content
      .split("\n")
      .filter((line) => line.startsWith("- RULE"))
      .map((line) => line.replace(/\s*_\(graduated.*\)_/, "").trim());
    if (rules.length === 0) return "";
    return `## Learned Rules (auto-graduated)\n${rules.join("\n")}`;
  } catch {
    return "";
  }
}

/**
 * Get a summary of tracked error patterns for the errors skill.
 */
export function getPatternSummary(): string {
  const patterns = loadPatterns();
  if (patterns.length === 0) return "No error patterns tracked.";

  const sorted = [...patterns].sort((a, b) => b.count - a.count);
  return sorted
    .slice(0, 20)
    .map((p) => {
      const status = p.graduated ? "GRADUATED" : `${p.count}/${GRADUATION_THRESHOLD}`;
      return `[${status}] ${p.key}\n  ${p.description.slice(0, 120)}\n  First: ${p.firstSeen.split("T")[0]} | Last: ${p.lastSeen.split("T")[0]}`;
    })
    .join("\n\n");
}
