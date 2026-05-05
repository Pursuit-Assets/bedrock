/**
 * Retry-with-exponential-backoff helper for transient-failure recovery.
 *
 * Used by the bulk Cleanup runners — Salesforce occasionally returns
 * 502/503 from its proxy under load, axios times out at the network
 * layer, or rate-limit (429) kicks in mid-burst. Retrying those is
 * idempotent for our use cases (PUT writes the same payload, DELETE
 * tolerates "already deleted").
 *
 * NOT retried: 4xx auth (401/403) or validation (400/422) — those
 * indicate user error or permission problems that won't be fixed by
 * trying again.
 */
import type { AxiosError } from "axios";

export interface RetryOptions {
  /** Total attempts including the first call. Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms — actual delay is base × 2^(attempt-1) ± 25% jitter. */
  baseDelayMs?: number;
  /** Cap on per-attempt delay so a long backoff doesn't drag forever. */
  maxDelayMs?: number;
}

const DEFAULT_OPTS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
};

/**
 * Run `fn`, retrying on transient errors. Throws the final error if
 * all attempts fail; throws non-transient errors immediately on the
 * first failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_OPTS, ...opts };

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientError(err) || attempt === maxAttempts) {
        throw err;
      }
      const delay = jitter(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws — but TS can't see it.
  throw lastError;
}

/**
 * Classify an axios / network error as "worth retrying". Errors we
 * keep for retry:
 *   - Network failures (no response received: DNS, connection refused,
 *     socket reset, axios ECONNABORTED on timeout)
 *   - 408 Request Timeout
 *   - 429 Too Many Requests
 *   - 502/503/504 from the gateway
 *
 * Everything else (400, 401, 403, 404, 409, 422, 5xx other than the
 * gateway family) bubbles up immediately so user-actionable issues
 * surface fast.
 */
export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const ax = err as AxiosError;
  // Network / timeout — no HTTP response at all.
  if (ax.code === "ECONNABORTED" || ax.code === "ERR_NETWORK") return true;
  if (!ax.response && ax.isAxiosError) return true;
  const status = ax.response?.status;
  if (status === 408 || status === 429) return true;
  if (status === 502 || status === 503 || status === 504) return true;
  return false;
}

/** ±25% jitter so concurrent retries don't synchronize and re-burst the API. */
function jitter(ms: number): number {
  const swing = ms * 0.25;
  return ms + (Math.random() * 2 - 1) * swing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
