/**
 * ConversationView — assembles a sequence of PebbleTurns into the
 * chat-style center column of the Pebble page.
 *
 * Each turn renders three vertical zones:
 *   1. User query (right-aligned bubble)
 *   2. Plan-as-todos card (collapsible, live during streaming)
 *   3. Assistant response (final.text + charts + citations)
 *
 * If the turn is degraded or errored, the response zone shows the
 * degradation banner above the text. This is the single place that
 * decides "what to show for a finished turn" — every other component
 * renders one piece in isolation.
 *
 * Auto-scroll to the bottom on new turn / new event so users see live
 * updates without manual scrolling.
 */

import { useEffect, useRef } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";

import { CitationList } from "./CitationList";
import { ChartRenderer } from "./ChartRenderer";
import { PlanTrace } from "./PlanTrace";
import type { PebbleTurn } from "@/types/pebble";

export function ConversationView({
  turns, isStreaming,
}: {
  turns: PebbleTurn[];
  isStreaming: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on turn count change OR while streaming.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, isStreaming]);

  if (turns.length === 0) {
    return <EmptyState />;
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto flex max-w-[800px] flex-col gap-6">
        {turns.map((turn) => (
          <TurnView key={turn.turn_id} turn={turn} />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="flex max-w-[480px] flex-col items-center gap-3 text-center">
        <div className="grid h-10 w-10 place-items-center rounded-full bg-surface-2">
          <Sparkles size={20} className="text-ink-3" aria-hidden="true" />
        </div>
        <h2 className="text-[16px] font-semibold text-ink">Ask Pebble</h2>
        <p className="text-[13px] text-ink-3">
          Ask about accounts, opportunities, or anything in the CRM. Try{" "}
          <code className="rounded bg-surface-2 px-1 py-px text-[12px]">/pipeline</code>{" "}
          for a weekly review.
        </p>
      </div>
    </div>
  );
}

function TurnView({ turn }: { turn: PebbleTurn }) {
  const final = turn.final;
  const hasError = Boolean(turn.error);
  const showStreaming = !turn.finished_at;

  return (
    <article className="flex flex-col gap-3">
      {/* User query — right-aligned chat bubble */}
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl bg-ink px-4 py-2 text-[13.5px] text-surface">
          {turn.query}
        </div>
      </div>

      {/* Plan-as-todos */}
      <PlanTrace turn={turn} />

      {/* Assistant response */}
      {(final || turn.draft || hasError) && (
        <div className="flex flex-col gap-2">
          {/* Degraded banner */}
          {final?.degraded && (
            <DegradedBanner reason={final.degradation_reason} />
          )}
          {hasError && !final && (
            <ErrorBanner phase={turn.error?.phase} reason={turn.error?.reason} />
          )}

          {/* Text */}
          <div className="prose-sm whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">
            {final?.text || turn.draft?.text || ""}
            {showStreaming && !final && !turn.draft && (
              <span className="text-ink-4">…</span>
            )}
          </div>

          {/* Charts */}
          {(final?.charts || turn.draft?.charts || []).length > 0 && (
            <div className="grid gap-3">
              {(final?.charts || turn.draft?.charts || []).map((c) => (
                <ChartRenderer key={c.chart_id} spec={c} />
              ))}
            </div>
          )}

          {/* Citations */}
          <CitationList citations={final?.citations || turn.draft?.citations || []} />
        </div>
      )}
    </article>
  );
}

function DegradedBanner({ reason }: { reason: string | null }) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
    >
      <AlertTriangle size={13} className="mt-px flex-shrink-0" aria-hidden="true" />
      <span>
        Pebble's answer is partial.
        {reason ? ` Reason: ${humanizeReason(reason)}.` : null}
      </span>
    </div>
  );
}

function ErrorBanner({ phase, reason }: { phase?: string; reason?: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-900"
    >
      <AlertTriangle size={13} className="mt-px flex-shrink-0" aria-hidden="true" />
      <span>
        Pebble couldn't finish this question.
        {phase || reason ? ` (${phase ?? "?"}${reason ? `: ${reason}` : ""})` : null}
      </span>
    </div>
  );
}

function humanizeReason(raw: string): string {
  // Translate a few known degradation_reason strings into something
  // user-readable. Unknown strings pass through verbatim.
  const map: Record<string, string> = {
    budget_exhausted: "I hit my per-conversation budget",
    pre_flight_rejected: "the question was too broad to fit my budget",
    empty_tool_results: "the tools didn't find anything",
    evaluator_abort: "my safety check flagged the answer",
    anthropic_unavailable: "the chat brain is offline",
    unknown_workflow_intent: "I don't know that workflow",
  };
  return map[raw] ?? raw;
}
