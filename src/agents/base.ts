/**
 * Base Agent class — autonomous workers with their own heartbeat loops.
 * Agents share the skill registry and SQLite with Kingston but have
 * independent identities, specialized prompts, and configurable intervals.
 */
import { handleMessage } from "../orchestrator/router.js";
import { log } from "../utils/log.js";

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

export type AgentStatus = "idle" | "running" | "stopped" | "error";

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
  createdAt: number;
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
      createdAt: this.createdAt,
    };
  }

  /** Single heartbeat tick */
  private async tick(): Promise<void> {
    if (!this.enabled || this.running) return;

    const prompt = this.buildPrompt(this.cycle);
    this.cycle++;

    if (!prompt) {
      log.debug(`[agent:${this.id}] Cycle ${this.cycle} — skipped (no prompt)`);
      return;
    }

    this.running = true;
    this.status = "running";
    log.info(`[agent:${this.id}] Cycle ${this.cycle} — executing`);

    try {
      // Prefix prompt with agent identity so Claude knows who it is
      const agentPrompt =
        `[AGENT:${this.id.toUpperCase()}] (${this.name} — ${this.role})\n\n` +
        prompt;

      await handleMessage(this.chatId, agentPrompt, this.userId, "scheduler");

      this.totalRuns++;
      this.lastRunAt = Date.now();
      this.lastError = null;
      this.status = "idle";
      log.info(`[agent:${this.id}] Cycle ${this.cycle} — completed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.status = "error";
      log.error(`[agent:${this.id}] Cycle ${this.cycle} — error: ${msg}`);
    } finally {
      this.running = false;
    }
  }
}
