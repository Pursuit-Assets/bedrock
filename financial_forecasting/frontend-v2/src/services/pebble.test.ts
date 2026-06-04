/**
 * pebble service — SSE frame parsing + stream consumption.
 *
 * Asserts:
 *   A. Parses single {kind, payload} frame.
 *   B. Multiple frames in one chunk yield in order.
 *   C. Frame split across two chunks reassembles correctly.
 *   D. Comment lines (`:keepalive`) skipped.
 *   E. Malformed JSON skipped, generator continues.
 *   F. Missing `kind` field skipped.
 *   G. HTTP non-OK yields an error event then ends.
 *   H. AbortSignal stops iteration cleanly without error.
 *   I. Network exception yields error event.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { streamPebbleAsk } from "./pebble";

// Helper: build a fake Response with a controllable ReadableStream body.
function makeStreamResponse(chunks: Uint8Array[], status: number = 200): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const enc = new TextEncoder();

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("streamPebbleAsk", () => {
  it("yields a single frame correctly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([enc.encode('data: {"kind":"plan_emitted","payload":{"plan_id":"abc","steps":[],"rationale":"r"}}\n\n')]),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("plan_emitted");
    expect(events[0].payload.plan_id).toBe("abc");
  });

  it("yields multiple frames in order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([enc.encode(
        'data: {"kind":"plan_emitted","payload":{"plan_id":"a","steps":[],"rationale":""}}\n\n' +
        'data: {"kind":"draft_emitted","payload":{"draft":{"plan_id":"a","text":"Hello","citations":[],"suggested_actions":[],"charts":[],"degraded":false,"degradation_reason":null}}}\n\n' +
        'data: {"kind":"response_final","payload":{"final":{"plan_id":"a","text":"Hello","citations":[],"suggested_actions":[],"charts":[],"degraded":false,"degradation_reason":null}}}\n\n',
      )]),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events.map((e) => e.kind)).toEqual([
      "plan_emitted", "draft_emitted", "response_final",
    ]);
  });

  it("reassembles a frame split across chunks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([
        enc.encode('data: {"kind":"plan_emit'),
        enc.encode('ted","payload":{"plan_id":"x","steps":[],"rationale":""}}\n\n'),
      ]),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("plan_emitted");
    expect(events[0].payload.plan_id).toBe("x");
  });

  it("skips SSE comment frames (keepalives)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([enc.encode(
        ': keepalive\n\n' +
        'data: {"kind":"response_final","payload":{"final":{"plan_id":"a","text":"Done","citations":[],"suggested_actions":[],"charts":[],"degraded":false,"degradation_reason":null}}}\n\n',
      )]),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("response_final");
  });

  it("skips malformed JSON, continues with next frame", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([enc.encode(
        'data: {not json}\n\n' +
        'data: {"kind":"response_final","payload":{"final":{"plan_id":"a","text":"OK","citations":[],"suggested_actions":[],"charts":[],"degraded":false,"degradation_reason":null}}}\n\n',
      )]),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("response_final");
  });

  it("skips frames missing 'kind' field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([enc.encode(
        'data: {"payload":{}}\n\n' +
        'data: {"kind":"response_final","payload":{"final":{"plan_id":"a","text":"X","citations":[],"suggested_actions":[],"charts":[],"degraded":false,"degradation_reason":null}}}\n\n',
      )]),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("response_final");
  });

  it("yields error event on HTTP non-OK", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([], 503),
    );

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("error");
    expect(events[0].payload.phase).toBe("transport");
    expect(events[0].payload.status).toBe(503);
  });

  it("AbortSignal cancels cleanly without error event", async () => {
    const ac = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      ac.abort();
      throw new DOMException("aborted", "AbortError");
    });

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x", signal: ac.signal })) {
      events.push(ev);
    }
    // No events emitted, no error — clean abort
    expect(events).toEqual([]);
  });

  it("yields error event on network exception", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const events: any[] = [];
    for await (const ev of streamPebbleAsk({ query: "x" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("error");
    expect(events[0].payload.reason).toBe("fetch_failed");
  });

  it("posts query + conversation_id in JSON body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeStreamResponse([]),
    );

    for await (const _ of streamPebbleAsk({
      query: "find Acme",
      conversationId: "conv-123",
    })) {
      void _;
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "find Acme",
      conversation_id: "conv-123",
      context: {},
    });
  });
});
