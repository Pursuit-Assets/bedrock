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

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { CitationList } from "./CitationList";
import { ChartRenderer } from "./ChartRenderer";
import { PlanTrace } from "./PlanTrace";
import type { PebbleTurn } from "@/types/pebble";

export function ConversationView({
  turns, isStreaming, collapsed = false,
}: {
  turns: PebbleTurn[];
  isStreaming: boolean;
  collapsed?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // In deck (collapsed) mode, track which card the user has clicked
  // to "draw" out of the stack. Default null = compact deck only.
  const [drawnTurnId, setDrawnTurnId] = useState<string | null>(null);

  // Auto-scroll to bottom on turn count change OR while streaming
  // (only in expanded mode — deck mode keeps the latest card on top
  // anyway, no scroll needed).
  useEffect(() => {
    if (collapsed) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, isStreaming, collapsed]);

  // When the deck switches between collapsed/expanded, drop any
  // previously "drawn" card so we start fresh.
  useEffect(() => {
    setDrawnTurnId(null);
  }, [collapsed]);

  if (turns.length === 0) {
    return <EmptyState collapsed={collapsed} />;
  }

  if (collapsed) {
    return (
      <DeckView
        turns={turns}
        drawnTurnId={drawnTurnId}
        onDraw={setDrawnTurnId}
      />
    );
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

function EmptyState({ collapsed }: { collapsed: boolean }) {
  // In collapsed mode the deck area is narrow; keep the empty-state
  // copy short so it fits without wrapping awkwardly.
  if (collapsed) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center">
        <p className="text-[12px] text-ink-3">No turns yet — ask below.</p>
      </div>
    );
  }
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

// ---------------------------------------------------------------------------
// Deck-of-cards collapsed view.
//
// Each turn becomes a compact card. Cards stack vertically with a small
// vertical offset so the user can see the edge of every card in the
// stack — JP's spec: "don't hide it when collapsed". Newest turn sits
// on top of the deck (visually frontmost). Click any card to "draw" it
// out of the stack — the drawn card expands inline to show the full
// turn (plan, response, charts, citations) while the surrounding cards
// stay visible above and below.
//
// Why offset stacking instead of a flat list:
//   * Visually communicates "this is a deck" — turns feel like a
//     physical stack the user can flip through.
//   * Compact mode meaningfully shrinks the conversation surface so
//     the MessageInput area + sidebar can dominate. A flat list of
//     cards would just be the expanded view with smaller cards.
// ---------------------------------------------------------------------------

const CARD_PEEK_PX = 8;        // how much each card peeks above the next
const CARD_HEIGHT_PX = 56;     // compact card height when undrawn

function DeckView({
  turns, drawnTurnId, onDraw,
}: {
  turns: PebbleTurn[];
  drawnTurnId: string | null;
  onDraw: (id: string | null) => void;
}) {
  // Newest turn at the top of the visible stack (matches chat
  // convention of "most recent up top in collapsed view").
  const ordered = [...turns].reverse();
  return (
    <div className="flex-1 overflow-y-auto px-3 py-3">
      <ul className="mx-auto flex max-w-[420px] flex-col gap-0">
        {ordered.map((turn, i) => {
          const drawn = drawnTurnId === turn.turn_id;
          return (
            <li
              key={turn.turn_id}
              className={cn(
                // Negative margin = the deck-stack overlap. Drawn card
                // gets normal spacing so it doesn't visually overlap
                // its neighbors.
                "transition-all duration-150 ease-out",
                !drawn && i > 0 && `-mt-[${CARD_HEIGHT_PX - CARD_PEEK_PX * 2}px]`,
              )}
              style={
                !drawn && i > 0
                  ? { marginTop: -(CARD_HEIGHT_PX - CARD_PEEK_PX * 2) }
                  : undefined
              }
            >
              {drawn ? (
                <DrawnCard
                  turn={turn}
                  onClose={() => onDraw(null)}
                />
              ) : (
                <DeckCard
                  turn={turn}
                  stackIndex={i}
                  onClick={() => onDraw(turn.turn_id)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DeckCard({
  turn, stackIndex, onClick,
}: {
  turn: PebbleTurn;
  stackIndex: number;
  onClick: () => void;
}) {
  const isStreaming = !turn.finished_at;
  const isError = Boolean(turn.error);
  const isDegraded = Boolean(turn.final?.degraded);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Expand turn: ${turn.query.slice(0, 60)}`}
      className={cn(
        "group relative flex w-full items-center gap-2 overflow-hidden",
        "rounded-md border border-border-strong bg-surface px-3 text-left",
        "shadow-[0_1px_0_rgba(0,0,0,0.04)] hover:border-ink-3 hover:shadow-md",
        "transition-shadow duration-150",
      )}
      style={{
        height: CARD_HEIGHT_PX,
        // Slight z-stacking so the front card visually sits on top of
        // the cards below. Higher stackIndex = visually deeper.
        zIndex: 1000 - stackIndex,
      }}
    >
      <span className="flex-shrink-0">
        {isStreaming ? (
          <Loader2 size={12} className="animate-spin text-ink-3" />
        ) : isError ? (
          <AlertTriangle size={12} className="text-red-700" />
        ) : isDegraded ? (
          <AlertTriangle size={12} className="text-amber-700" />
        ) : (
          <Sparkles size={12} className="text-ink-3" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-2">
        {turn.query}
      </span>
      <span className="ml-auto flex flex-shrink-0 items-baseline gap-2 text-[11px] text-ink-4 tabular-nums">
        <span>{turn.steps.length}{turn.steps.length === 1 ? " step" : " steps"}</span>
        {turn.cost_usd > 0 ? <span>{formatCost(turn.cost_usd)}</span> : null}
      </span>
    </button>
  );
}

function DrawnCard({
  turn, onClose,
}: {
  turn: PebbleTurn;
  onClose: () => void;
}) {
  // The drawn card is essentially a TurnView with a small "tuck back
  // into deck" affordance at the top.
  return (
    <article className="rounded-md border border-ink-3 bg-surface px-4 py-3 shadow-md">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">
          Turn detail
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] font-medium text-ink-3 hover:text-ink"
          aria-label="Tuck card back into deck"
        >
          Tuck back ↑
        </button>
      </div>
      <TurnView turn={turn} />
    </article>
  );
}

function formatCost(cost: number): string {
  if (!cost) return "$0";
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(4)}`;
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
