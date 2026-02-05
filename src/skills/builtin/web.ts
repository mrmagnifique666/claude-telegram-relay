/**
 * Built-in skill: web.fetch
 * Fetch a URL and return its content as text (HTML stripped).
 */
import { registerSkill } from "../loader.js";

const MAX_BODY = 12000;

/**
 * Naive HTML tag stripper — removes tags and decodes common entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

registerSkill({
  name: "web.fetch",
  description: "Fetch a URL and return its text content (HTML tags stripped, truncated to ~12 KB).",
  argsSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
    },
    required: ["url"],
  },
  async execute(args): Promise<string> {
    const url = args.url as string;

    // Basic URL validation
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Error: invalid URL.";
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "Error: only HTTP/HTTPS URLs are allowed.";
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "ClaudeRelay/1.0" },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return `Error: HTTP ${res.status} ${res.statusText}`;
      }

      const contentType = res.headers.get("content-type") || "";
      const body = await res.text();

      let text: string;
      if (contentType.includes("text/html")) {
        text = stripHtml(body);
      } else {
        text = body;
      }

      if (text.length > MAX_BODY) {
        text = text.slice(0, MAX_BODY) + "\n...(truncated)";
      }

      return text || "(empty response)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
