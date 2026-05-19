import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Sparkles, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { streamPebbleAsk } from "@/services/pebble";
import type {
  Citation,
  OrchestratorEvent,
  PlanStep,
  StepStatus,
} from "@/types/pebble";

/**
 * Pebble Ask tab — single-turn streaming chat against /api/pebble/ask.
 *
 * Reducer pattern (lightweight, no Context yet — that's PR #184's job
 * if the engine merges): each frame from `streamPebbleAsk` updates
 * local state. We render the plan-as-todos card, accumulated tool
 * calls, and the streaming response.
 *
 * Stub-mode: if the first event back is `error{phase=transport}`, we
 * detect the engine isn't connected and show an offline banner. The
 * tab stays usable — the textarea is still focused and on retry will
 * try the engine again.
 */

type AskState =
  | { kind: "idle" }
  | { kind: "streaming"; query: string }
  | { kind: "done"; query: string }
  | { kind: "error"; query: string; reason: string };

interface PlanState {
  rationale: string;
  steps: Array<PlanStep & { status: StepStatus }>;
}

interface ResponseState {
  text: string;
  citations: Citation[];
  degraded: boolean;
}

interface PebbleAskTabProps {
  /** True when this tab is the visible one inside the floating box.
   *  Used to refocus the textarea on tab switch (the tab is mounted
   *  permanently to preserve state, so we can't rely on mount focus). */
  isActive?: boolean;
}

export function PebbleAskTab({ isActive = true }: PebbleAskTabProps) {
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<AskState>({ kind: "idle" });
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [response, setResponse] = useState<ResponseState | null>(null);
  const [costUsd, setCostUsd] = useState<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the textarea every time the tab becomes visible — keeps the
  // "open box → start typing" UX even after tab switches.
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus();
    }
  }, [isActive]);

  const reset = useCallback(() => {
    setState({ kind: "idle" });
    setPlan(null);
    setResponse(null);
    setCostUsd(0);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const submit = useCallback(async () => {
    const query = draft.trim();
    if (!query || state.kind === "streaming") return;
    setDraft("");
    reset();
    setState({ kind: "streaming", query });

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      for await (const ev of streamPebbleAsk({ query, signal: ctrl.signal })) {
        applyEvent(ev, { setPlan, setResponse, setCostUsd });
        if (ev.kind === "error") {
          setState({
            kind: "error",
            query,
            reason: ev.payload.reason ?? ev.payload.phase ?? "unknown",
          });
          return;
        }
        if (ev.kind === "response_final") {
          setState({ kind: "done", query });
          return;
        }
      }
      // Stream ended without a final event — treat as done.
      setState({ kind: "done", query });
    } catch (e) {
      setState({
        kind: "error",
        query,
        reason: e instanceof Error ? e.message : "stream_failed",
      });
    } finally {
      abortRef.current = null;
    }
  }, [draft, state.kind, reset]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const isStreaming = state.kind === "streaming";

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {state.kind === "idle" && !plan && !response ? (
          <EmptyState />
        ) : null}

        {state.kind !== "idle" ? (
          <div className="mb-2 rounded border border-border-strong bg-surface-2 px-2.5 py-1.5 text-[11.5px] text-ink-3">
            <span className="font-medium text-ink">You</span> · {state.query}
          </div>
        ) : null}

        {plan ? <PlanCard plan={plan} /> : null}

        {response ? (
          <ResponseCard response={response} streaming={isStreaming} />
        ) : null}

        {state.kind === "error" ? (
          <ErrorBanner reason={state.reason} onRetry={() => void submit()} />
        ) : null}
      </div>

      <footer className="flex flex-shrink-0 flex-col gap-1 border-t border-border-strong bg-surface-2 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask Pebble…  (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming}
            rows={2}
            className="min-h-[44px] flex-1 resize-y rounded border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={cancel}
              aria-label="Stop"
              className="grid h-9 w-9 place-items-center rounded bg-red-soft text-red hover:bg-red-soft/80"
              title="Stop streaming"
            >
              <X size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim()}
              aria-label="Send"
              className="grid h-9 w-9 place-items-center rounded bg-accent text-white hover:bg-accent-ink disabled:opacity-40"
              title="Send (Enter)"
            >
              <Send size={14} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between text-[10.5px] text-ink-3">
          <span>
            {isStreaming ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" /> streaming…
              </span>
            ) : state.kind === "done" ? (
              "ready · ask another"
            ) : state.kind === "error" ? (
              "error"
            ) : (
              "press Enter to send"
            )}
          </span>
          {costUsd > 0 ? (
            <span className="mono tabular-nums">
              ${costUsd.toFixed(4)}
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

// ── Event → state reducer ──────────────────────────────────────────

function applyEvent(
  ev: OrchestratorEvent,
  setters: {
    setPlan: React.Dispatch<React.SetStateAction<PlanState | null>>;
    setResponse: React.Dispatch<React.SetStateAction<ResponseState | null>>;
    setCostUsd: React.Dispatch<React.SetStateAction<number>>;
  },
) {
  switch (ev.kind) {
    case "plan_emitted": {
      setters.setPlan({
        rationale: ev.payload.rationale,
        steps: ev.payload.steps.map((s) => ({ ...s, status: "pending" })),
      });
      return;
    }
    case "tool_call_started": {
      setters.setPlan((prev) =>
        prev
          ? {
              ...prev,
              steps: prev.steps.map((s) =>
                s.step_id === ev.payload.step_id
                  ? { ...s, status: "in_progress" as const }
                  : s,
              ),
            }
          : prev,
      );
      return;
    }
    case "tool_call_finished": {
      setters.setPlan((prev) =>
        prev
          ? {
              ...prev,
              steps: prev.steps.map((s) =>
                s.step_id === ev.payload.step_id
                  ? {
                      ...s,
                      status: (ev.payload.ok ? "done" : "failed") as StepStatus,
                    }
                  : s,
              ),
            }
          : prev,
      );
      setters.setCostUsd((c) => c + (ev.payload.cost_usd ?? 0));
      return;
    }
    case "eval_emitted": {
      setters.setCostUsd((c) => c + (ev.payload.cost_usd ?? 0));
      return;
    }
    case "draft_emitted": {
      setters.setResponse({
        text: ev.payload.draft.text,
        citations: ev.payload.draft.citations,
        degraded: ev.payload.draft.degraded,
      });
      return;
    }
    case "response_final": {
      setters.setResponse({
        text: ev.payload.final.text,
        citations: ev.payload.final.citations,
        degraded: ev.payload.final.degraded,
      });
      return;
    }
    // Other events (replan_started, error) handled by the caller.
    default:
      return;
  }
}

// ── Sub-views ──────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-accent-soft">
        <Sparkles size={20} className="text-accent" />
      </div>
      <div className="text-[13px] font-medium text-ink">
        Ask Pebble anything
      </div>
      <ul className="space-y-1 text-[11.5px] text-ink-3">
        <li>"What's at risk in my Q3 pipeline?"</li>
        <li>"Draft a stewardship update for Goldman."</li>
        <li>"Where am I behind goal and what's the lift to catch up?"</li>
      </ul>
    </div>
  );
}

function PlanCard({ plan }: { plan: PlanState }) {
  return (
    <div className="mb-2 rounded border border-border-strong bg-surface px-2.5 py-2 text-[11.5px]">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          Plan
        </span>
        <span className="text-[10.5px] text-ink-3">
          {plan.steps.filter((s) => s.status === "done").length}/
          {plan.steps.length} done
        </span>
      </div>
      {plan.rationale ? (
        <p className="mb-1.5 text-ink-3">{plan.rationale}</p>
      ) : null}
      <ol className="flex flex-col gap-0.5">
        {plan.steps.map((s, i) => (
          <li
            key={s.step_id}
            className="flex items-center gap-1.5 text-[11.5px]"
          >
            <StepBullet status={s.status} index={i + 1} />
            <span
              className={cn(
                "truncate",
                s.status === "done" && "text-ink-3 line-through",
                s.status === "failed" && "text-red",
              )}
            >
              {s.tool}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StepBullet({ status, index }: { status: StepStatus; index: number }) {
  if (status === "in_progress") {
    return <Loader2 size={11} className="flex-shrink-0 animate-spin text-accent" />;
  }
  if (status === "done") {
    return (
      <span className="grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-full bg-green text-[8px] font-semibold text-white">
        ✓
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-full bg-red text-[8px] font-semibold text-white">
        !
      </span>
    );
  }
  return (
    <span className="grid h-3.5 w-3.5 flex-shrink-0 place-items-center rounded-full border border-border-strong bg-surface-2 text-[8px] font-medium text-ink-3">
      {index}
    </span>
  );
}

function ResponseCard({
  response,
  streaming,
}: {
  response: ResponseState;
  streaming: boolean;
}) {
  return (
    <div className="mb-2 rounded border border-accent/30 bg-accent-soft/30 px-2.5 py-2 text-[12.5px]">
      <div className="mb-1 flex items-center gap-1.5">
        <Sparkles size={11} className="text-accent" />
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-accent-ink">
          Pebble
        </span>
        {response.degraded ? (
          <span className="ml-1 rounded bg-amber-soft px-1.5 py-px text-[9.5px] font-medium text-amber">
            degraded
          </span>
        ) : null}
        {streaming ? (
          <Loader2 size={10} className="ml-1 animate-spin text-accent" />
        ) : null}
      </div>
      <p className="whitespace-pre-wrap leading-relaxed text-ink">
        {response.text}
        {streaming ? <span className="ml-0.5 animate-pulse">▌</span> : null}
      </p>
      {response.citations.length > 0 ? (
        <div className="mt-2 border-t border-border-strong/50 pt-1.5">
          <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-ink-3">
            Sources
          </div>
          <ul className="flex flex-col gap-0.5">
            {response.citations.map((c) => (
              <li key={c.cite_id} className="text-[10.5px]">
                <a
                  href={c.href}
                  className="text-accent-ink hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {c.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ErrorBanner({
  reason,
  onRetry,
}: {
  reason: string;
  onRetry: () => void;
}) {
  const offline =
    reason === "fetch_failed" ||
    reason.startsWith("http_404") ||
    reason.startsWith("http_502") ||
    reason.startsWith("http_503");
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded border border-amber/40 bg-amber-soft/40 px-2.5 py-2 text-[11.5px]"
    >
      <div className="flex-1">
        <div className="font-medium text-ink">
          {offline ? "Pebble engine is offline" : "Pebble couldn't respond"}
        </div>
        <div className="mt-0.5 text-ink-3">
          {offline
            ? "The /api/pebble/ask endpoint isn't reachable from this build. The Notes tab still works."
            : `reason: ${reason}`}
        </div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex-shrink-0 rounded border border-amber/60 bg-surface px-2 py-1 text-[11px] font-medium text-amber hover:bg-amber-soft"
      >
        Retry
      </button>
    </div>
  );
}
