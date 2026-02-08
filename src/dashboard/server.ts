/**
 * Kingston Dashboard — Local web UI for monitoring agents, chatting, and system health.
 * Serves on localhost:3200 (configurable via DASHBOARD_PORT).
 * No external dependencies — uses Node http + existing ws.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { getDb, clearSession, clearTurns } from "../storage/store.js";
import { handleMessage } from "../orchestrator/router.js";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { listAgents } from "../agents/registry.js";
import { isRateLimited, getRateLimitReset } from "../agents/base.js";
import { addClient, broadcast, getClientCount } from "./broadcast.js";
import {
  getAllPatterns,
  evaluateEffectiveness,
  getErrorTrends as getPatternTrends,
} from "../memory/self-review.js";

const PORT = Number(process.env.DASHBOARD_PORT) || 3200;

// Resolve static dir relative to this file (works on Windows with tsx)
function resolveStaticDir(): string {
  try {
    const fileUrl = new URL(import.meta.url);
    // fileURLToPath handles Windows correctly
    const dir = path.dirname(fileUrl.pathname.replace(/^\/([A-Z]:)/i, "$1"));
    return path.resolve(dir, "public");
  } catch {
    // Fallback: resolve from cwd
    return path.resolve(process.cwd(), "src", "dashboard", "public");
  }
}
const STATIC_DIR = resolveStaticDir();

// ── MIME types ──────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Auth ────────────────────────────────────────────────────
/** Check DASHBOARD_TOKEN on mutating API endpoints. Returns true if OK. */
function checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const token = config.dashboardToken;
  if (!token) return true; // no token configured = open (localhost-only anyway)
  const provided = req.headers["x-auth-token"] as string | undefined;
  if (provided === token) return true;
  sendJson(res, 401, { ok: false, error: "Unauthorized - missing or invalid X-Auth-Token" });
  return false;
}

// Helpers
function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": `http://localhost:${PORT}`,
  });
  res.end(JSON.stringify(data));
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  sendJson(res, status, data);
}

function serveFile(res: http.ServerResponse, filePath: string) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

async function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

// ── API Routes ──────────────────────────────────────────────

function apiAgents(): unknown {
  const agents = listAgents();
  const rateLimited = isRateLimited();
  return {
    rateLimited,
    rateLimitReset: rateLimited ? getRateLimitReset() : null,
    agents,
  };
}

function apiAgentRuns(agentId: string, limit = 50): unknown {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, agent_id, cycle, started_at, duration_ms, outcome, error_msg
       FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(agentId, limit);
}

function apiStats(): unknown {
  const db = getDb();
  const uptimeMs = process.uptime() * 1000;
  const mem = process.memoryUsage();

  // Last 24h agent stats
  const cutoff24h = Math.floor(Date.now() / 1000) - 86400;
  const agentStats = db
    .prepare(
      `SELECT agent_id,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as successes,
              SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) as errors,
              SUM(CASE WHEN outcome='rate_limit' THEN 1 ELSE 0 END) as rate_limits,
              AVG(duration_ms) as avg_duration
       FROM agent_runs WHERE started_at > ? GROUP BY agent_id`
    )
    .all(cutoff24h);

  // Error count last 24h
  const errorCount = db
    .prepare(`SELECT COUNT(*) as count FROM error_log WHERE timestamp > ? AND resolved = 0`)
    .get(cutoff24h) as { count: number };

  // Notes count
  const noteCount = db.prepare(`SELECT COUNT(*) as count FROM notes`).get() as { count: number };

  return {
    uptime: uptimeMs,
    memory: {
      rss: Math.round(mem.rss / 1048576),
      heap: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
    },
    agentStats,
    errorCount: errorCount.count,
    noteCount: noteCount.count,
    wsClients: getClientCount(),
    rateLimited: isRateLimited(),
  };
}

function apiErrors(limit = 20): unknown {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, timestamp, error_message, context, resolved
       FROM error_log ORDER BY timestamp DESC LIMIT ?`
    )
    .all(limit);
}

function apiNotes(limit = 30): unknown {
  const db = getDb();
  return db
    .prepare(`SELECT id, text, created_at FROM notes ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
}

function apiScheduler(): unknown {
  const db = getDb();
  const recent = db
    .prepare(
      `SELECT id, event_key, fired_at, result FROM scheduler_runs ORDER BY fired_at DESC LIMIT 20`
    )
    .all();
  const reminders = db
    .prepare(`SELECT id, label, fire_at, chat_id FROM scheduler_reminders ORDER BY fire_at ASC`)
    .all();
  return { recent, reminders };
}

function apiLearnedPatterns(): unknown {
  const db = getDb();
  try {
    return db
      .prepare(`SELECT * FROM learned_patterns ORDER BY rowid DESC LIMIT 30`)
      .all();
  } catch {
    return [];
  }
}

function apiLearningInsights(): unknown {
  const patterns = getAllPatterns();
  const effectiveness = evaluateEffectiveness();
  const trends = getPatternTrends(48);

  const graduated = patterns.filter((p) => p.graduated);
  const nearGraduation = patterns.filter((p) => !p.graduated && p.count >= 3);
  const totalErrors = patterns.reduce((sum, p) => sum + p.count, 0);

  return {
    summary: {
      totalPatterns: patterns.length,
      graduatedRules: graduated.length,
      nearGraduation: nearGraduation.length,
      totalErrorsTracked: totalErrors,
      effectiveRules: effectiveness.filter((e) => e.effective).length,
      ineffectiveRules: effectiveness.filter((e) => !e.effective).length,
    },
    patterns: patterns.sort((a, b) => b.count - a.count).slice(0, 30),
    effectiveness,
    trends,
  };
}

// Dashboard has its own chatIds — separate from Telegram sessions
const KINGSTON_DASHBOARD_ID = 2;
const EMILE_DASHBOARD_ID = 3;
type DashboardAgent = "kingston" | "emile";

function getDashboardUserId(): number {
  return Number(config.allowedUsers[0]) || 8189338836;
}

async function apiChatKingston(message: string): Promise<string> {
  const userId = getDashboardUserId();
  const prefix =
    `[DASHBOARD MODE — KINGSTON]\n` +
    `Tu es Kingston dans le Dashboard web local. Nicolas voit ta réponse ici — PAS telegram.send.\n` +
    `Tu as l'AUTONOMIE COMPLÈTE et l'approbation de Nicolas pour modifier le code.\n\n` +
    `## RÈGLE #1 : AGIS, NE PARLE PAS\n` +
    `- Si on te demande d'améliorer quelque chose → lis le code (files.read_anywhere), modifie-le (files.write_anywhere)\n` +
    `- Si on te pose une question sur le système → lis les fichiers, analyse, réponds avec des faits\n` +
    `- Ne dis JAMAIS "je pourrais faire X" — FAIS X directement\n\n` +
    `## OUTILS DISPONIBLES\n` +
    `- files.read_anywhere: lire n'importe quel fichier du projet\n` +
    `- files.write_anywhere: modifier n'importe quel fichier du projet\n` +
    `- shell.exec: exécuter des commandes shell\n` +
    `- code.run: exécuter du code TypeScript/JavaScript\n` +
    `- notes.add: persister des décisions/observations\n` +
    `- analytics.log: logger une action\n\n` +
    `## FORMAT DE RÉPONSE\n` +
    `Après chaque action, structure ta réponse :\n` +
    `**ANALYSE** : ce que tu as trouvé (1-2 lignes)\n` +
    `**ACTIONS** : ce que tu as fait (liste des fichiers modifiés)\n` +
    `**RÉSULTAT** : ce qui a changé concrètement\n` +
    `**SUITE** : prochaine étape suggérée\n\n` +
    `Source du projet : ${process.cwd()}\n\n`;
  return handleMessage(KINGSTON_DASHBOARD_ID, prefix + message, userId, "user");
}

async function apiChatEmile(message: string): Promise<string> {
  const userId = getDashboardUserId();
  const prefix =
    `[DASHBOARD MODE - EMILE]\n` +
    `Tu es Emile, architecte logiciel. Dashboard web local. PAS telegram.send.\n` +
    `Mode par defaut: conversation directe concise et utile.\n` +
    `Si Nicolas demande explicitement de coder/modifier, alors execute les actions sur le repo.\n` +
    `Sinon, reponds clairement sans lancer de workflow long.\n\n` +
    `Source du projet : ${process.cwd()}\n\n`;
  return handleMessage(EMILE_DASHBOARD_ID, prefix + message, userId, "user");
}
async function apiChat(agent: DashboardAgent, message: string): Promise<string> {
  return agent === "emile" ? apiChatEmile(message) : apiChatKingston(message);
}

function buildUltimatePrompt(payload: {
  goal: string;
  constraints?: string;
  context?: string;
  target?: DashboardAgent | "both";
}): string {
  const goal = (payload.goal || "").trim() || "Ameliorer le dashboard et livrer une implementation testable.";
  const constraints = (payload.constraints || "").trim() || "Conserver le style actuel, securiser les endpoints, et garder une UX simple.";
  const target = payload.target || "both";
  const context = (payload.context || "").trim();
  const contextBlock = context ? `\n## CONTEXTE RECENT\n${context}\n` : "";

  return [
    "[PROMPT ULTIME - DASHBOARD EXECUTION]",
    `CIBLE: ${target}`,
    "",
    "Tu agis comme lead engineer sur ce repo local.",
    "Objectif: implementer maintenant, avec modifications de fichiers concretes.",
    "",
    "## OBJECTIF",
    goal,
    "",
    "## CONTRAINTES",
    constraints,
    contextBlock.trimEnd(),
    "",
    "## EXIGENCES D'EXECUTION",
    "- Lire les fichiers pertinents avant toute proposition.",
    "- Modifier le code directement (pas de plan theorique sans action).",
    "- Valider avec au moins une commande de verification (build/test/lint).",
    "- Si bloque: expliquer precisement le blocage et proposer la correction immediate.",
    "",
    "## LIVRABLES ATTENDUS",
    "1. Liste des fichiers modifies.",
    "2. Resume exact des changements.",
    "3. Resultat des verifications executees.",
    "4. Prochaine etape concrete.",
    "",
    "## FORMAT DE REPONSE",
    "ANALYSE:",
    "ACTIONS:",
    "VALIDATION:",
    "SUITE:",
  ].filter(Boolean).join("\n");
}

// ── Request handler ─────────────────────────────────────────
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  // CORS preflight — restrict to localhost only
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": `http://localhost:${PORT}`,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Auth-Token",
    });
    res.end();
    return;
  }

  try {
    // ── API routes ──
    if (pathname === "/api/agents" && method === "GET") {
      return json(res, apiAgents());
    }
    if (pathname.startsWith("/api/agents/") && pathname.endsWith("/runs") && method === "GET") {
      const agentId = pathname.split("/")[3];
      return json(res, apiAgentRuns(agentId));
    }
    if (pathname === "/api/stats" && method === "GET") {
      return json(res, apiStats());
    }
    if (pathname === "/api/errors" && method === "GET") {
      return json(res, apiErrors());
    }
    if (pathname === "/api/notes" && method === "GET") {
      return json(res, apiNotes());
    }
    if (pathname === "/api/scheduler" && method === "GET") {
      return json(res, apiScheduler());
    }
    if (pathname === "/api/learned" && method === "GET") {
      return json(res, apiLearnedPatterns());
    }
    if (pathname === "/api/learning" && method === "GET") {
      return json(res, apiLearningInsights());
    }
    if (pathname === "/api/chat/reset" && method === "POST") {
      if (!checkAuth(req, res)) return;
      // Reset dashboard sessions for fresh starts
      clearSession(KINGSTON_DASHBOARD_ID);
      clearSession(EMILE_DASHBOARD_ID);
      clearTurns(KINGSTON_DASHBOARD_ID);
      clearTurns(EMILE_DASHBOARD_ID);
      log.info("[dashboard] Reset Kingston + Émile sessions");
      return json(res, { ok: true, message: "Sessions reset" });
    }
    if (pathname === "/api/chat/kingston" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const response = await apiChatKingston(body.message as string);
      return json(res, { ok: true, response });
    }
    if (pathname === "/api/chat/emile" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const response = await apiChatEmile(body.message as string);
      return json(res, { ok: true, response });
    }
    if (pathname === "/api/chat" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const message = String(body.message || "").trim();
      const rawAgent = String(body.agent || "kingston").toLowerCase();
      const agent: DashboardAgent = rawAgent === "emile" ? "emile" : "kingston";
      if (!message) return sendJson(res, 400, { ok: false, error: "message is required" });
      const response = await apiChat(agent, message);
      return json(res, { ok: true, response, agent });
    }
    if (pathname === "/api/chat/ultimate-prompt" && method === "POST") {
      if (!checkAuth(req, res)) return;
      const body = await parseBody(req);
      const prompt = buildUltimatePrompt({
        goal: String(body.goal || ""),
        constraints: body.constraints ? String(body.constraints) : undefined,
        context: body.context ? String(body.context) : undefined,
        target: body.target === "emile" || body.target === "kingston" || body.target === "both"
          ? body.target
          : "both",
      });
      return json(res, { ok: true, prompt });
    }
    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { ok: false, error: "Not found" });
    }

    // ── Static files ──
    const resolved = path.resolve(STATIC_DIR, (pathname === "/" ? "index.html" : pathname).replace(/^\//, ""));
    // Prevent path traversal (resolve normalizes ../ sequences)
    if (!resolved.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    serveFile(res, resolved);
  } catch (err) {
    log.error("[dashboard] Request error:", err);
    sendJson(res, 500, { ok: false, error: (err as Error).message });
  }
}

// ── Start server ────────────────────────────────────────────
export function startDashboard(): void {
  const server = http.createServer(handleRequest);

  // Handle port conflicts gracefully (noServer prevents WSS from re-throwing)
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`[dashboard] Port ${PORT} already in use — dashboard not started`);
    } else {
      log.error("[dashboard] Server error:", err);
    }
  });

  // WebSocket: use noServer to prevent EADDRINUSE propagation
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    addClient(ws);
    log.debug(`[dashboard] WS client connected (${getClientCount()} total)`);
    ws.send(JSON.stringify({ event: "init", data: apiAgents(), ts: Date.now() }));
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    log.info(`[dashboard] UI available at http://localhost:${PORT} (localhost only)`);
  });
}

// Re-export broadcast for use by other modules
export { broadcast } from "./broadcast.js";




