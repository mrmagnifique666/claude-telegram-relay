/**
 * Base Agent class — autonomous workers with their own heartbeat loops.
 * Agents share the skill registry and SQLite with Kingston but have
 * independent identities, specialized prompts, and configurable intervals.
 *
 * Resilience features:
 * - State persistence to SQLite (survives restarts)
 * - Exponential backoff on consecutive errors
 * - Auto-disable after MAX_CONSECUTIVE_ERRORS with admin notification
 * - Audit trail: every run logged to agent_runs table
 */
import { handleMessage } from "../orchestrator/router.js";
import { getDb } from "../storage/store.js";
import { clearTurns, clearSession } from "../storage/store.js";
import { log } from "../utils/log.js";
import { broadcast } from "../dashboard/broadcast.js";
import { emitHook } from "../hooks/hooks.js";

const MAX_CONSECUTIVE_ERRORS = 5;

// --- Global rate limit shared across all agents ---
let rateLimitUntil = 0; // timestamp (ms) until which all agents should pause

export function isRateLimited(): boolean {
  return Date.now() < rateLimitUntil;
}

export function getRateLimitReset(): number {
  return rateLimitUntil;
}

function detectRateLimit(text: string): boolean {
  // Claude CLI returns various rate limit messages:
  // "You've hit your limit · resets Xam/pm (TZ)"
  // "Credit balance is too low"
  if (!/hit your limit|rate.?limit|credit balance is too low/i.test(text)) return false;

  // Try to parse the reset time from the message
  const match = text.match(/resets?\s+(\d{1,2})(am|pm)\s*\(([^)]+)\)/i);
  if (match) {
    const hour = parseInt(match[1]);
    const isPm = match[2].toLowerCase() === "pm";
    const tz = match[3];
    const resetHour = isPm && hour !== 12 ? hour + 12 : !isPm && hour === 12 ? 0 : hour;

    // Calculate next occurrence of that hour in the given timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    });
    const currentHour = Number(formatter.formatToParts(now).find((p) => p.type === "hour")!.value);

    let hoursUntilReset = resetHour - currentHour;
    if (hoursUntilReset <= 0) hoursUntilReset += 24;

    rateLimitUntil = Date.now() + hoursUntilReset * 3600_000;
    log.warn(`[agents] Rate limit detected — pausing all agents for ${hoursUntilReset}h (until ${new Date(rateLimitUntil).toISOString()})`);
  } else {
    // Fallback: pause for 2 hours
    rateLimitUntil = Date.now() + 2 * 3600_000;
    log.warn(`[agents] Rate limit detected — pausing all agents for 2h (fallback)`);
  }

  return true;
}

export interface AgentConfig {
  /** Unique agent identifier (e.g. "scout", "concierge") */
  id: string;
  /** Display name */
  name: string;
  /** Short description of the agent's role */
  role: string;
  /** Heartbeat interval in milliseconds */
  heartbeatMs: number;
  /** Whether the agent is enabled */
  enabled: boolean;
  /** Telegram chat ID to route messages through */
  chatId: number;
  /** User ID for permission checks */
  userId: number;
  /** Build the heartbeat prompt — returns null to skip this cycle */
  buildPrompt: (cycle: number) => string | null;
  /** Optional: number of cycles before rotating (default: 1 — every heartbeat fires) */
  cycleCount?: number;
}

export type AgentStatus = "idle" | "running" | "stopped" | "error" | "backoff";

export interface AgentStats {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  enabled: boolean;
  heartbeatMs: number;
  cycle: number;
  totalRuns: number;
  lastRunAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  createdAt: number;
}

// --- Persistence helpers ---

interface AgentStateRow {
  agent_id: string;
  cycle: number;
  total_runs: number;
  last_run_at: number | null;
  last_error: string | null;
  consecutive_errors: number;
}

function loadState(agentId: string): AgentStateRow | null {
  try {
    const db = getDb();
    return db
      .prepare("SELECT * FROM agent_state WHERE agent_id = ?")
      .get(agentId) as AgentStateRow | undefined ?? null;
  } catch {
    return null; // table may not exist yet on first run
  }
}

function saveState(agent: Agent): void {
  try {
    const db = getDb();
    const stats = agent.getStats();
    db.prepare(
      `INSERT INTO agent_state (agent_id, cycle, total_runs, last_run_at, last_error, consecutive_errors, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id) DO UPDATE SET
         cycle = excluded.cycle,
         total_runs = excluded.total_runs,
         last_run_at = excluded.last_run_at,
         last_error = excluded.last_error,
         consecutive_errors = excluded.consecutive_errors,
         updated_at = excluded.updated_at`
    ).run(stats.id, stats.cycle, stats.totalRuns, stats.lastRunAt, stats.lastError, stats.consecutiveErrors);
  } catch (err) {
    log.debug(`[agent:${agent.id}] Failed to save state: ${err}`);
  }
}

function logRun(agentId: string, cycle: number, startedAt: number, durationMs: number, outcome: string, errorMsg?: string): void {
  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO agent_runs (agent_id, cycle, started_at, duration_ms, outcome, error_msg) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(agentId, cycle, Math.floor(startedAt / 1000), durationMs, outcome, errorMsg ?? null);

    // Push real-time event to dashboard
    broadcast("agent_run", {
      agent_id: agentId, cycle, started_at: Math.floor(startedAt / 1000),
      duration_ms: durationMs, outcome, error_msg: errorMsg ?? null,
    });
  } catch (err) {
    log.debug(`[agent:${agentId}] Failed to log run: ${err}`);
  }
}

export class Agent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly heartbeatMs: number;
  readonly chatId: number;
  readonly userId: number;

  private enabled: boolean;
  private status: AgentStatus = "idle";
  private cycle = 0;
  private totalRuns = 0;
  private lastRunAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveErrors = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buildPrompt: (cycle: number) => string | null;
  private cycleCount: number;
  private createdAt: number;
  private running = false; // guard against overlapping runs

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.role = config.role;
    this.heartbeatMs = config.heartbeatMs;
    this.enabled = config.enabled;
    this.chatId = config.chatId;
    this.userId = config.userId;
    this.buildPrompt = config.buildPrompt;
    this.cycleCount = config.cycleCount ?? 1;
    this.createdAt = Date.now();

    // Restore persisted state
    const saved = loadState(this.id);
    if (saved) {
      this.cycle = saved.cycle;
      this.totalRuns = saved.total_runs;
      this.lastRunAt = saved.last_run_at;
      this.lastError = saved.last_error;
      this.consecutiveErrors = saved.consecutive_errors;
      log.info(`[agent:${this.id}] Restored state — cycle ${this.cycle}, runs ${this.totalRuns}, errors ${this.consecutiveErrors}`);
    }
  }

  /** Start the agent's heartbeat loop */
  start(): void {
    if (this.timer) {
      log.warn(`[agent:${this.id}] Already running`);
      return;
    }
    if (!this.enabled) {
      log.info(`[agent:${this.id}] Disabled — not starting`);
      this.status = "stopped";
      return;
    }

    // If too many errors from previous session, reset but warn
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      log.warn(`[agent:${this.id}] Had ${this.consecutiveErrors} consecutive errors — resetting error count`);
      this.consecutiveErrors = 0;
    }

    this.status = "idle";
    log.info(`[agent:${this.id}] Starting (${this.name}) — heartbeat every ${this.heartbeatMs / 1000}s`);

    // First tick after a short delay
    setTimeout(() => this.tick(), 10_000);

    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
  }

  /** Stop the agent */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status = "stopped";
    saveState(this);
    log.info(`[agent:${this.id}] Stopped`);
  }

  /** Enable/disable the agent */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  /** Get agent stats */
  getStats(): AgentStats {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      status: this.status,
      enabled: this.enabled,
      heartbeatMs: this.heartbeatMs,
      cycle: this.cycle,
      totalRuns: this.totalRuns,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      consecutiveErrors: this.consecutiveErrors,
      createdAt: this.createdAt,
    };
  }

  /** Single heartbeat tick */
  private async tick(): Promise<void> {
    if (!this.enabled || this.running) return;

    // Global rate limit: skip all agents until reset
    if (isRateLimited()) {
      const remaining = Math.round((rateLimitUntil - Date.now()) / 60_000);
      log.debug(`[agent:${this.id}] Rate limited — ${remaining}min until reset`);
      return;
    }

    // Exponential backoff: skip tick if in backoff period
    if (this.consecutiveErrors > 0) {
      const backoffMs = Math.min(
        Math.pow(2, this.consecutiveErrors) * 10_000, // 20s, 40s, 80s, 160s, 320s
        this.heartbeatMs * 2 // cap at 2x heartbeat
      );
      const timeSinceLastRun = Date.now() - (this.lastRunAt ?? 0);
      if (timeSinceLastRun < backoffMs) {
        this.status = "backoff";
        log.debug(`[agent:${this.id}] Backoff — ${Math.round((backoffMs - timeSinceLastRun) / 1000)}s remaining (${this.consecutiveErrors} errors)`);
        return;
      }
    }

    const prompt = this.buildPrompt(this.cycle);
    this.cycle++;

    if (!prompt) {
      log.debug(`[agent:${this.id}] Cycle ${this.cycle} — skipped (no prompt)`);
      saveState(this); // persist cycle increment
      return;
    }

    this.running = true;
    this.status = "running";
    const startTime = Date.now();
    log.info(`[agent:${this.id}] Cycle ${this.cycle} — executing`);

    // Fresh session every cycle — prevents context bloat from accumulated turns
    clearTurns(this.chatId);
    clearSession(this.chatId);

    await emitHook("agent:cycle:start", { agentId: this.id, cycle: this.cycle, chatId: this.chatId });

    try {
      // Prefix prompt with agent identity so Claude knows who it is
      const agentPrompt =
        `[AGENT:${this.id.toUpperCase()}] (${this.name} — ${this.role})\n\n` +
        prompt;

      const result = await handleMessage(this.chatId, agentPrompt, this.userId, "scheduler");

      // Check if Claude returned a rate limit message
      if (detectRateLimit(result)) {
        const durationMs = Date.now() - startTime;
        this.lastRunAt = Date.now();
        this.lastError = "rate_limit";
        this.status = "backoff";
        logRun(this.id, this.cycle, startTime, durationMs, "rate_limit");
        saveState(this);
        log.warn(`[agent:${this.id}] Cycle ${this.cycle} — rate limited, pausing`);
        return;
      }

      const durationMs = Date.now() - startTime;
      this.totalRuns++;
      this.lastRunAt = Date.now();
      this.lastError = null;
      this.consecutiveErrors = 0;
      this.status = "idle";

      logRun(this.id, this.cycle, startTime, durationMs, "success");
      saveState(this);
      await emitHook("agent:cycle:end", { agentId: this.id, cycle: this.cycle, chatId: this.chatId });
      log.info(`[agent:${this.id}] Cycle ${this.cycle} — completed (${durationMs}ms)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      this.lastError = msg;
      this.lastRunAt = Date.now();
      this.consecutiveErrors++;
      this.status = "error";

      logRun(this.id, this.cycle, startTime, durationMs, "error", msg);
      saveState(this);
      log.error(`[agent:${this.id}] Cycle ${this.cycle} — error (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${msg}`);

      // Auto-disable after too many consecutive errors
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log.error(`[agent:${this.id}] Disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        this.stop();

        // Notify admin via Telegram
        try {
          const alertPrompt =
            `[AGENT:SYSTEM] L'agent ${this.name} (${this.id}) a été désactivé automatiquement après ${MAX_CONSECUTIVE_ERRORS} erreurs consécutives.\n` +
            `Dernière erreur: ${msg}\n` +
            `Utilise agents.start(id="${this.id}") pour le redémarrer après investigation.\n` +
            `Envoie cette alerte à Nicolas via telegram.send.`;
          await handleMessage(this.chatId, alertPrompt, this.userId, "scheduler");
        } catch {
          // Best effort — don't fail on notification failure
        }
      }
    } finally {
      this.running = false;
    }
  }
}
