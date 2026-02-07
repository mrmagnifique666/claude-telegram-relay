/**
 * Built-in skills: FTP operations (admin only).
 * ftp.connect — test connection
 * ftp.list — list remote directory
 * ftp.upload — upload a file
 * ftp.upload_dir — upload entire directory
 * ftp.download — download a file
 * ftp.delete — delete a remote file
 * ftp.mkdir — create remote directory
 *
 * Uses basic-ftp. Config via env: FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_PORT, FTP_SECURE.
 */
import * as ftp from "basic-ftp";
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { log } from "../../utils/log.js";

interface FtpConfig {
  host: string;
  user: string;
  password: string;
  port: number;
  secure: boolean;
}

function getFtpConfig(args: Record<string, unknown>): FtpConfig {
  return {
    host: (args.host as string) || process.env.FTP_HOST || "",
    user: (args.user as string) || process.env.FTP_USER || "",
    password: (args.password as string) || process.env.FTP_PASSWORD || "",
    port: Number(args.port) || Number(process.env.FTP_PORT) || 21,
    secure: (args.secure === "yes") || process.env.FTP_SECURE === "true",
  };
}

function validateConfig(cfg: FtpConfig): string | null {
  if (!cfg.host) return "Error: FTP host required. Set FTP_HOST in .env or pass host arg.";
  if (!cfg.user) return "Error: FTP user required. Set FTP_USER in .env or pass user arg.";
  if (!cfg.password) return "Error: FTP password required. Set FTP_PASSWORD in .env or pass password arg.";
  return null;
}

async function withClient<T>(
  cfg: FtpConfig,
  fn: (client: ftp.Client) => Promise<T>
): Promise<T> {
  const client = new ftp.Client();
  client.ftp.verbose = false;
  try {
    await client.access({
      host: cfg.host,
      user: cfg.user,
      password: cfg.password,
      port: cfg.port,
      secure: cfg.secure,
      secureOptions: cfg.secure ? { rejectUnauthorized: false } : undefined,
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

// ── ftp.connect ──

registerSkill({
  name: "ftp.connect",
  description: "Test FTP connection. Uses env vars FTP_HOST/USER/PASSWORD or pass as args.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      host: { type: "string", description: "FTP hostname (or set FTP_HOST in .env)" },
      user: { type: "string", description: "FTP username (or set FTP_USER in .env)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD in .env)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no (default: no)" },
    },
  },
  async execute(args): Promise<string> {
    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;

    try {
      const info = await withClient(cfg, async (client) => {
        const pwd = await client.pwd();
        const list = await client.list();
        return { pwd, count: list.length };
      });
      log.info(`[ftp.connect] Connected to ${cfg.host}`);
      return `Connected to ${cfg.host}:${cfg.port}\nRoot: ${info.pwd}\nFiles/dirs in root: ${info.count}`;
    } catch (e) {
      return `Connection failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── ftp.list ──

registerSkill({
  name: "ftp.list",
  description: "List files in a remote FTP directory.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Remote directory path (default: /)" },
      host: { type: "string", description: "FTP hostname (or set FTP_HOST)" },
      user: { type: "string", description: "FTP username (or set FTP_USER)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no" },
    },
  },
  async execute(args): Promise<string> {
    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;
    const dir = (args.dir as string) || "/";

    try {
      const list = await withClient(cfg, (client) => client.list(dir));

      if (list.length === 0) return `${dir}: (empty)`;

      const lines = list.map((f) => {
        const type = f.isDirectory ? "[dir]" : "     ";
        const size = f.isDirectory
          ? ""
          : f.size < 1024
            ? `${f.size}B`
            : f.size < 1048576
              ? `${(f.size / 1024).toFixed(1)}KB`
              : `${(f.size / 1048576).toFixed(1)}MB`;
        const date = f.rawModifiedAt || "";
        return `${type} ${f.name}  ${size}  ${date}`;
      });

      return `${dir} (${list.length} entries):\n${lines.join("\n")}`;
    } catch (e) {
      return `Error listing ${dir}: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── ftp.upload ──

registerSkill({
  name: "ftp.upload",
  description: "Upload a local file to the FTP server.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      localPath: { type: "string", description: "Local file path (absolute)" },
      remotePath: { type: "string", description: "Remote destination path (e.g. /public_html/index.html)" },
      host: { type: "string", description: "FTP hostname (or set FTP_HOST)" },
      user: { type: "string", description: "FTP username (or set FTP_USER)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no" },
    },
    required: ["localPath", "remotePath"],
  },
  async execute(args): Promise<string> {
    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;

    const localPath = path.resolve(args.localPath as string);
    const remotePath = args.remotePath as string;

    if (!fs.existsSync(localPath)) return `Error: local file not found: ${localPath}`;
    if (fs.statSync(localPath).isDirectory()) return "Error: use ftp.upload_dir for directories.";

    try {
      await withClient(cfg, async (client) => {
        // Ensure remote directory exists
        const remoteDir = path.posix.dirname(remotePath);
        await client.ensureDir(remoteDir);
        await client.uploadFrom(localPath, remotePath);
      });

      const size = fs.statSync(localPath).size;
      log.info(`[ftp.upload] ${localPath} → ${remotePath} (${size} bytes)`);
      return `Uploaded: ${localPath} → ${remotePath} (${size} bytes)`;
    } catch (e) {
      return `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── ftp.upload_dir ──

registerSkill({
  name: "ftp.upload_dir",
  description:
    "Upload an entire local directory to the FTP server (recursive). Great for deploying a website.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      localDir: { type: "string", description: "Local directory path (absolute)" },
      remoteDir: { type: "string", description: "Remote destination dir (e.g. /public_html/)" },
      host: { type: "string", description: "FTP hostname (or set FTP_HOST)" },
      user: { type: "string", description: "FTP username (or set FTP_USER)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no" },
    },
    required: ["localDir", "remoteDir"],
  },
  async execute(args): Promise<string> {
    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;

    const localDir = path.resolve(args.localDir as string);
    const remoteDir = args.remoteDir as string;

    if (!fs.existsSync(localDir)) return `Error: local directory not found: ${localDir}`;
    if (!fs.statSync(localDir).isDirectory()) return "Error: path is not a directory.";

    try {
      let fileCount = 0;

      await withClient(cfg, async (client) => {
        await client.ensureDir(remoteDir);
        await client.cd(remoteDir);
        await client.uploadFromDir(localDir);

        // Count files uploaded
        const countFiles = (dir: string): number => {
          let count = 0;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
            else count++;
          }
          return count;
        };
        fileCount = countFiles(localDir);
      });

      log.info(`[ftp.upload_dir] ${localDir} → ${remoteDir} (${fileCount} files)`);
      return `Uploaded directory: ${localDir} → ${remoteDir} (${fileCount} files)`;
    } catch (e) {
      return `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── ftp.download ──

registerSkill({
  name: "ftp.download",
  description: "Download a file from the FTP server to local disk.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      remotePath: { type: "string", description: "Remote file path to download" },
      localPath: { type: "string", description: "Local destination path (absolute)" },
      host: { type: "string", description: "FTP hostname (or set FTP_HOST)" },
      user: { type: "string", description: "FTP username (or set FTP_USER)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no" },
    },
    required: ["remotePath", "localPath"],
  },
  async execute(args): Promise<string> {
    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;

    const remotePath = args.remotePath as string;
    const localPath = path.resolve(args.localPath as string);

    // Ensure local directory exists
    const localDir = path.dirname(localPath);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    try {
      await withClient(cfg, (client) => client.downloadTo(localPath, remotePath));
      const size = fs.statSync(localPath).size;
      log.info(`[ftp.download] ${remotePath} → ${localPath} (${size} bytes)`);
      return `Downloaded: ${remotePath} → ${localPath} (${size} bytes)`;
    } catch (e) {
      return `Download failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── ftp.delete ──

registerSkill({
  name: "ftp.delete",
  description: "Delete a file on the FTP server.",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      remotePath: { type: "string", description: "Remote file path to delete" },
      confirm: { type: "string", description: "Must be 'yes' to confirm deletion" },
      host: { type: "string", description: "FTP hostname (or set FTP_HOST)" },
      user: { type: "string", description: "FTP username (or set FTP_USER)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no" },
    },
    required: ["remotePath", "confirm"],
  },
  async execute(args): Promise<string> {
    if (args.confirm !== "yes") {
      return "Error: set confirm='yes' to confirm deletion.";
    }

    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;
    const remotePath = args.remotePath as string;

    try {
      await withClient(cfg, (client) => client.remove(remotePath));
      log.info(`[ftp.delete] Deleted: ${remotePath}`);
      return `Deleted: ${remotePath}`;
    } catch (e) {
      return `Delete failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ── ftp.mkdir ──

registerSkill({
  name: "ftp.mkdir",
  description: "Create a directory on the FTP server (recursive).",
  adminOnly: true,
  argsSchema: {
    type: "object",
    properties: {
      remotePath: { type: "string", description: "Remote directory path to create" },
      host: { type: "string", description: "FTP hostname (or set FTP_HOST)" },
      user: { type: "string", description: "FTP username (or set FTP_USER)" },
      password: { type: "string", description: "FTP password (or set FTP_PASSWORD)" },
      port: { type: "number", description: "Port (default 21)" },
      secure: { type: "string", description: "Use FTPS: yes/no" },
    },
    required: ["remotePath"],
  },
  async execute(args): Promise<string> {
    const cfg = getFtpConfig(args);
    const err = validateConfig(cfg);
    if (err) return err;
    const remotePath = args.remotePath as string;

    try {
      await withClient(cfg, (client) => client.ensureDir(remotePath));
      log.info(`[ftp.mkdir] Created: ${remotePath}`);
      return `Directory created: ${remotePath}`;
    } catch (e) {
      return `Mkdir failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

log.debug("Registered 7 ftp.* skills");
