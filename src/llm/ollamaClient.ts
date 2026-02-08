/**
 * Ollama client — lightweight local LLM tier for trivial tasks.
 * Uses the Ollama REST API (localhost:11434) with qwen2.5:14b or similar.
 * Never returns tool_call — always returns a simple text message.
 * Fallback to Haiku on failure is handled by the router.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

const SYSTEM_PROMPT = [
  "Tu es Kingston, un assistant IA personnel pour Nicolas.",
  "Tu es concis, amical et tu reponds en francais.",
  "Tu ne peux PAS executer d'outils ou de commandes — reponds uniquement avec du texte.",
  "Si on te demande quelque chose qui necessite un outil, dis que tu vas transmettre la demande.",
].join(" ");

export interface OllamaResult {
  type: "message";
  text: string;
}

/** Check if Ollama is reachable. Non-blocking, returns false on any error. */
export async function isOllamaAvailable(): Promise<boolean> {
  if (!config.ollamaEnabled) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/** Run a simple text prompt through Ollama. Never returns tool_call. */
export async function runOllama(chatId: number, message: string): Promise<OllamaResult> {
  const url = `${config.ollamaUrl}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    log.info(`[ollama] 🦙 Sending to ${config.ollamaModel} (chatId=${chatId}): ${message.slice(0, 80)}...`);

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        prompt: message,
        system: SYSTEM_PROMPT,
        stream: false,
        options: { temperature: 0.7, num_predict: 500 },
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`Ollama HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json() as { response?: string; error?: string };

    if (data.error) {
      throw new Error(`Ollama error: ${data.error}`);
    }

    const text = (data.response || "").trim();
    if (!text) {
      throw new Error("Ollama returned empty response");
    }

    log.info(`[ollama] 🦙 Response (${text.length} chars)`);
    return { type: "message", text };
  } finally {
    clearTimeout(timer);
  }
}
