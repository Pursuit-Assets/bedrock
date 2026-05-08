/**
 * PebbleConversationContext — single source of truth for the live
 * Pebble conversation state.
 *
 * Holds a list of `PebbleTurn`s and exposes:
 *   - sendQuery(text) — fires a new turn, streams events, mutates state.
 *   - cancel() — aborts the active stream (mode-switch, page nav).
 *   - reset(conversationId?) — start a new conversation.
 *
 * The reducer uses ts-discriminated event handling so a missed `kind`
 * is a compile-time error, not a runtime no-op.
 *
 * Scope shape: this provider is mounted inside `<PebblePage />` and
 * deliberately NOT at the App root. Conversation state is per-page;
 * other screens that briefly invoke the streaming service (e.g.
 * GlobalSearch's inline preview) don't need this provider — they can
 * call `streamPebbleAsk` directly and reduce locally.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo,
  useReducer, useRef,
} from "react";

import { streamPebbleAsk } from "@/services/pebble";
import type {
  OrchestratorEvent, PebbleTurn, StepStatus, StepView,
} from "@/types/pebble";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

interface State {
  conversationId: string;
  turns: PebbleTurn[];
  streamingTurnId: string | null;
}

type Action =
  | { type: "BEGIN_TURN"; turn: PebbleTurn }
  | { type: "EVENT"; turnId: string; event: OrchestratorEvent }
  | { type: "ABORT_TURN"; turnId: string }
  | { type: "RESET"; conversationId: string };

function makeUUID(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID — not perfect
  // collision-resistance but fine for client-side dedup.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "RESET":
      return {
        conversationId: action.conversationId,
        turns: [],
        streamingTurnId: null,
      };

    case "BEGIN_TURN":
      return {
        ...state,
        turns: [...state.turns, action.turn],
        streamingTurnId: action.turn.turn_id,
      };

    case "ABORT_TURN":
      return {
        ...state,
        streamingTurnId: state.streamingTurnId === action.turnId
          ? null
          : state.streamingTurnId,
        turns: state.turns.map((t) => t.turn_id !== action.turnId
          ? t
          : { ...t, finished_at: performance.now() }
        ),
      };

    case "EVENT":
      return {
        ...state,
        turns: state.turns.map((t) =>
          t.turn_id !== action.turnId ? t : applyEvent(t, action.event),
        ),
        streamingTurnId: action.event.kind === "response_final" || action.event.kind === "error"
          ? null
          : state.streamingTurnId,
      };
  }
}

function applyEvent(turn: PebbleTurn, ev: OrchestratorEvent): PebbleTurn {
  switch (ev.kind) {
    case "plan_emitted": {
      // Re-plans replace earlier steps with the new plan's steps.
      const steps: StepView[] = ev.payload.steps.map((s) => ({
        step_id: s.step_id,
        tool: s.tool,
        args: s.args,
        status: "pending" as StepStatus,
      }));
      return {
        ...turn,
        plan: ev.payload,
        steps,
        replanned: turn.replanned || Boolean(ev.payload.is_replan),
      };
    }
    case "tool_call_started": {
      return {
        ...turn,
        steps: turn.steps.map((s) => s.step_id === ev.payload.step_id
          ? { ...s, status: "in_progress" as StepStatus }
          : s,
        ),
      };
    }
    case "tool_call_finished": {
      return {
        ...turn,
        steps: turn.steps.map((s) => s.step_id === ev.payload.step_id
          ? {
              ...s,
              status: ev.payload.ok ? "done" as StepStatus : "failed" as StepStatus,
              duration_ms: ev.payload.duration_ms,
              cost_usd: ev.payload.cost_usd,
              error: ev.payload.error ?? undefined,
            }
          : s,
        ),
      };
    }
    case "draft_emitted": {
      return { ...turn, draft: ev.payload.draft };
    }
    case "eval_emitted": {
      return { ...turn, evaluation: ev.payload };
    }
    case "replan_started": {
      return { ...turn, replanned: true };
    }
    case "response_final": {
      return {
        ...turn,
        final: ev.payload.final,
        replanned: turn.replanned || Boolean(ev.payload.replanned),
        finished_at: performance.now(),
      };
    }
    case "error": {
      return {
        ...turn,
        error: ev.payload,
        finished_at: turn.finished_at ?? performance.now(),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface PebbleContextValue {
  conversationId: string;
  turns: PebbleTurn[];
  streamingTurnId: string | null;
  isStreaming: boolean;
  sendQuery: (query: string) => Promise<void>;
  cancel: () => void;
  reset: (conversationId?: string) => void;
}

const PebbleContext = createContext<PebbleContextValue | null>(null);

export function PebbleConversationProvider({
  children,
  conversationId,
}: {
  children: React.ReactNode;
  conversationId?: string;
}) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    conversationId: conversationId || makeUUID(),
    turns: [],
    streamingTurnId: null,
  }));

  const abortRef = useRef<AbortController | null>(null);

  // If the provider's `conversationId` prop changes (e.g. URL nav to
  // /pebble/c/<other-id>), reset state.
  useEffect(() => {
    if (conversationId && conversationId !== state.conversationId) {
      abortRef.current?.abort();
      dispatch({ type: "RESET", conversationId });
    }
    // intentionally not depending on state.conversationId — it's the
    // value we're conditionally syncing INTO.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Cancel in-flight stream on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const sendQuery = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;

    // Cancel any prior stream on this provider
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const turn: PebbleTurn = {
      turn_id: makeUUID(),
      query: trimmed,
      steps: [],
      replanned: false,
      started_at: performance.now(),
    };
    dispatch({ type: "BEGIN_TURN", turn });

    try {
      for await (const ev of streamPebbleAsk({
        query: trimmed,
        conversationId: state.conversationId,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        dispatch({ type: "EVENT", turnId: turn.turn_id, event: ev });
      }
    } catch (e: unknown) {
      // streamPebbleAsk yields error events for transport failures;
      // any uncaught throw here is exotic. Surface as final error event.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        dispatch({
          type: "EVENT",
          turnId: turn.turn_id,
          event: {
            kind: "error",
            payload: { phase: "client", reason: "uncaught", detail: String(e) },
          },
        });
      }
    }
  }, [state.conversationId]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    if (state.streamingTurnId) {
      dispatch({ type: "ABORT_TURN", turnId: state.streamingTurnId });
    }
  }, [state.streamingTurnId]);

  const reset = useCallback((newId?: string) => {
    abortRef.current?.abort();
    dispatch({ type: "RESET", conversationId: newId || makeUUID() });
  }, []);

  const value = useMemo<PebbleContextValue>(() => ({
    conversationId: state.conversationId,
    turns: state.turns,
    streamingTurnId: state.streamingTurnId,
    isStreaming: state.streamingTurnId !== null,
    sendQuery, cancel, reset,
  }), [state, sendQuery, cancel, reset]);

  return (
    <PebbleContext.Provider value={value}>{children}</PebbleContext.Provider>
  );
}

export function usePebbleConversation(): PebbleContextValue {
  const ctx = useContext(PebbleContext);
  if (!ctx) {
    throw new Error(
      "usePebbleConversation must be used inside <PebbleConversationProvider>",
    );
  }
  return ctx;
}
