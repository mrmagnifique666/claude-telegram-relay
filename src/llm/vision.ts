/**
 * Image analysis via Anthropic Messages API.
 * Uses Claude Haiku for fast, cheap vision tasks.
 * No extra dependencies — native fetch only.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

const VISION_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1024;
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT =
  "Décris précisément ce que tu vois dans cette image. Ne fabrique pas de détails. Si tu n'es pas sûr de quelque chose, dis-le. Réponds en français.";

/** Map file extension to MIME media type. */
function detectMediaType(
  filePath: string
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg"; // sensible fallback
  }
}

/**
 * Analyze an image using Claude's vision capabilities.
 * @param imagePath - Absolute path to the image file on disk.
 * @param userPrompt - Optional text prompt to guide the analysis.
 * @returns The text description from Claude, or an error string.
 */
export async function describeImage(
  imagePath: string,
  userPrompt: string
): Promise<string> {
  if (!config.anthropicApiKey) {
    return "Error: ANTHROPIC_API_KEY not configured for image analysis.";
  }

  // Read image as base64
  let imageData: string;
  try {
    const buffer = fs.readFileSync(imagePath);
    imageData = buffer.toString("base64");
  } catch (err) {
    log.error("[vision] Failed to read image file:", err);
    return `Error: impossible de lire le fichier image — ${(err as Error).message}`;
  }

  const mediaType = detectMediaType(imagePath);

  // Build content blocks
  const contentBlocks: unknown[] = [
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: imageData,
      },
    },
  ];

  if (userPrompt) {
    contentBlocks.push({ type: "text", text: userPrompt });
  }

  const body = {
    model: VISION_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: contentBlocks,
      },
    ],
  };

  try {
    log.info(`[vision] Calling ${VISION_MODEL} for ${path.basename(imagePath)} (${mediaType})`);

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error(`[vision] API error ${res.status}:`, errText);
      return `Error: Anthropic API returned ${res.status} — ${errText}`;
    }

    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content.find((b) => b.type === "text");
    return textBlock?.text ?? "Error: aucune réponse textuelle reçue.";
  } catch (err) {
    log.error("[vision] Request failed:", err);
    return `Error: échec de la requête vision — ${(err as Error).message}`;
  }
}
