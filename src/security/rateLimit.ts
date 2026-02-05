/**
 * Per-user rate limiter.
 * Simple token-bucket: 1 message per RATE_LIMIT_MS, burst of 3.
 */
import { config } from "../config/env.js";
import { log } from "../utils/log.js";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const BURST = 3;
const buckets = new Map<number, Bucket>();

/**
 * Returns true if the user is allowed to send a message right now.
 * Consumes one token on success.
 */
export function consumeToken(userId: number): boolean {
  const now = Date.now();
  let bucket = buckets.get(userId);

  if (!bucket) {
    bucket = { tokens: BURST, lastRefill: now };
    buckets.set(userId, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor(elapsed / config.rateLimitMs);
  if (refill > 0) {
    bucket.tokens = Math.min(BURST, bucket.tokens + refill);
    bucket.lastRefill += refill * config.rateLimitMs;
  }

  if (bucket.tokens <= 0) {
    log.debug(`Rate limited user ${userId}`);
    return false;
  }

  bucket.tokens -= 1;
  return true;
}
