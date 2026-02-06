/**
 * Conversation memory store using SQLite (via better-sqlite3).
 * Stores the last N turns per chat for context continuity.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = path.resolve("relay.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_turns_chat ON turns(chat_id, id);

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS sessions (
        chat_id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        user_id INTEGER PRIMARY KEY,
        authenticated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
        error_message TEXT NOT NULL,
        stack TEXT,
        context TEXT,
        resolved INTEGER NOT NULL DEFAULT 0
      );
    `);
    log.info(`SQLite store initialised at ${dbPath}`);
  }
  return db;
}

export function addTurn(chatId: number, turn: Turn): void {
  const d = getDb();
  d.prepare("INSERT INTO turns (chat_id, role, content) VALUES (?, ?, ?)").run(
    chatId,
    turn.role,
    turn.content
  );

  // Prune old turns beyond the configured limit
  const count = d
    .prepare("SELECT COUNT(*) as c FROM turns WHERE chat_id = ?")
    .get(chatId) as { c: number };

  if (count.c > config.memoryTurns) {
    const excess = count.c - config.memoryTurns;
    d.prepare(
      `DELETE FROM turns WHERE id IN (
        SELECT id FROM turns WHERE chat_id = ? ORDER BY id ASC LIMIT ?
      )`
    ).run(chatId, excess);
  }
}

export function getTurns(chatId: number): Turn[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT role, content FROM turns WHERE chat_id = ? ORDER BY id ASC"
    )
    .all(chatId) as Turn[];
  return rows;
}

export function clearTurns(chatId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM turns WHERE chat_id = ?").run(chatId);
  log.info(`Cleared conversation for chat ${chatId}`);
}

export function getSession(chatId: number): string | null {
  const d = getDb();
  const row = d
    .prepare("SELECT session_id FROM sessions WHERE chat_id = ?")
    .get(chatId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function saveSession(chatId: number, sessionId: string): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`
  ).run(chatId, sessionId);
  log.debug(`Saved session ${sessionId} for chat ${chatId}`);
}

export function clearSession(chatId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
  log.debug(`Cleared session for chat ${chatId}`);
}

// --- Admin sessions (persistent across restarts) ---

const ADMIN_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

export function saveAdminSession(userId: number): void {
  const d = getDb();
  d.prepare(
    `INSERT INTO admin_sessions (user_id, authenticated_at) VALUES (?, unixepoch())
     ON CONFLICT(user_id) DO UPDATE SET authenticated_at = unixepoch()`
  ).run(userId);
}

export function isAdminSession(userId: number): boolean {
  const d = getDb();
  const row = d
    .prepare(
      "SELECT authenticated_at FROM admin_sessions WHERE user_id = ? AND (unixepoch() - authenticated_at) < ?",
    )
    .get(userId, ADMIN_EXPIRY_SECONDS) as { authenticated_at: number } | undefined;
  if (!row) {
    // Check if there's an expired session for diagnostics
    const expired = d
      .prepare("SELECT authenticated_at FROM admin_sessions WHERE user_id = ?")
      .get(userId) as { authenticated_at: number } | undefined;
    if (expired) {
      log.debug(`Admin session for user ${userId} expired (age: ${Math.round((Date.now() / 1000 - expired.authenticated_at) / 3600)}h)`);
    } else {
      log.debug(`No admin session found for user ${userId}`);
    }
  }
  return !!row;
}

export function clearAdminSession(userId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM admin_sessions WHERE user_id = ?").run(userId);
}

// --- Error logging ---

export interface ErrorLogRow {
  id: number;
  timestamp: number;
  error_message: string;
  stack: string | null;
  context: string | null;
  resolved: number;
}

export function logError(error: Error | string, context?: string): number {
  const d = getDb();
  const message = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack ?? null : null;
  const info = d
    .prepare("INSERT INTO error_log (error_message, stack, context) VALUES (?, ?, ?)")
    .run(message, stack, context ?? null);
  log.debug(`[error_log] Recorded error #${info.lastInsertRowid}: ${message.slice(0, 80)}`);
  return info.lastInsertRowid as number;
}

export function getRecentErrors(count = 20): ErrorLogRow[] {
  const d = getDb();
  return d
    .prepare("SELECT * FROM error_log ORDER BY id DESC LIMIT ?")
    .all(count) as ErrorLogRow[];
}

export function resolveError(id: number): boolean {
  const d = getDb();
  const info = d.prepare("UPDATE error_log SET resolved = 1 WHERE id = ?").run(id);
  return info.changes > 0;
}
