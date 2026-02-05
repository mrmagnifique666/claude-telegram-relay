/**
 * Built-in skill: shell.exec
 * Run shell commands (admin only). Blocked patterns prevent dangerous operations.
 */
import { spawn } from "node:child_process";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";

const BLOCKED_PATTERNS = [
  /rm\s+(-[a-z]*)?r.*\//i, // rm -rf /
  /mkfs/i,
  /dd\s+.*of=\/dev/i,
  /format\s+[a-z]:/i, // Windows format
  /shutdown/i,
  /reboot/i,
  /init\s+0/i,
  /:(){ :\|:& };:/,  // fork bomb
];

registerSkill({
  name: "shell.exec",
  description: "Execute a shell command and return its output (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
    },
    required: ["command"],
  },
  async execute(args): Promise<string> {
    const command = args.command as string;

    // Check blocked patterns
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return `Error: command blocked by safety filter (matched: ${pattern.source}).`;
      }
    }

    return new Promise<string>((resolve) => {
      const isWindows = process.platform === "win32";
      const shell = isWindows ? "cmd.exe" : "/bin/sh";
      const shellArg = isWindows ? "/c" : "-c";

      const proc = spawn(shell, [shellArg, command], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: config.shellTimeout,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });

      proc.on("close", (code) => {
        const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
        const truncated =
          output.length > 8000 ? output.slice(0, 8000) + "\n...(truncated)" : output;
        const exitLine = code !== 0 ? `\n[exit code: ${code}]` : "";
        resolve(truncated + exitLine || "(no output)");
      });
    });
  },
});
