/**
 * Built-in skill: file write operations.
 * files.write — sandboxed write (any user)
 * files.write_anywhere — unrestricted write (admin only)
 * files.read_anywhere — unrestricted read (admin only)
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { safeSandboxPath } from "../../utils/paths.js";

registerSkill({
  name: "files.write",
  description: "Write content to a file inside the sandbox directory.",
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to sandbox" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args): Promise<string> {
    const filePath = safeSandboxPath(args.path as string);
    if (!filePath) return "Error: path is outside the sandbox.";
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, args.content as string, "utf-8");
    return `Written ${(args.content as string).length} bytes to ${args.path}.`;
  },
});

registerSkill({
  name: "files.write_anywhere",
  description: "Write content to any file on the system (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  async execute(args): Promise<string> {
    const filePath = path.resolve(args.path as string);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, args.content as string, "utf-8");
    return `Written ${(args.content as string).length} bytes to ${filePath}.`;
  },
});

registerSkill({
  name: "files.read_anywhere",
  description: "Read any file on the system (admin only, max 50 KB).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
    },
    required: ["path"],
  },
  async execute(args): Promise<string> {
    const filePath = path.resolve(args.path as string);
    if (!fs.existsSync(filePath)) return "File not found.";
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return "Error: path is a directory, not a file.";
    if (stat.size > 50 * 1024) return "Error: file exceeds 50 KB limit.";
    return fs.readFileSync(filePath, "utf-8");
  },
});
