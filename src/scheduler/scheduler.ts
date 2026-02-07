/**
 * Scheduler — tick loop (60s) that fires timed events and custom reminders.
 * Uses handleMessage() so Claude generates natural briefings.
 * Timezone: America/Toronto via Intl.DateTimeFormat.
 */
import fs from "node:fs";
import path from "node:path";
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
    key: "code_digest_morning",
    type: "daily",
    hour: 9,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "code_digest_evening",
    type: "daily",
    hour: 21,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "heartbeat",
    type: "interval",
    intervalMin: 30,
    prompt: null, // dynamic — proactive checks at fire time
  },
  {
    key: "moltbook_digest",
    type: "daily",
    hour: 15,
    prompt: null, // dynamic — built at fire time
  },
  {
    key: "daily_alpha_report",
    type: "daily",
    hour: 8,
    prompt: null, // dynamic — built at fire time via market.report skill
  },
  {
    key: "weekly_self_review",
    type: "daily",
    hour: 23,
    prompt: null, // dynamic — fires Sunday only, built at fire time
  },
];

const CODE_REQUESTS_FILE = path.join(process.cwd(), "code-requests.json");

function buildCodeDigestPrompt(): string | null {
  try {
    if (!fs.existsSync(CODE_REQUESTS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CODE_REQUESTS_FILE, "utf-8")) as any[];
    const pending = data.filter(
      (r) => r.status === "pending" || r.status === "awaiting_execution"
    );
    if (pending.length === 0) return null;

    const summary = pending
      .map((r, i) => {
        const taskPreview = r.task.length > 150 ? r.task.slice(0, 150) + "..." : r.task;
        return `${i + 1}. [${r.priority}] ${taskPreview}`;
      })
      .join("\n");

    return (
      `[SCHEDULER] Code Request Digest — ${pending.length} demande(s) en attente.\n\n` +
      `${summary}\n\n` +
      `Présente ce digest à Nicolas de façon concise. Pour chaque demande, donne ton avis : ` +
      `utile/redondant/déjà fait/trop ambitieux. Demande-lui lesquelles exécuter. ` +
      `Utilise telegram.send pour envoyer le résumé.`
    );
  } catch (err) {
    log.error(`[scheduler] Error building code digest: ${err}`);
    return null;
  }
}

/**
 * Build Moltbook digest — check trending posts and suggest engagement.
 */
function buildMoltbookDigestPrompt(): string {
  return (
    `[SCHEDULER] Moltbook daily digest. ` +
    `Utilise moltbook.feed avec sort=hot et limit=5 pour voir les posts tendance. ` +
    `Puis envoie un résumé concis à Nicolas via telegram.send avec les 3-5 posts les plus intéressants. ` +
    `Si tu vois un post pertinent pour Kingston ou Nicolas, mentionne pourquoi. ` +
    `Garde le message court et informatif.`
  );
}

/**
 * Proactive heartbeat — checks for unread emails and upcoming calendar events.
 * Returns a prompt for Claude if there's something worth notifying, null otherwise.
 */
async function buildHeartbeatPrompt(): Promise<string | null> {
  const alerts: string[] = [];

  // Check unread emails (last 30 minutes)
  try {
    const { getGmailClient } = await import("../gmail/auth.js");
    const gmail = getGmailClient();
    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread newer_than:30m",
      maxResults: 5,
    });
    const messages = res.data.messages;
    if (messages && messages.length > 0) {
      const details: string[] = [];
      for (const msg of messages.slice(0, 3)) {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        const headers = detail.data.payload?.headers || [];
        const from = headers.find((h: any) => h.name === "From")?.value || "?";
        const subject = headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
        details.push(`- ${from}: ${subject}`);
      }
      const extra = messages.length > 3 ? ` (+${messages.length - 3} more)` : "";
      alerts.push(`**Emails non lus (${messages.length}):**${extra}\n${details.join("\n")}`);
    }
  } catch (err) {
    log.debug(`[heartbeat] Gmail check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Check upcoming calendar events (next 30 minutes)
  try {
    const { getCalendarClient } = await import("../gmail/auth.js");
    const calendar = getCalendarClient();
    const now = new Date();
    const in30min = new Date(now.getTime() + 30 * 60_000);
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: in30min.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: TZ,
    });
    const events = res.data.items;
    if (events && events.length > 0) {
      const details = events.map((e: any) => {
        const start = e.start?.dateTime
          ? new Date(e.start.dateTime).toLocaleTimeString("fr-CA", { timeZone: TZ, timeStyle: "short" })
          : "all-day";
        return `- ${start}: ${e.summary || "(sans titre)"}`;
      });
      alerts.push(`**Events dans les 30 prochaines minutes:**\n${details.join("\n")}`);
    }
  } catch (err) {
    log.debug(`[heartbeat] Calendar check failed: ${err instanceof Error ? err.message : err}`);
  }

  // Check pending code requests
  try {
    if (fs.existsSync(CODE_REQUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CODE_REQUESTS_FILE, "utf-8")) as any[];
      const pending = data.filter(
        (r) => r.status === "pending" || r.status === "awaiting_execution"
      );
      if (pending.length > 0) {
        alerts.push(`**Code requests en attente (${pending.length}):**\n${pending.map((r) => `- [${r.priority}] ${r.task.slice(0, 80)}...`).join("\n")}`);
      }
    }
  } catch (err) {
    log.debug(`[heartbeat] Code requests check failed: ${err instanceof Error ? err.message : err}`);
  }

  if (alerts.length === 0) return null;

  return (
    `[SCHEDULER] Heartbeat proactif — notifications:\n\n${alerts.join("\n\n")}\n\n` +
    `Notifie Nicolas de ces éléments de façon concise via telegram.send. ` +
    `Pour les emails, mentionne l'expéditeur et le sujet. Pour le calendrier, mentionne l'heure et le titre. ` +
    `Pour les code requests, mentionne le nombre et la priorité.`
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let schedulerChatId = 0;
let schedulerUserId = 0;

// Heartbeat restraint: track consecutive silent heartbeats
let consecutiveSilentHeartbeats = 0;
const SILENCE_STREAK_THRESHOLD = 10; // ~5 hours of stability
let silenceStreakNotified = false;

// Proactive heartbeat counter (rotation)
let heartbeatCycleCounter = 0;

/**
 * Proactive Value Engine — generates business actions on each heartbeat.
 * Rotation: counter % 5 determines which actions to run.
 * Only runs if HEARTBEAT_PROACTIVE_MODE=true in .env.
 */
function buildProactivePrompt(): string | null {
  if (process.env.HEARTBEAT_PROACTIVE_MODE !== "true") return null;

  const cycle = heartbeatCycleCounter % 5;
  heartbeatCycleCounter++;

  const actions: Record<number, string> = {
    0: // LinkedIn Prospecting + Twitter Engagement
      `[HEARTBEAT PROACTIF] Cycle ${heartbeatCycleCounter} — LinkedIn Prospecting + Twitter\n\n` +
      `**Action 1: LinkedIn Prospecting**\n` +
      `- Si linkedin configuré: utilise linkedin.search pour trouver des courtiers/brokers dans la région Gatineau/Ottawa\n` +
      `- Sinon: utilise web.search pour "courtier immobilier Gatineau" ou "insurance broker Ottawa"\n` +
      `- Sauvegarde 2-3 prospects trouvés via contacts.add avec tags "prospect,linkedin,broker"\n` +
      `- Log l'action via analytics.log(skill='proactive.linkedin', outcome='success')\n\n` +
      `**Action 2: Twitter Engagement**\n` +
      `- Si twitter configuré: twitter.search "real estate leads" ou "broker tips", like 2-3 tweets\n` +
      `- Sinon: skip et log analytics.log(skill='proactive.twitter', outcome='skipped', errorMsg='not configured')\n\n` +
      `Résume brièvement les actions prises via telegram.send. Sois concis (2-3 lignes max).`,

    1: // Client Health Check + Performance Logging
      `[HEARTBEAT PROACTIF] Cycle ${heartbeatCycleCounter} — Client Health + Performance\n\n` +
      `**Action 1: Client Health Check**\n` +
      `- Utilise contacts.list avec tag "client" pour voir les clients existants\n` +
      `- Identifie ceux sans interaction récente (regarde updated_at)\n` +
      `- Si un client n'a pas été contacté depuis >7 jours, note-le\n` +
      `- Crée un brouillon gmail.draft si gmail est configuré pour relancer\n\n` +
      `**Action 2: Performance Logging**\n` +
      `- Utilise analytics.report avec timeframe='today' pour un snapshot\n` +
      `- Log cette exécution de heartbeat via analytics.log\n\n` +
      `Résume via telegram.send. Max 3 lignes.`,

    2: // Reddit Mining + Automated Follow-ups
      `[HEARTBEAT PROACTIF] Cycle ${heartbeatCycleCounter} — Reddit Mining + Follow-ups\n\n` +
      `**Action 1: Reddit Pain Point Mining**\n` +
      `- Si reddit configuré: reddit.search "lead generation" dans r/realestate, limit=5\n` +
      `- Sinon: utilise web.search pour "site:reddit.com real estate lead generation"\n` +
      `- Identifie 1-2 posts avec des pain points pertinents\n` +
      `- Sauvegarde dans notes.add avec tag "reddit-prospect"\n\n` +
      `**Action 2: Follow-ups**\n` +
      `- contacts.search avec tag "prospect" pour voir les prospects récents\n` +
      `- Identifie ceux ajoutés il y a >3 jours sans follow-up\n` +
      `- Suggère une action de relance à Nicolas\n\n` +
      `Résume via telegram.send. Max 3 lignes.`,

    3: // Competitive Intel + LinkedIn Content
      `[HEARTBEAT PROACTIF] Cycle ${heartbeatCycleCounter} — Veille concurrentielle + Contenu\n\n` +
      `**Action 1: Competitive Intelligence**\n` +
      `- web.search "AI answering service real estate 2026" ou "AI assistant broker"\n` +
      `- Identifie 1-2 concurrents ou tendances intéressantes\n` +
      `- Sauvegarde un résumé dans notes.add avec tag "veille-concurrentielle"\n\n` +
      `**Action 2: Content Draft**\n` +
      `- Rédige un court snippet LinkedIn (150-200 chars) sur un sujet rotatif:\n` +
      `  Tips broker, tendances marché, automatisation IA, success stories\n` +
      `- Sauvegarde dans notes.add avec tag "content-draft-linkedin"\n` +
      `- Ne publie PAS — Nicolas approuve d'abord\n\n` +
      `Résume via telegram.send. Max 3 lignes.`,

    4: // Skill Audit + Moltbook Engagement
      `[HEARTBEAT PROACTIF] Cycle ${heartbeatCycleCounter} — Audit skills + Moltbook\n\n` +
      `**Action 1: Skill Utilization Audit**\n` +
      `- Utilise analytics.bottlenecks pour identifier les skills lents\n` +
      `- Si un skill est >5s en moyenne, utilise optimize.suggest dessus\n` +
      `- Log le résultat via analytics.log\n\n` +
      `**Action 2: Moltbook Quick Engagement**\n` +
      `- moltbook.feed sort=hot limit=3 pour voir les posts tendance\n` +
      `- Si un post est pertinent, moltbook.upvote\n` +
      `- Si un post mérite un commentaire constructif, moltbook.comment\n\n` +
      `Résume via telegram.send. Max 3 lignes.`,
  };

  return actions[cycle] || null;
}

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

  // Weekly self-review — Sunday 11 PM only
  if (event.key === "weekly_self_review") {
    const dayOfWeek = new Date().toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long" });
    if (dayOfWeek !== "Sunday") {
      log.debug(`[scheduler] weekly_self_review: skipping (${dayOfWeek}, not Sunday)`);
      return;
    }
    log.info(`[scheduler] Firing Weekly Self-Review`);
    try {
      const prompt =
        `[SCHEDULER] Weekly Self-Review — C'est dimanche soir, temps de faire le bilan.\n\n` +
        `1. Utilise analytics.report avec timeframe='week' pour obtenir les stats de la semaine\n` +
        `2. Utilise learn.preferences pour voir les patterns appris\n` +
        `3. Utilise optimize.analyze sur les skills les plus utilisés\n` +
        `4. Génère un rapport format:\n` +
        `   📊 WEEKLY SELF-REVIEW\n` +
        `   ✅ WINS (ce qui a bien fonctionné)\n` +
        `   ⚠️ AMÉLIORATIONS (ce qui peut être mieux)\n` +
        `   🚀 PLAN (actions prévues)\n` +
        `   CONFIANCE: X/10\n` +
        `5. Envoie le rapport à Nicolas via telegram.send`;
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Weekly Self-Review error: ${err}`);
    }
    return;
  }

  // Daily Alpha Report — market analysis before market open
  if (event.key === "daily_alpha_report") {
    log.info(`[scheduler] Firing Daily Alpha Report`);
    try {
      const prompt =
        `[SCHEDULER] Daily Alpha Report — C'est l'heure du briefing marché pré-ouverture. ` +
        `Utilise le skill market.report pour générer le rapport complet et l'envoyer à Nicolas via telegram.send. ` +
        `Si le marché est fermé (weekend), envoie un bref message disant que le marché est fermé aujourd'hui.`;
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Daily Alpha Report error: ${err}`);
    }
    return;
  }

  // Moltbook daily digest
  if (event.key === "moltbook_digest") {
    log.info(`[scheduler] Firing Moltbook daily digest`);
    try {
      const prompt = buildMoltbookDigestPrompt();
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Moltbook digest error: ${err}`);
    }
    return;
  }

  // Dynamic digest events — build prompt at fire time
  if (event.key.startsWith("code_digest_")) {
    const digestPrompt = buildCodeDigestPrompt();
    if (!digestPrompt) {
      log.info(`[scheduler] ${event.key}: no pending code requests — skipping`);
      return;
    }
    log.info(`[scheduler] Firing code digest: ${event.key}`);
    try {
      await handleMessage(schedulerChatId, digestPrompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
    return;
  }

  // Proactive heartbeat — check emails + calendar (with restraint)
  if (event.key === "heartbeat") {
    log.debug(`[scheduler] Heartbeat tick — checking proactive alerts (silent streak: ${consecutiveSilentHeartbeats})`);
    try {
      const heartbeatPrompt = await buildHeartbeatPrompt();
      if (heartbeatPrompt) {
        // Something to report — reset silence streak
        consecutiveSilentHeartbeats = 0;
        silenceStreakNotified = false;
        log.info(`[scheduler] Heartbeat found alerts — notifying`);
        await handleMessage(schedulerChatId, heartbeatPrompt, schedulerUserId, "scheduler");
      } else {
        // Nothing to report — increment silence streak
        consecutiveSilentHeartbeats++;
        log.debug(`[scheduler] Heartbeat — nothing to report (streak: ${consecutiveSilentHeartbeats})`);

        // After 10 consecutive silent heartbeats (~5h), surface stability message once
        if (consecutiveSilentHeartbeats >= SILENCE_STREAK_THRESHOLD && !silenceStreakNotified) {
          silenceStreakNotified = true;
          const hours = Math.round((consecutiveSilentHeartbeats * 30) / 60);
          const stabilityMsg =
            `[SCHEDULER] Stability report: tout est stable depuis ~${hours}h. ` +
            `${consecutiveSilentHeartbeats} heartbeats consécutifs sans alertes. ` +
            `Envoie un bref message de stabilité à Nicolas via telegram.send — pas d'urgence, juste un signal de confiance.`;
          await handleMessage(schedulerChatId, stabilityMsg, schedulerUserId, "scheduler");
        }
      }

      // Proactive Value Engine — fire business actions after regular alert handling
      const proactivePrompt = buildProactivePrompt();
      if (proactivePrompt) {
        log.info(`[scheduler] Heartbeat proactive cycle ${heartbeatCycleCounter} — firing actions`);
        try {
          await handleMessage(schedulerChatId, proactivePrompt, schedulerUserId, "scheduler");
        } catch (proactiveErr) {
          log.error(`[scheduler] Heartbeat proactive error: ${proactiveErr}`);
        }
      }
    } catch (err) {
      log.error(`[scheduler] Heartbeat error: ${err}`);
    }
    return;
  }

  if (event.prompt) {
    log.info(`[scheduler] Firing ${event.type} event: ${event.key}`);
    try {
      await handleMessage(schedulerChatId, event.prompt, schedulerUserId, "scheduler");
    } catch (err) {
      log.error(`[scheduler] Error firing ${event.key}: ${err}`);
    }
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
      await handleMessage(schedulerChatId, prompt, schedulerUserId, "scheduler");
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
