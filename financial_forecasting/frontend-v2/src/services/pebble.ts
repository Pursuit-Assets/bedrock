/**
 * Pebble streaming client — SSE consumption for /api/pebble/ask.
 *
 * Turns the byte stream from FastAPI's StreamingResponse into typed
 * OrchestratorEvent records. Used by:
 *   - components/GlobalSearch.tsx (Ask mode in the omnibox modal)
 *   - pages/Pebble.tsx (full conversation page)
 *
 * Wire format (per pebble/orchestrator/sse.py):
 *   data: {"kind": "<kind>", "payload": <payload>}\n\n
 *   :keepalive\n\n        (comment frames; ignored by clients)
 *
 * Reuse rules:
 *   - Cancel via AbortController. AbortError swallowed; other errors
 *     surface as a synthetic { kind: 'error', payload: { phase: 'transport', reason: ... } }.
 *   - Bytes that arrive before a complete frame are buffered until the
 *     `\n\n` boundary so partial frames never produce broken JSON.
 *
 * Why a generator and not a callback bag: the consumer often wants
 * to `for await ... of` the stream and accumulate state with React's
 * useReducer. Generators compose cleanly with both that pattern and
 * raw callbacks.
 */

import type { OrchestratorEvent } from "@/types/pebble";

const ASK_ENDPOINT = "/api/pebble/ask";

interface AskInput {
  query: string;
  conversationId?: string;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Stream pebble events for one user query.
 *
 * Yields { kind, payload } records one at a time. Caller decides what
 * to do with each (render, persist, ignore). The generator returns
 * naturally when the server's stream ends; callers who want to
 * cancel mid-stream pass an AbortSignal.
 */
export async function* streamPebbleAsk(
  input: AskInput,
): AsyncGenerator<OrchestratorEvent, void, unknown> {
  const apiBase = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
  const url = `${apiBase}${ASK_ENDPOINT}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: input.query,
        conversation_id: input.conversationId,
        context: input.context ?? {},
      }),
      signal: input.signal,
    });
  } catch (e: unknown) {
    if (isAbort(e)) return;
    yield { kind: "error", payload: { phase: "transport", reason: "fetch_failed", detail: String(e) } };
    return;
  }

  if (!resp.ok) {
    yield {
      kind: "error",
      payload: {
        phase: "transport",
        reason: `http_${resp.status}`,
        status: resp.status,
      },
    };
    return;
  }
  if (!resp.body) {
    yield { kind: "error", payload: { phase: "transport", reason: "no_body" } };
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Split on SSE message boundary; the last element may be a
      // partial frame and gets re-buffered for the next read.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const raw of frames) {
        const ev = parseFrame(raw);
        if (ev !== null) yield ev;
      }
    }
    // Flush any final frame (rare; servers usually trail with \n\n)
    if (buffer.trim()) {
      const ev = parseFrame(buffer);
      if (ev !== null) yield ev;
    }
  } catch (e: unknown) {
    if (isAbort(e)) return;
    yield { kind: "error", payload: { phase: "transport", reason: "stream_failed", detail: String(e) } };
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Parse one SSE frame string. Returns null for comments / blanks /
 * malformed JSON (silently dropped — the generator continues).
 */
function parseFrame(raw: string): OrchestratorEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(":")) return null; // SSE comment / keepalive

  // Pull the data line(s). SSE allows multi-line `data:` continuation;
  // our server only ever emits single-line so we default to the simple
  // form, but stay defensive.
  const lines = trimmed.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).kind !== "string"
  ) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  // Trust the server's discriminator; widen via type assertion.
  // Runtime validation would catch upstream protocol drift but the
  // cost is per-frame work on the hot path. We rely on test cassettes
  // to catch shape regressions.
  return {
    kind: obj.kind as OrchestratorEvent["kind"],
    payload: (obj.payload || {}) as OrchestratorEvent["payload"],
  } as OrchestratorEvent;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
