/**
 * Scout Agent — autonomous prospecting and market intelligence.
 * 6-cycle rotation (30 min/cycle = 3h full rotation):
 *   0: LinkedIn prospecting (courtiers Gatineau/Ottawa)
 *   1: Reddit pain point mining
 *   2: Twitter trends monitoring
 *   3: Competitive intelligence
 *   4: Lead qualification (review prospects)
 *   5: Veille sectorielle (immobilier, assurance)
 * Runs 24/7 — no quiet hours.
 */
import type { AgentConfig } from "../base.js";
import { config } from "../../config/env.js";

function buildScoutPrompt(cycle: number): string | null {
  const rotation = cycle % 6;

  const prompts: Record<number, string> = {
    0: // LinkedIn Prospecting
      `Cycle ${cycle} — LinkedIn Prospecting (courtiers Gatineau/Ottawa)\n\n` +
      `1. Utilise web.search pour "courtier immobilier Gatineau 2026" ou "insurance broker Ottawa"\n` +
      `2. Identifie 2-3 prospects potentiels (nom, entreprise, spécialité)\n` +
      `3. Sauvegarde via contacts.add avec tags "prospect,linkedin,broker"\n` +
      `4. Log via analytics.log(skill='scout.linkedin', outcome='success')\n` +
      `5. Envoie un résumé concis (2-3 lignes) via telegram.send`,

    1: // Reddit Pain Point Mining
      `Cycle ${cycle} — Reddit Pain Point Mining\n\n` +
      `1. Utilise web.search pour "site:reddit.com real estate lead generation" ou "broker automation pain points"\n` +
      `2. Identifie 1-2 posts avec des pain points pertinents pour Kingston\n` +
      `3. Sauvegarde les insights dans notes.add avec tag "reddit-insight"\n` +
      `4. Log via analytics.log(skill='scout.reddit', outcome='success')\n` +
      `5. Envoie un résumé concis via telegram.send`,

    2: // Twitter Trends
      `Cycle ${cycle} — Twitter Trends Monitoring\n\n` +
      `1. Utilise web.search pour "twitter real estate AI trends 2026" ou "AI assistant broker news"\n` +
      `2. Identifie 1-2 tendances ou discussions pertinentes\n` +
      `3. Sauvegarde dans notes.add avec tag "twitter-trend"\n` +
      `4. Log via analytics.log(skill='scout.twitter', outcome='success')\n` +
      `5. Envoie un résumé concis via telegram.send`,

    3: // Competitive Intelligence
      `Cycle ${cycle} — Competitive Intelligence\n\n` +
      `1. Utilise web.search pour "AI answering service real estate 2026" ou "AI assistant broker competitors"\n` +
      `2. Identifie 1-2 concurrents ou nouvelles offres sur le marché\n` +
      `3. Sauvegarde dans notes.add avec tag "veille-concurrentielle"\n` +
      `4. Log via analytics.log(skill='scout.competitive', outcome='success')\n` +
      `5. Envoie un résumé concis via telegram.send`,

    4: // Lead Qualification
      `Cycle ${cycle} — Lead Qualification (review prospects)\n\n` +
      `1. Utilise contacts.search avec tag "prospect" pour lister les prospects récents\n` +
      `2. Pour chaque prospect sans score, évalue la pertinence (1-10) basée sur:\n` +
      `   - Secteur (immobilier/assurance = bonus)\n` +
      `   - Région (Gatineau/Ottawa = bonus)\n` +
      `   - Besoin potentiel d'automatisation\n` +
      `3. Identifie les prospects à relancer (ajoutés il y a >3 jours sans follow-up)\n` +
      `4. Log via analytics.log(skill='scout.qualify', outcome='success')\n` +
      `5. Envoie un résumé concis via telegram.send avec recommandations`,

    5: // Veille Sectorielle
      `Cycle ${cycle} — Veille Sectorielle (immobilier + assurance)\n\n` +
      `1. Utilise web.search pour "marché immobilier Gatineau Ottawa 2026" et "assurance courtier tendances"\n` +
      `2. Identifie 1-2 actualités ou changements réglementaires pertinents\n` +
      `3. Sauvegarde dans notes.add avec tag "veille-sectorielle"\n` +
      `4. Log via analytics.log(skill='scout.veille', outcome='success')\n` +
      `5. Envoie un résumé concis via telegram.send`,
  };

  return prompts[rotation] || null;
}

export function createScoutConfig(): AgentConfig {
  return {
    id: "scout",
    name: "Scout",
    role: "Prospecting & market intelligence agent",
    heartbeatMs: config.agentScoutHeartbeatMs,
    enabled: config.agentScoutEnabled,
    chatId: 100, // Dedicated chatId — agents must NOT share Nicolas's Telegram chatId
    userId: config.voiceUserId,
    buildPrompt: buildScoutPrompt,
    cycleCount: 6,
  };
}
