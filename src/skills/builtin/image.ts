/**
 * Built-in skill: image.generate — AI image generation via Gemini API.
 * Generates an image, saves it locally, and sends it to the Telegram chat.
 */
import fs from "node:fs";
import path from "node:path";
import { registerSkill } from "../loader.js";
import { config } from "../../config/env.js";
import { getBotPhotoFn } from "./telegram.js";
import { log } from "../../utils/log.js";

const GEMINI_TIMEOUT_MS = 60_000;

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
  }>;
  error?: { message: string };
}

async function generateImage(prompt: string): Promise<{ filePath: string; textResponse?: string }> {
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const model = "gemini-2.0-flash-exp-image-generation";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as GeminiResponse;

  if (data.error) {
    throw new Error(`Gemini error: ${data.error.message}`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("Gemini returned no content");
  }

  // Find image and text parts
  const imagePart = parts.find((p) => p.inlineData?.data);
  const textPart = parts.find((p) => p.text);

  if (!imagePart?.inlineData) {
    throw new Error("Gemini returned no image data. Response: " + (textPart?.text || "empty").slice(0, 200));
  }

  // Save image to uploads
  const uploadsDir = path.resolve(config.uploadsDir);
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const ext = imagePart.inlineData.mimeType.includes("png") ? "png" : "jpg";
  const filename = `generated_${Date.now()}.${ext}`;
  const filePath = path.join(uploadsDir, filename);
  const buffer = Buffer.from(imagePart.inlineData.data, "base64");
  fs.writeFileSync(filePath, buffer);

  log.info(`[image] Generated ${filename} (${buffer.length} bytes)`);
  return { filePath, textResponse: textPart?.text };
}

registerSkill({
  name: "image.generate",
  description:
    "Generate an image using AI (Gemini) from a text prompt. The image is automatically sent to the Telegram chat.",
  argsSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description / prompt" },
      chatId: { type: "string", description: "Telegram chat ID to send the image to" },
    },
    required: ["prompt", "chatId"],
  },
  async execute(args): Promise<string> {
    const prompt = args.prompt as string;
    const chatId = Number((args.chatId ?? args.chat_id) as string);

    if (!chatId || isNaN(chatId)) {
      return "Error: invalid chatId.";
    }

    try {
      const { filePath, textResponse } = await generateImage(prompt);

      // Send to Telegram
      const sendPhoto = getBotPhotoFn();
      if (sendPhoto) {
        const caption = prompt.length > 200 ? prompt.slice(0, 197) + "..." : prompt;
        await sendPhoto(chatId, filePath, caption);
        // Clean up file after sending
        fs.unlinkSync(filePath);
        const extra = textResponse ? `\nGemini note: ${textResponse.slice(0, 200)}` : "";
        return `Image generated and sent to chat ${chatId}.${extra}`;
      }

      return `Image generated and saved to ${filePath} (bot not available to send).`;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return "Error: Gemini API request timed out (60s).";
      }
      return `Error generating image: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
