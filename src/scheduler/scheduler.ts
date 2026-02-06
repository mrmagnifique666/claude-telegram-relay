/**
 * Scheduler — tick loop (60s) that fires timed events and custom reminders.
 * Uses handleMessage() so Claude generates natural briefings.
 * Timezone: America/Toronto via Intl.DateTimeFormat.
 */
import { getDb } from "../storage/store.js";
import { handleMessage } from "../orchestrator/router.js";
import { log } from "../utils/log.js";

const TICK_MS = 60_000;
const TZ = "America/Toronto";

interface ScheduledEvent {
  key: string;
  type: "daily" | "interval";
  /** For daily: hour (0-23) to fire */
  hour?: number;
  /** For interval: interval in minutes */
  intervalMin?: number;
  /** Prompt sent to handleMessage, or null for silent events */
  prompt: string | null;
}

const EVENTS: ScheduledEvent[] = [
  {
    key: "morning_briefing",
    type: "daily",
    hour: 8,
    prompt:
      "[SCHEDULER] Briefing matinal. Donne un résumé de la journée : rappels en attente, notes récentes, et un mot d'encouragement. Sois concis.",
  },
  {
    key: "evening_checkin",
    type: "daily",
    hour: 20,
    prompt:
      "[SCHEDULER] Check-in du soir. Fais un bilan rapide de la journée : ce qui a été fait, rappels manqués, et souhaite une bonne soirée.",
  },
  {
    key: "heartbeat",
    type: "interval",
    intervalMin: 30,
    prompt: null, // silent — monitoring only
  },
];

let timer: ReturnType<typeof setInterval> | null = null;
let schedulerChatId = 0;
let schedulerUserId = 0;

function ensureTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      event_key TEXT PRIMARY KEY,
      last_run_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduler_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fire_at INTEGER NOT NULL,
      message TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function nowInTz(): { hour: number; dateStr: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")!.value);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return { hour, dateStr: `${y}-${m}-${d}` };
}

function getLastRun(key: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT last_run_at FROM scheduler_runs WHERE event_key = ?")
    .get(key) as { last_run_at: number } | undefined;
  return row?.last_run_at ?? 0;
}

function setLastRun(key: string, epoch: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO scheduler_runs (event_key, last_run_at) VALUES (?, ?)
     ON CONFLICT(event_key) DO UPDATE SET last_run_at = excluded.last_run_at`
  ).run(key, epoch);
}

async function fireEvent(event: ScheduledEvent): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  setLastRun(event.key, nowEpoch);

  if (event.prompt) {
    log.info(`[scheduler] Firing ${event.type} event: ${event.key}`);
    try {
      await handleMessage(schedulerChatId, event.prompt, schedulerUserId);
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
  } else {
    log.debug(`[scheduler] Heartbeat tick`);
  }
}

async function tick(): Promise<void> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const { hour, dateStr } = nowInTz();

  for (const event of EVENTS) {
    const lastRun = getLastRun(event.key);

    if (event.type === "daily" && event.hour !== undefined) {
      // Fire if current hour matches and we haven't fired today
      const lastDate = lastRun
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: TZ,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(lastRun * 1000))
        : "";
      if (hour === event.hour && lastDate !== dateStr) {
        await fireEvent(event);
      }
    } else if (event.type === "interval" && event.intervalMin !== undefined) {
      // Fire if enough time has elapsed since last run
      const elapsedMin = (nowEpoch - lastRun) / 60;
      if (elapsedMin >= event.intervalMin) {
        await fireEvent(event);
      }
    }
  }

  // Check custom reminders
  const db = getDb();
  const dueReminders = db
    .prepare(
      "SELECT id, message FROM scheduler_reminders WHERE fire_at <= ? AND fired = 0"
    )
    .all(nowEpoch) as { id: number; message: string }[];

  for (const rem of dueReminders) {
    log.info(`[scheduler] Firing reminder #${rem.id}`);
    db.prepare("UPDATE scheduler_reminders SET fired = 1 WHERE id = ?").run(
      rem.id
    );
    try {
      const prompt = `[SCHEDULER] Rappel: ${rem.message}`;
      await handleMessage(schedulerChatId, prompt, schedulerUserId);
    } catch (err) {
      log.error(`[scheduler] Error firing reminder #${rem.id}: ${err}`);
    }
  }
}

// --- Public API ---

export function startScheduler(chatId: number, userId: number): void {
  if (!chatId || !userId) {
    log.warn(
      "[scheduler] Missing chatId or userId — scheduler disabled. Set VOICE_CHAT_ID and VOICE_USER_ID."
    );
    return;
  }

  ensureTables();
  schedulerChatId = chatId;
  schedulerUserId = userId;

  // Run first tick after a short delay (let bot finish starting)
  setTimeout(() => tick().catch((e) => log.error(`[scheduler] tick error: ${e}`)), 5_000);

  timer = setInterval(
    () => tick().catch((e) => log.error(`[scheduler] tick error: ${e}`)),
    TICK_MS
  );

  log.info(`[scheduler] Started (chatId=${chatId}, userId=${userId}, tick=${TICK_MS}ms)`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("[scheduler] Stopped");
  }
}

export function addReminder(fireAt: number, message: string): number {
  const db = getDb();
  ensureTables();
  const info = db
    .prepare("INSERT INTO scheduler_reminders (fire_at, message) VALUES (?, ?)")
    .run(fireAt, message);
  log.info(
    `[scheduler] Added reminder #${info.lastInsertRowid} for ${new Date(fireAt * 1000).toISOString()}`
  );
  return Number(info.lastInsertRowid);
}

export function listReminders(): {
  id: number;
  fire_at: number;
  message: string;
  fired: number;
}[] {
  const db = getDb();
  ensureTables();
  return db
    .prepare(
      "SELECT id, fire_at, message, fired FROM scheduler_reminders WHERE fired = 0 ORDER BY fire_at ASC"
    )
    .all() as { id: number; fire_at: number; message: string; fired: number }[];
}

export function cancelReminder(id: number): boolean {
  const db = getDb();
  ensureTables();
  const info = db
    .prepare("DELETE FROM scheduler_reminders WHERE id = ? AND fired = 0")
    .run(id);
  return info.changes > 0;
}
