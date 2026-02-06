/**
 * Voice HTTP + WebSocket server for Twilio integration.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";
import { buildTwiml } from "./twiml.js";
import { handleTwilioStream } from "./pipeline.js";

export function startVoiceServer(): void {
  if (!config.voiceEnabled) {
    log.info("[voice] Voice server disabled (VOICE_ENABLED=false)");
    return;
  }

  if (!config.deepgramApiKey) {
    log.warn("[voice] DEEPGRAM_API_KEY not set — voice server will not start");
    return;
  }
  if (!config.elevenlabsApiKey) {
    log.warn("[voice] ELEVENLABS_API_KEY not set — voice server will not start");
    return;
  }

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/voice/incoming") {
      const twiml = buildTwiml();
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(twiml);
      log.info("[voice] Served TwiML for incoming call");
      return;
    }

    if (req.method === "GET" && req.url === "/voice/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ server, path: "/voice/stream" });

  wss.on("connection", (ws) => {
    log.info("[voice] New Twilio WebSocket connection");
    handleTwilioStream(ws);
  });

  server.listen(config.voicePort, () => {
    log.info(`[voice] Server listening on port ${config.voicePort}`);
    log.info(`[voice] TwiML endpoint: POST /voice/incoming`);
    log.info(`[voice] Stream endpoint: WSS /voice/stream`);
    if (config.voicePublicUrl) {
      log.info(`[voice] Public URL: ${config.voicePublicUrl}`);
    }
  });
}
