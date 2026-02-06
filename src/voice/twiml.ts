/**
 * Generates TwiML XML response for incoming Twilio calls.
 */
import { config } from "../config/env.js";

export function buildTwiml(): string {
  const streamUrl = config.voicePublicUrl
    ? `${config.voicePublicUrl.replace(/^http/, "ws")}/voice/stream`
    : `wss://localhost:${config.voicePort}/voice/stream`;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="alice" language="${config.voiceLanguage === "fr" ? "fr-FR" : "en-US"}">Bonjour, je suis Kingston.</Say>`,
    `  <Connect><Stream url="${streamUrl}" /></Connect>`,
    "</Response>",
  ].join("\n");
}
