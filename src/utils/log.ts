/**
 * Simple levelled logger with secret redaction.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let currentLevel: Level = "info";

/** Patterns that should be redacted from log output. */
const redactPatterns: RegExp[] = [];

export function setLogLevel(level: Level) {
  currentLevel = level;
}

export function addRedactPattern(pattern: RegExp) {
  redactPatterns.push(pattern);
}

function redact(msg: string): string {
  let out = msg;
  for (const p of redactPatterns) {
    out = out.replace(p, "***REDACTED***");
  }
  return out;
}

function stamp(): string {
  return new Date().toISOString();
}

function emit(level: Level, ...args: unknown[]) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const parts = args.map((a) =>
    typeof a === "string" ? redact(a) : a
  );
  const prefix = `[${stamp()}] [${level.toUpperCase()}]`;
  switch (level) {
    case "error":
      console.error(prefix, ...parts);
      break;
    case "warn":
      console.warn(prefix, ...parts);
      break;
    default:
      console.log(prefix, ...parts);
  }
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", ...args),
  info: (...args: unknown[]) => emit("info", ...args),
  warn: (...args: unknown[]) => emit("warn", ...args),
  error: (...args: unknown[]) => emit("error", ...args),
};
