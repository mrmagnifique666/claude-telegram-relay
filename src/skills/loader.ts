/**
 * Skill loader — registers built-in skills and provides a tool catalog for the LLM prompt.
 */
import { log } from "../utils/log.js";

export interface ToolSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
}

export interface Skill {
  /** e.g. "notes.add" */
  name: string;
  /** Short human-readable description for the LLM catalog */
  description: string;
  /** JSON schema for args validation */
  argsSchema: ToolSchema;
  /** If true, only admin users can invoke this skill */
  adminOnly?: boolean;
  /** Execute the skill and return a text result */
  execute(args: Record<string, unknown>): Promise<string>;
}

const registry = new Map<string, Skill>();

export function registerSkill(skill: Skill): void {
  registry.set(skill.name, skill);
  log.debug(`Registered skill: ${skill.name}${skill.adminOnly ? " (admin)" : ""}`);
}

export function getSkill(name: string): Skill | undefined {
  return registry.get(name);
}

export function getAllSkills(): Skill[] {
  return Array.from(registry.values());
}

/**
 * Validate args against a simple JSON schema (top-level properties + required).
 */
export function validateArgs(
  args: Record<string, unknown>,
  schema: ToolSchema
): string | null {
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in args)) {
        return `Missing required argument: ${key}`;
      }
    }
  }
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) continue; // extra keys are ignored
    if (prop.type === "string" && typeof val !== "string") {
      return `Argument "${key}" must be a string`;
    }
    if (prop.type === "number" && typeof val !== "number") {
      return `Argument "${key}" must be a number`;
    }
  }
  return null; // valid
}

/**
 * Generate a text block describing all available tools for the LLM prompt.
 * Filters out admin-only tools when the user is not an admin.
 */
export function getToolCatalogPrompt(isAdmin: boolean = false): string {
  const skills = getAllSkills().filter((s) => !s.adminOnly || isAdmin);
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const params = Object.entries(s.argsSchema.properties)
      .map(([k, v]) => `${k}: ${v.type}${v.description ? ` — ${v.description}` : ""}`)
      .join(", ");
    const tag = s.adminOnly ? " [ADMIN]" : "";
    return `- ${s.name}(${params}): ${s.description}${tag}`;
  });
  return lines.join("\n");
}

/**
 * Load all built-in skills.
 */
export async function loadBuiltinSkills(): Promise<void> {
  // Dynamic imports to keep this file dependency-light
  await import("./builtin/help.js");
  await import("./builtin/notes.js");
  await import("./builtin/files.js");
  await import("./builtin/filewrite.js");
  await import("./builtin/shell.js");
  await import("./builtin/web.js");
  await import("./builtin/system.js");
  await import("./builtin/code.js");
  await import("./builtin/api.js");
  await import("./builtin/db.js");
  await import("./builtin/telegram.js");
  await import("./custom/code-request.js");
  log.info(`Loaded ${registry.size} built-in skills.`);
}
