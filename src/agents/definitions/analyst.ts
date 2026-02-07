/**
 * Analyst Agent — performance analysis and reporting.
 * Heartbeat: 60 min. Schedule by cycle:
 *   Cycle 0: Daily Alpha Report (market.report)
 *   Cycle % 6 (~6h): Performance snapshot (analytics.report)
 *   Cycle % 24 (~24h): Deep analysis (bottlenecks, optimize)
 *   Sunday cycle % 24: Weekly deep dive complet
 *   Night (23h-7h): Maintenance tasks on idle cycles
 * Runs 24/7 — no quiet hours.
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";

const TZ = "America/Toronto";

function getCurrentHour(): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")!.value);
}

function isSunday(): boolean {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: TZ, weekday: "long" });
  return day === "Sunday";
}

function isNight(): boolean {
  const h = getCurrentHour();
  return h >= 23 || h < 7;
}

function buildAnalystPrompt(cycle: number): string | null {
  // Cycle 0: Daily Alpha Report (first fire of the day)
  if (cycle === 0) {
    return (
      `Cycle ${cycle} — Daily Alpha Report\n\n` +
      `Utilise le skill market.report pour générer le rapport marché pré-ouverture.\n` +
      `Si le marché est fermé (weekend), envoie un bref message disant que le marché est fermé.\n` +
      `Envoie le rapport à Nicolas via telegram.send.`
    );
  }

  // Sunday cycle % 24: Weekly deep dive (takes priority over regular deep analysis)
  if (cycle % 24 === 0 && isSunday()) {
    return (
      `Cycle ${cycle} — Weekly Deep Dive (Dimanche)\n\n` +
      `1. Utilise analytics.report avec timeframe='week' pour les stats de la semaine\n` +
      `2. Utilise learn.preferences pour voir les patterns appris\n` +
      `3. Utilise optimize.analyze sur les skills les plus utilisés\n` +
      `4. Utilise analytics.bottlenecks pour les goulots\n` +
      `5. Génère un rapport complet:\n` +
      `   📊 WEEKLY DEEP DIVE\n` +
      `   ✅ WINS (ce qui a bien fonctionné)\n` +
      `   📈 METRICS (skills, temps de réponse, erreurs)\n` +
      `   ⚠️ AMÉLIORATIONS (ce qui peut être mieux)\n` +
      `   🔧 OPTIMISATIONS (suggestions concrètes)\n` +
      `   🚀 PLAN (actions pour la semaine prochaine)\n` +
      `   CONFIANCE: X/10\n` +
      `6. Envoie le rapport à Nicolas via telegram.send`
    );
  }

  // Cycle % 24 (~24h): Deep analysis
  if (cycle % 24 === 0) {
    return (
      `Cycle ${cycle} — Deep Analysis\n\n` +
      `1. Utilise analytics.bottlenecks pour identifier les skills lents ou en erreur\n` +
      `2. Utilise optimize.suggest sur les skills problématiques identifiés\n` +
      `3. Utilise analytics.report avec timeframe='day' pour le snapshot quotidien\n` +
      `4. Génère un rapport bref:\n` +
      `   🔍 DAILY ANALYSIS\n` +
      `   Bottlenecks identifiés, optimisations suggérées, tendances\n` +
      `5. Log via analytics.log(skill='analyst.deep', outcome='success')\n` +
      `6. Envoie le rapport à Nicolas via telegram.send`
    );
  }

  // Cycle % 6 (~6h): Performance snapshot
  if (cycle % 6 === 0) {
    return (
      `Cycle ${cycle} — Performance Snapshot\n\n` +
      `1. Utilise analytics.report avec timeframe='today' pour un snapshot\n` +
      `2. Vérifie les métriques clés: temps moyen, taux d'erreur, skills populaires\n` +
      `3. Log via analytics.log(skill='analyst.snapshot', outcome='success')\n` +
      `4. Envoie un résumé concis (3-4 lignes) via telegram.send`
    );
  }

  // Night shifts: maintenance work on idle cycles (23h-7h)
  if (isNight()) {
    const nightRotation = cycle % 4;

    const nightPrompts: Record<number, string> = {
      0: // Error log review
        `Cycle ${cycle} — Night Maintenance: Error Review\n\n` +
        `1. Utilise errors.recent pour voir les erreurs non résolues\n` +
        `2. Analyse les patterns d'erreurs récurrentes\n` +
        `3. Si des erreurs simples sont résolues, utilise errors.resolve\n` +
        `4. Log via analytics.log(skill='analyst.night.errors', outcome='success')\n` +
        `5. Si des erreurs critiques trouvées, envoie un résumé via telegram.send. Sinon ne dérange pas Nicolas.`,

      1: // System health check
        `Cycle ${cycle} — Night Maintenance: System Health\n\n` +
        `1. Utilise system.health pour vérifier l'état du système\n` +
        `2. Utilise system.info pour les métriques mémoire/CPU\n` +
        `3. Log via analytics.log(skill='analyst.night.health', outcome='success')\n` +
        `4. Si problème critique détecté, envoie alerte via telegram.send. Sinon ne dérange pas Nicolas.`,

      2: // Data quality & notes review
        `Cycle ${cycle} — Night Maintenance: Data Review\n\n` +
        `1. Utilise notes.list pour voir les notes récentes\n` +
        `2. Vérifie la qualité des données: doublons, notes obsolètes\n` +
        `3. Utilise contacts.list pour vérifier les prospects récents du Scout\n` +
        `4. Log via analytics.log(skill='analyst.night.data', outcome='success')\n` +
        `5. Envoie un résumé bref via telegram.send seulement si anomalies trouvées.`,

      3: // Web research & trend analysis
        `Cycle ${cycle} — Night Maintenance: Research\n\n` +
        `1. Utilise web.search pour "AI agent trends 2026" ou "real estate technology news"\n` +
        `2. Cherche des opportunités ou menaces pour Kingston\n` +
        `3. Sauvegarde les insights pertinents via notes.add avec tag "night-research"\n` +
        `4. Log via analytics.log(skill='analyst.night.research', outcome='success')\n` +
        `5. Ne dérange pas Nicolas — les résultats seront dans le rapport du matin.`,
    };

    return nightPrompts[nightRotation] || null;
  }

  // Daytime idle cycles: no action needed
  return null;
}

export function createAnalystConfig(): AgentConfig {
  return {
    id: "analyst",
    name: "Analyst",
    role: "Performance analysis & reporting agent",
    heartbeatMs: config.agentAnalystHeartbeatMs,
    enabled: config.agentAnalystEnabled,
    chatId: 101, // Dedicated chatId — agents must NOT share Nicolas's Telegram chatId
    userId: config.voiceUserId,
    buildPrompt: buildAnalystPrompt,
  };
}
