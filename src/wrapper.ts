/**
 * Auto-restart wrapper for Kingston.
 * Spawns the bot as a child process and restarts it on exit.
 *
 * Exit codes:
 *   0  = clean shutdown, stop
 *   42 = restart requested (by system.restart skill)
 *   *  = crash, restart after delay
 */
import { spawn } from "node:child_process";
import path from "node:path";

const RESTART_CODE = 42;
const CRASH_DELAY_MS = 3000;
const MAX_RAPID_CRASHES = 5;
const RAPID_CRASH_WINDOW_MS = 30_000;

const entryPoint = path.resolve("src/index.ts");
const crashTimes: number[] = [];

function log(msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [wrapper] ${msg}`);
}

function startBot() {
  log("Starting Kingston...");

  const child = spawn("npx", ["tsx", entryPoint], {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
  });

  child.on("exit", (code) => {
    if (code === 0) {
      log("Kingston stopped cleanly. Not restarting.");
      process.exit(0);
    }

    if (code === RESTART_CODE) {
      log("Restart requested — restarting now...");
      startBot();
      return;
    }

    // Crash — check for rapid crash loop
    const now = Date.now();
    crashTimes.push(now);
    // Keep only recent crashes
    while (crashTimes.length > 0 && crashTimes[0] < now - RAPID_CRASH_WINDOW_MS) {
      crashTimes.shift();
    }

    if (crashTimes.length >= MAX_RAPID_CRASHES) {
      log(`${MAX_RAPID_CRASHES} crashes in ${RAPID_CRASH_WINDOW_MS / 1000}s — giving up.`);
      process.exit(1);
    }

    log(`Kingston exited with code ${code}. Restarting in ${CRASH_DELAY_MS / 1000}s...`);
    setTimeout(startBot, CRASH_DELAY_MS);
  });

  child.on("error", (err) => {
    log(`Failed to spawn: ${err.message}`);
    setTimeout(startBot, CRASH_DELAY_MS);
  });
}

// Forward SIGINT/SIGTERM to stop cleanly
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`Received ${sig} — shutting down.`);
    process.exit(0);
  });
}

startBot();
