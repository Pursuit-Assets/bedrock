import { Fragment, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

import {
  useOutreachScorecard,
  type OutreachGranularity,
  type OutreachScorecard,
  type ScorecardRow,
  type ScorecardCell,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

// ── Period toggle ─────────────────────────────────────────────────────────────
const PERIODS: { id: OutreachGranularity; label: string }[] = [
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly" },
  { id: "month", label: "Monthly" },
];
const PERIOD_NOTE: Record<OutreachGranularity, string> = {
  day: "Today vs. Yesterday",
  week: "This Week vs. Last Week",
  month: "This Month vs. Last Month",
};

// ── Trend helpers (mirror the mockup's trendPct) ──────────────────────────────
function Trend({ current, prior }: { current: number; prior: number }) {
  if (prior === 0) return <span className="text-ink-4">—</span>;
  const v = (current - prior) / prior;
  const up = v >= 0;
  return (
    <span className={cn("font-semibold whitespace-nowrap", up ? "text-green" : "text-red")}>
      {up ? "▲" : "▼"} {(Math.abs(v) * 100).toFixed(1)}%
    </span>
  );
}

function TargetDelta({ actual, target }: { actual: number; target: number | null }) {
  if (target == null || target === 0) return <span className="text-ink-4">—</span>;
  return <Trend current={actual} prior={target} />;
}

// ── One expandable table ──────────────────────────────────────────────────────
function ScorecardTable({
  title,
  rows,
  idPrefix,
  firstColHeader,
  expanded,
  toggle,
}: {
  title: string;
  rows: ScorecardRow[];
  idPrefix: string;
  firstColHeader: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border-strong bg-surface">
      <div className="border-b border-border-strong bg-accent-soft px-4 py-3 text-[14px] font-bold text-accent-ink">
        {title}
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-surface-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            <th className="px-3.5 py-2.5 text-left font-bold">{firstColHeader}</th>
            <th className="px-3.5 py-2.5 text-right font-bold">This Period</th>
            <th className="px-3.5 py-2.5 text-right font-bold">Last Period</th>
            <th className="px-3.5 py-2.5 text-right font-bold">Trend</th>
            <th className="px-3.5 py-2.5 text-right font-bold">Δ Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const key = (r.stage ?? r.metric ?? String(idx));
            const id = `${idPrefix}-${key}`;
            const open = expanded.has(id);
            const isLast = idx === rows.length - 1;
            const subRows: { label: string; sel: (c: ScorecardCell) => number }[] = [
              { label: "Warm", sel: (c) => c.warm },
              { label: "Cold", sel: (c) => c.cold },
            ];
            return (
              <Fragment key={id}>
                <tr
                  onClick={() => toggle(id)}
                  className={cn(
                    "cursor-pointer text-[13.5px] hover:bg-surface-2",
                    !isLast && "border-b border-border-strong",
                    isLast && "bg-surface-2 font-bold",
                  )}
                >
                  <td className="px-3.5 py-2.5 text-left font-semibold">
                    <span className="mr-1 inline-block w-3.5 text-ink-4">
                      {open ? <ChevronDown size={12} className="inline" /> : <ChevronRight size={12} className="inline" />}
                    </span>
                    {r.label}
                  </td>
                  <td className="px-3.5 py-2.5 text-right tabular-nums">{r.this_period.total}</td>
                  <td className="px-3.5 py-2.5 text-right tabular-nums">{r.last_period.total}</td>
                  <td className="px-3.5 py-2.5 text-right text-[12.5px]">
                    <Trend current={r.this_period.total} prior={r.last_period.total} />
                  </td>
                  <td className="px-3.5 py-2.5 text-right text-[12.5px]">
                    <TargetDelta actual={r.this_period.total} target={r.target} />
                  </td>
                </tr>
                {open &&
                  subRows.map((sr) => (
                    <tr key={`${id}-${sr.label}`} className="bg-bg text-[12.5px] text-ink-3">
                      <td className="py-2 pl-9 pr-3.5 text-left font-medium">{sr.label}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums">{sr.sel(r.this_period)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums">{sr.sel(r.last_period)}</td>
                      <td className="px-3.5 py-2 text-right">
                        <Trend current={sr.sel(r.this_period)} prior={sr.sel(r.last_period)} />
                      </td>
                      <td className="px-3.5 py-2 text-right text-ink-4">—</td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function JobsOutreach() {
  const [granularity, setGranularity] = useState<OutreachGranularity>("week");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data, isLoading, isError } = useOutreachScorecard(granularity);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sc: OutreachScorecard | undefined = data;

  return (
    <div className="flex flex-col gap-4 pt-3">
      {/* Filter / period toggle */}
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <div className="flex rounded-lg border border-border-strong bg-surface p-1">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              onClick={() => setGranularity(p.id)}
              className={cn(
                "rounded-md px-3.5 py-1.5 text-[13px] transition-colors",
                granularity === p.id ? "bg-surface-2 font-semibold text-ink" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Section head */}
      <div className="flex items-baseline justify-between">
        <h2 className="text-[13px] font-bold uppercase tracking-wider text-ink-3">Scorecard</h2>
        <span className="text-[12.5px] text-ink-4">{PERIOD_NOTE[granularity]}</span>
      </div>

      {isError && (
        <div className="rounded-lg border border-red-soft bg-red-soft px-4 py-3 text-[13px] text-red">
          Couldn't load the scorecard. Try again in a moment.
        </div>
      )}
      {isLoading && !sc && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-64 animate-pulse rounded-xl border border-border-strong bg-surface-2" />
          ))}
        </div>
      )}

      {sc && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ScorecardTable
            title="User / Contact Pipeline"
            firstColHeader="Stage"
            rows={sc.user_pipeline}
            idPrefix="user"
            expanded={expanded}
            toggle={toggle}
          />
          <ScorecardTable
            title="Activity Pipeline"
            firstColHeader="Activity"
            rows={sc.activity_pipeline}
            idPrefix="act"
            expanded={expanded}
            toggle={toggle}
          />
        </div>
      )}

      <p className="text-[11px] italic text-ink-4">
        Warm = outreach to a company already known to Bedrock before the contact's first touch; Cold = the company's
        first appearance. Counts are flow (contacts entering a stage / activities logged in the period). Qualified Lead
        &amp; Committed populate once stage-entry tracking is live.
      </p>
    </div>
  );
}
