/**
 * Built-in skill: system info, process management, and open.
 * system.info — system information (any user)
 * system.processes — list running processes (any user)
 * system.kill — kill a process by PID (admin only)
 * system.open — open a file/URL with the default app (admin only)
 */
import os from "node:os";
import { spawn } from "node:child_process";
import { registerSkill } from "../loader.js";

registerSkill({
  name: "system.info",
  description: "Show system information (OS, CPU, memory, uptime).",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);
    const uptimeH = (os.uptime() / 3600).toFixed(1);
    const cpus = os.cpus();
    return [
      `Platform: ${os.platform()} ${os.arch()}`,
      `OS: ${os.type()} ${os.release()}`,
      `Hostname: ${os.hostname()}`,
      `CPU: ${cpus[0]?.model || "unknown"} (${cpus.length} cores)`,
      `Memory: ${freeMem} GB free / ${totalMem} GB total`,
      `Uptime: ${uptimeH} hours`,
      `Node: ${process.version}`,
    ].join("\n");
  },
});

registerSkill({
  name: "system.processes",
  description: "List running processes (top 30 by CPU/memory).",
  argsSchema: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<string> {
    return new Promise<string>((resolve) => {
      const isWindows = process.platform === "win32";
      let cmd: string;
      let args: string[];

      if (isWindows) {
        cmd = "powershell.exe";
        args = [
          "-NoProfile",
          "-Command",
          "Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 Id, ProcessName, @{N='CPU(s)';E={[math]::Round($_.CPU,1)}}, @{N='Mem(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize | Out-String",
        ];
      } else {
        cmd = "/bin/sh";
        args = ["-c", "ps aux --sort=-%cpu | head -31"];
      }

      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });

      let stdout = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });

      proc.on("close", () => {
        resolve(stdout.trim() || "(no output)");
      });
    });
  },
});

registerSkill({
  name: "system.kill",
  description: "Kill a process by PID (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      pid: { type: "number", description: "Process ID to kill" },
    },
    required: ["pid"],
  },
  async execute(args): Promise<string> {
    const pid = args.pid as number;
    try {
      process.kill(pid, "SIGTERM");
      return `Sent SIGTERM to PID ${pid}.`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

registerSkill({
  name: "system.open",
  description: "Open a file or URL with the default application (admin only).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "File path or URL to open" },
    },
    required: ["target"],
  },
  async execute(args): Promise<string> {
    const target = args.target as string;
    return new Promise<string>((resolve) => {
      let cmd: string;
      let cmdArgs: string[];

      switch (process.platform) {
        case "win32":
          cmd = "cmd.exe";
          cmdArgs = ["/c", "start", "", target];
          break;
        case "darwin":
          cmd = "open";
          cmdArgs = [target];
          break;
        default:
          cmd = "xdg-open";
          cmdArgs = [target];
      }

      const proc = spawn(cmd, cmdArgs, {
        stdio: "ignore",
        detached: true,
      });

      proc.on("error", (err) => {
        resolve(`Error: ${err.message}`);
      });

      proc.unref();
      resolve(`Opened: ${target}`);
    });
  },
});
