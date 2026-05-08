/**
 * PlanTrace — renders the plan-as-todos view for a Pebble turn.
 *
 * Shows each step as a checklist item with status:
 *   - pending      → empty circle
 *   - in_progress  → spinner
 *   - done         → check
 *   - failed       → x mark + error
 *
 * Header line shows the planner's rationale + cumulative metrics
 * (total cost, completed steps / planned). Collapsible — open by
 * default during streaming, collapsed once final shipped.
 *
 * Why visible: this is the "agent thinking" UX from the Anthropic
 * Architect curriculum's streaming-with-tool-calls pattern. Turns
 * the agent from a black box into a glass box; builds user trust;
 * highlights when the agent's slow because of a specific tool.
 */

import { useState } from "react";
import {
  AlertCircle, Check, ChevronDown, ChevronRight, Circle, Loader2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { PebbleTurn, StepStatus, StepView } from "@/types/pebble";

export function PlanTrace({ turn }: { turn: PebbleTurn }) {
  const isStreaming = !turn.finished_at;
  const [open, setOpen] = useState(isStreaming);

  if (!turn.plan && turn.steps.length === 0) {
    // No plan emitted (e.g. planner error path). Nothing to render.
    return null;
  }

  const completedCount = turn.steps.filter((s) => s.status === "done").length;
  const totalCost = turn.steps.reduce((acc, s) => acc + (s.cost_usd ?? 0), 0);

  return (
    <div className="rounded-md border border-border-strong bg-surface-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink-2 hover:bg-black/[0.03]"
        aria-expanded={open}
        aria-controls={`plan-trace-${turn.turn_id}`}
      >
        {open ? (
          <ChevronDown size={13} className="flex-shrink-0 text-ink-3" />
        ) : (
          <ChevronRight size={13} className="flex-shrink-0 text-ink-3" />
        )}
        <span className="flex-1 truncate">
          Plan{turn.replanned ? " (re-planned)" : ""}
          {turn.plan?.rationale ? ` — ${turn.plan.rationale}` : ""}
        </span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-[11px] text-ink-3 tabular-nums">
          <span>
            {completedCount}/{turn.steps.length}
          </span>
          {totalCost > 0 ? <span>${totalCost.toFixed(4)}</span> : null}
        </span>
      </button>

      {open && (
        <ol
          id={`plan-trace-${turn.turn_id}`}
          className="flex flex-col gap-0.5 border-t border-border-strong px-3 py-2"
        >
          {turn.steps.map((step) => (
            <Step key={step.step_id} step={step} />
          ))}
          {turn.evaluation ? (
            <li
              className={cn(
                "mt-2 border-t border-border-strong pt-2 text-[11.5px]",
                turn.evaluation.verdict === "pass" && "text-ink-3",
                turn.evaluation.verdict === "retry" && "text-amber-700",
                turn.evaluation.verdict === "abort" && "text-red-700",
              )}
            >
              <span className="font-medium">
                Eval: {turn.evaluation.verdict}
              </span>
              {" — "}
              factuality {turn.evaluation.factuality.toFixed(2)}, completeness{" "}
              {turn.evaluation.completeness.toFixed(2)}
              {turn.evaluation.rationale ? ` · ${turn.evaluation.rationale}` : ""}
            </li>
          ) : null}
        </ol>
      )}
    </div>
  );
}

function Step({ step }: { step: StepView }) {
  return (
    <li className="flex items-start gap-2 text-[12px]">
      <StepIcon status={step.status} />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="font-mono text-ink-2">{step.tool}</span>
        <span className="truncate text-ink-3">
          {summarizeArgs(step.args)}
        </span>
        {step.duration_ms != null ? (
          <span className="ml-auto flex-shrink-0 text-[11px] text-ink-4 tabular-nums">
            {step.duration_ms}ms
          </span>
        ) : null}
      </div>
      {step.error ? (
        <span className="text-[11px] text-red-700">{step.error}</span>
      ) : null}
    </li>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  const cls = "mt-px flex-shrink-0";
  switch (status) {
    case "pending":
      return <Circle size={11} className={cn(cls, "text-ink-4")} aria-label="pending" />;
    case "in_progress":
      return <Loader2 size={11} className={cn(cls, "animate-spin text-ink-2")} aria-label="in progress" />;
    case "done":
      return <Check size={11} className={cn(cls, "text-green-700")} aria-label="done" />;
    case "failed":
      return <AlertCircle size={11} className={cn(cls, "text-red-700")} aria-label="failed" />;
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    let str: string;
    if (typeof v === "string") str = v;
    else if (typeof v === "number" || typeof v === "boolean") str = String(v);
    else if (Array.isArray(v)) str = `[${v.length}]`;
    else str = "{…}";
    if (str.length > 30) str = str.slice(0, 30) + "…";
    parts.push(`${k}=${str}`);
    if (parts.join(", ").length > 80) break;
  }
  return parts.join(", ");
}
