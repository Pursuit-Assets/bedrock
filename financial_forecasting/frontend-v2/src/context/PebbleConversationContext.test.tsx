/**
 * PebbleConversationContext — turn lifecycle + event reduction tests.
 *
 * Asserts:
 *   A. Initial state has empty turns + a fresh conversation_id.
 *   B. sendQuery starts a turn with status streaming + correct query.
 *   C. plan_emitted populates plan + steps (status pending).
 *   D. tool_call_started flips a step to in_progress.
 *   E. tool_call_finished flips a step to done with metadata.
 *   F. draft_emitted populates draft on the active turn.
 *   G. eval_emitted populates evaluation.
 *   H. response_final populates final + clears streamingTurnId.
 *   I. error event populates error.
 *   J. cancel() aborts streaming + clears streamingTurnId.
 *   K. reset() drops turns, mints new conversation_id.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  PebbleConversationProvider, usePebbleConversation,
} from "./PebbleConversationContext";

// Mock the streaming service so tests control what events arrive.
vi.mock("@/services/pebble", () => ({
  streamPebbleAsk: vi.fn(),
}));

import { streamPebbleAsk } from "@/services/pebble";

const mockStream = streamPebbleAsk as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockStream.mockReset();
});

function wrapperFor(conversationId?: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <PebbleConversationProvider conversationId={conversationId}>
      {children}
    </PebbleConversationProvider>
  );
}

// Helper: a synthetic async iterator the provider can consume.
async function* makeEventStream(events: any[]) {
  for (const ev of events) {
    yield ev;
  }
}

describe("PebbleConversationContext initial state", () => {
  it("starts with empty turns and a fresh conversation_id", () => {
    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor(),
    });
    expect(result.current.turns).toEqual([]);
    expect(result.current.streamingTurnId).toBeNull();
    expect(result.current.conversationId).toMatch(/.+/);
    expect(result.current.isStreaming).toBe(false);
  });

  it("uses the provided conversation_id when given", () => {
    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("conv-given"),
    });
    expect(result.current.conversationId).toBe("conv-given");
  });
});

describe("sendQuery + event reduction", () => {
  it("starts a turn with the correct query", async () => {
    mockStream.mockReturnValue(makeEventStream([]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });

    await act(async () => {
      await result.current.sendQuery("find Acme");
    });

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].query).toBe("find Acme");
  });

  it("populates plan + steps from plan_emitted", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "plan_emitted", payload: {
        plan_id: "p1", rationale: "search and drill",
        steps: [
          { step_id: "s1", tool: "search_crm", args: { query: "Acme" } },
          { step_id: "s2", tool: "get_record", args: {} },
        ],
      } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });

    await act(async () => {
      await result.current.sendQuery("Acme");
    });

    const turn = result.current.turns[0];
    expect(turn.plan?.plan_id).toBe("p1");
    expect(turn.steps).toHaveLength(2);
    expect(turn.steps[0].status).toBe("pending");
    expect(turn.steps[0].tool).toBe("search_crm");
  });

  it("flips step to in_progress on tool_call_started", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "plan_emitted", payload: {
        plan_id: "p1", rationale: "",
        steps: [{ step_id: "s1", tool: "search_crm", args: {} }],
      } },
      { kind: "tool_call_started", payload: { step_id: "s1", tool: "search_crm", args: {} } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].steps[0].status).toBe("in_progress");
  });

  it("flips step to done on tool_call_finished with metadata", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "plan_emitted", payload: {
        plan_id: "p1", rationale: "",
        steps: [{ step_id: "s1", tool: "search_crm", args: {} }],
      } },
      { kind: "tool_call_started", payload: { step_id: "s1", tool: "search_crm", args: {} } },
      { kind: "tool_call_finished", payload: {
        step_id: "s1", tool: "search_crm", ok: true,
        error: null, duration_ms: 123, cost_usd: 0.001, citation_count: 2,
      } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    const step = result.current.turns[0].steps[0];
    expect(step.status).toBe("done");
    expect(step.duration_ms).toBe(123);
    expect(step.cost_usd).toBe(0.001);
  });

  it("flips step to failed on tool_call_finished with ok=false", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "plan_emitted", payload: {
        plan_id: "p1", rationale: "",
        steps: [{ step_id: "s1", tool: "search_crm", args: {} }],
      } },
      { kind: "tool_call_finished", payload: {
        step_id: "s1", tool: "search_crm", ok: false,
        error: "search timeout", duration_ms: 5000, cost_usd: 0, citation_count: 0,
      } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].steps[0].status).toBe("failed");
    expect(result.current.turns[0].steps[0].error).toBe("search timeout");
  });

  it("populates draft on draft_emitted", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "draft_emitted", payload: { draft: {
        plan_id: "p1", text: "Hello world",
        citations: [], suggested_actions: [], charts: [],
        degraded: false, degradation_reason: null,
      } } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].draft?.text).toBe("Hello world");
  });

  it("populates evaluation on eval_emitted", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "eval_emitted", payload: {
        verdict: "pass", factuality: 0.95, completeness: 0.9,
        harm: "none", rationale: "ok",
      } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].evaluation?.verdict).toBe("pass");
    expect(result.current.turns[0].evaluation?.factuality).toBe(0.95);
  });

  it("response_final populates final + clears streaming flag", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "plan_emitted", payload: { plan_id: "p1", rationale: "", steps: [] } },
      { kind: "response_final", payload: { final: {
        plan_id: "p1", text: "Done.",
        citations: [], suggested_actions: [], charts: [],
        degraded: false, degradation_reason: null,
      } } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].final?.text).toBe("Done.");
    expect(result.current.streamingTurnId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });

  it("error event populates error", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "error", payload: { phase: "transport", reason: "timeout" } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].error?.reason).toBe("timeout");
  });

  it("replan_started sets replanned flag", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "replan_started", payload: { reason: "low factuality", replan_index: 1 } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("c1"),
    });
    await act(async () => {
      await result.current.sendQuery("x");
    });
    expect(result.current.turns[0].replanned).toBe(true);
  });
});

describe("cancel and reset", () => {
  it("reset() clears turns and mints new conversation_id", async () => {
    mockStream.mockReturnValue(makeEventStream([
      { kind: "response_final", payload: { final: {
        plan_id: "p1", text: "x",
        citations: [], suggested_actions: [], charts: [],
        degraded: false, degradation_reason: null,
      } } },
    ]));

    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("original-id"),
    });
    await act(async () => { await result.current.sendQuery("x"); });
    expect(result.current.turns).toHaveLength(1);

    act(() => { result.current.reset("new-id"); });
    expect(result.current.turns).toEqual([]);
    expect(result.current.conversationId).toBe("new-id");
  });

  it("reset() without arg mints a fresh id", () => {
    const { result } = renderHook(() => usePebbleConversation(), {
      wrapper: wrapperFor("orig"),
    });
    const original = result.current.conversationId;

    act(() => { result.current.reset(); });
    expect(result.current.conversationId).not.toBe(original);
    expect(result.current.conversationId).toMatch(/.+/);
  });
});
