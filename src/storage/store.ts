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
