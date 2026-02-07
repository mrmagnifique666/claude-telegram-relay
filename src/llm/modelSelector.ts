/**
 * Model selector — picks the right Claude model tier based on task context.
 *
 * Tiers:
 *   haiku  — fast, cheap: greetings, acks, simple routing, tool chain follow-ups
 *   sonnet — balanced: most interactions, analysis, tool chains
 *   opus   — premium: content creation, strategic thinking, complex reasoning
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

export type ModelTier = "haiku" | "sonnet" | "opus";

export function getModelId(tier: ModelTier): string {
  switch (tier) {
    case "haiku": return config.claudeModelHaiku;
    case "sonnet": return config.claudeModelSonnet;
    case "opus": return config.claudeModelOpus;
  }
}

/**
 * Select the best model tier for a given message and context.
 */
export function selectModel(
  message: string,
  context: "user" | "scheduler" | "tool_followup" = "user"
): ModelTier {
  // Explicit override: [MODEL:opus], [MODEL:haiku], [MODEL:sonnet]
  const override = message.match(/\[MODEL:(haiku|sonnet|opus)\]/i);
  if (override) {
    const tier = override[1].toLowerCase() as ModelTier;
    log.debug(`[model] Explicit override: ${tier}`);
    return tier;
  }

  // Tool chain follow-ups — haiku is enough for routing tool results
  if (context === "tool_followup") {
    return "haiku";
  }

  // Scheduler events
  if (context === "scheduler" || message.startsWith("[SCHEDULER]") || message.startsWith("[HEARTBEAT")) {
    // Weekly self-review, alpha report → opus (quality reports)
    if (/self.review|alpha.report|weekly/i.test(message)) return "opus";
    // Heartbeat proactive actions → sonnet (needs reasoning)
    if (/HEARTBEAT PROACTIF/i.test(message)) return "sonnet";
    // Heartbeat checks, stability, digests → haiku (simple checks)
    if (/heartbeat|stability|digest/i.test(message)) return "haiku";
    // Briefings → sonnet
    return "sonnet";
  }

  // User messages — content creation → opus
  const contentKeywords = /\b(rédige|écris|compose|draft|poste|publie|article|post|tweet|linkedin.*post|moltbook.*post|email.*important|lettre|pitch|présentation|stratégi|analyse.*(approfondi|détaillé|complèt))\b/i;
  if (contentKeywords.test(message)) {
    log.debug(`[model] Content creation detected → opus`);
    return "opus";
  }

  // Simple/short messages → haiku
  const simplePatterns = /^(bonjour|salut|hey|hi|ok|oui|non|merci|thanks|ça va|parfait|super|cool|bye|bonne nuit|good)\b/i;
  if (simplePatterns.test(message.trim()) && message.length < 80) {
    log.debug(`[model] Simple message detected → haiku`);
    return "haiku";
  }

  // Questions about status, time, weather, simple facts → haiku
  const factualPatterns = /\b(quelle heure|what time|météo|weather|ping|status|combien|how many|quel jour|what day)\b/i;
  if (factualPatterns.test(message) && message.length < 150) {
    log.debug(`[model] Factual query detected → haiku`);
    return "haiku";
  }

  // Default: sonnet (balanced)
  return "sonnet";
}

/**
 * Get a human-readable label for logging.
 */
export function modelLabel(tier: ModelTier): string {
  const costs: Record<ModelTier, string> = {
    haiku: "💨",
    sonnet: "🎵",
    opus: "🎼",
  };
  return `${costs[tier]} ${tier}`;
}
