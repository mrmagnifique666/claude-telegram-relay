/**
 * Gmail OAuth2 authentication — loads credentials/token, provides a lazy Gmail client.
 */
import fs from "node:fs";
import path from "node:path";
import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

let cachedClient: gmail_v1.Gmail | null = null;

interface Credentials {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

function resolveConfigPath(p: string): string {
  return path.resolve(p);
}

export function loadCredentials(): Credentials {
  const p = resolveConfigPath(config.gmailCredentialsPath);
  if (!fs.existsSync(p)) {
    throw new Error(`Gmail credentials not found at ${p}. Download from Google Cloud Console.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function loadToken(): Record<string, unknown> | null {
  const p = resolveConfigPath(config.gmailTokenPath);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveToken(token: Record<string, unknown>): void {
  const p = resolveConfigPath(config.gmailTokenPath);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2));
  log.info("[gmail] Token saved");
}

export function createOAuth2Client(credentials: Credentials, redirectUri?: string): OAuth2Client {
  const cred = credentials.installed || credentials.web;
  if (!cred) throw new Error("Invalid credentials.json — missing installed or web key");
  return new google.auth.OAuth2(cred.client_id, cred.client_secret, redirectUri || cred.redirect_uris[0]);
}

export function getAuthUrl(oauth2Client: OAuth2Client): string {
  return oauth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });
}

/**
 * Returns a ready-to-use Gmail API client (lazy singleton).
 * Auto-refreshes the token on use.
 */
export function getGmailClient(): gmail_v1.Gmail {
  if (cachedClient) return cachedClient;

  const credentials = loadCredentials();
  const token = loadToken();
  if (!token) {
    throw new Error("Gmail token not found. Run `npm run gmail:auth` first.");
  }

  const oauth2Client = createOAuth2Client(credentials);
  oauth2Client.setCredentials(token as any);

  // Auto-save refreshed tokens
  oauth2Client.on("tokens", (newTokens) => {
    const current = loadToken() || {};
    const merged = { ...current, ...newTokens };
    saveToken(merged);
    log.info("[gmail] Token auto-refreshed");
  });

  cachedClient = google.gmail({ version: "v1", auth: oauth2Client });
  log.info("[gmail] Client initialized");
  return cachedClient;
}
