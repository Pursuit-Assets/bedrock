import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import {
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  type PipelineStageSummary,
  type DealType,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

// ── Stage config ─────────────────────────────────────────────────────────────

type FunnelStage =
  | "lead_submitted"
  | "initial_outreach"
  | "active_in_discussions"
  | "active_opportunity_confirmed"
  | "active_builder_interview"
  | "closed_won";

const FUNNEL_STAGES: FunnelStage[] = [
  "lead_submitted",
  "initial_outreach",
  "active_in_discussions",
  "active_opportunity_confirmed",
  "active_builder_interview",
  "closed_won",
];

const STAGE_COLOR: Record<FunnelStage, string> = {
  lead_submitted:               "#94a3b8",
  initial_outreach:             "#60a5fa",
  active_in_discussions:        "#f59e0b",
  active_opportunity_confirmed: "#10b981",
  active_builder_interview:     "#059669",
  closed_won:                   "#16a34a",
};

const DEAL_TYPE_ORDER: DealType[] = [
  "ft",
  "pt_contract",
  "capstone",
  "volunteer",
  "workshop",
  "pilot",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtSalary(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtPct(num: number, den: number): string {
  if (den === 0) return "—";
  return `${Math.round((num / den) * 100)}%`;
}

// ── Expand panel ─────────────────────────────────────────────────────────────

function ExpandPanel({ summary }: { summary: PipelineStageSummary }) {
  const typeEntries = DEAL_TYPE_ORDER.filter(
    (t) => (summary.by_type[t] ?? 0) > 0,
  );

  return (
    <div className="border-t border-border-strong bg-surface-2/30 px-5 py-3">
      <div className="flex flex-wrap items-start gap-4">
        {/* Deal type mini table */}
        <div className="flex flex-col gap-1.5">
          <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
            Deal Type Breakdown
          </div>
          {typeEntries.length === 0 ? (
            <span className="text-[12px] text-ink-4">No type data</span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {typeEntries.map((t) => (
                <div
                  key={t}
                  className="inline-flex items-center gap-1.5 rounded border border-border-strong bg-surface px-2.5 py-1 text-[12px]"
                >
                  <span className="font-medium text-ink-2">
                    {DEAL_TYPE_LABELS[t]}
                  </span>
                  <span className="font-mono font-semibold tabular-nums text-ink">
                    {summary.by_type[t]} deal{(summary.by_type[t] ?? 0) !== 1 ? "s" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Avg salary — only when data present */}
        {summary.avg_salary != null ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Avg Salary
            </div>
            <span className="font-mono text-[15px] font-semibold tabular-nums text-[#16a34a]">
              {fmtSalary(summary.avg_salary)}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

interface JobsFunnelProps {
  pipeline: PipelineStageSummary[];
}

export function JobsFunnel({ pipeline }: JobsFunnelProps) {
  const [expanded, setExpanded] = useState<FunnelStage | null>(null);

  // Build a lookup from the incoming pipeline data (only for our 6 stages)
  const summaryMap = new Map<FunnelStage, PipelineStageSummary>();
  for (const s of pipeline) {
    if (FUNNEL_STAGES.includes(s.stage as FunnelStage)) {
      summaryMap.set(s.stage as FunnelStage, s);
    }
  }

  const rows = FUNNEL_STAGES.map((stage) => ({
    stage,
    summary: summaryMap.get(stage) ?? null,
    count: summaryMap.get(stage)?.total ?? 0,
  }));

  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      {/* Header bar — matches PipelineFunnel style exactly */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong bg-surface-2 px-5 py-2">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
            Pipeline Funnel
          </div>
          <div className="mt-0.5 text-[11.5px] text-ink-3">
            Active deal stages · volume &amp; stage-to-stage conversion
          </div>
        </div>
      </div>

      {/* Funnel rows */}
      <div className="flex flex-col">
        {rows.map(({ stage, summary, count }, idx) => {
          const isExpanded = expanded === stage;
          const widthPct = (count / maxCount) * 100;
          const color = STAGE_COLOR[stage];

          // Conversion rate to the next stage
          const nextCount = idx < rows.length - 1 ? rows[idx + 1].count : null;
          const conversionLabel =
            nextCount != null ? fmtPct(nextCount, count) : null;

          // Deal type pills (top 3 for the collapsed row)
          const typePills = DEAL_TYPE_ORDER.filter(
            (t) => (summary?.by_type[t] ?? 0) > 0,
          ).slice(0, 3);

          return (
            <div key={stage}>
              <button
                type="button"
                onClick={() => setExpanded(isExpanded ? null : stage)}
                className="flex w-full items-center gap-3 border-t border-border-strong px-4 py-2 text-left transition-colors hover:bg-surface-2/40 first:border-t-0"
              >
                {/* Chevron */}
                <span className="flex-shrink-0 text-ink-4">
                  {isExpanded ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </span>

                {/* Stage label — fixed width column */}
                <span
                  className="w-[190px] flex-shrink-0 truncate text-[12.5px] font-semibold text-ink"
                  title={STAGE_LABELS[stage]}
                >
                  {STAGE_LABELS[stage]}
                </span>

                {/* Proportional bar */}
                <div
                  className="h-2.5 flex-shrink-0 overflow-hidden rounded-full bg-surface-2"
                  style={{ width: "28%" }}
                  title={`${count} deals · ${Math.round(widthPct)}% of largest stage`}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${widthPct}%`, backgroundColor: color }}
                  />
                </div>

                {/* Count */}
                <span className="w-[64px] flex-shrink-0 text-right font-mono text-[13px] font-semibold tabular-nums text-ink">
                  {count} deal{count !== 1 ? "s" : ""}
                </span>

                {/* Conversion rate to next stage */}
                <span
                  className={cn(
                    "w-[52px] flex-shrink-0 text-right text-[11.5px] tabular-nums",
                    conversionLabel && conversionLabel !== "—"
                      ? "text-ink-3"
                      : "text-ink-4",
                  )}
                >
                  {conversionLabel != null ? (
                    <span title="Conversion rate to next stage">
                      → {conversionLabel}
                    </span>
                  ) : (
                    "—"
                  )}
                </span>

                {/* Deal type pills */}
                <span className="flex flex-1 flex-wrap items-center justify-end gap-1.5 overflow-hidden">
                  {typePills.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-3"
                    >
                      <span className="font-medium">{DEAL_TYPE_LABELS[t]}</span>
                      <span className="font-mono font-semibold tabular-nums text-ink">
                        {summary?.by_type[t]}
                      </span>
                    </span>
                  ))}

                  {/* avg_salary badge for closed_won */}
                  {stage === "closed_won" && summary?.avg_salary != null ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[10.5px]"
                      title="Average placed salary"
                    >
                      <span className="text-ink-3">avg</span>
                      <span className="font-mono font-semibold tabular-nums text-[#16a34a]">
                        {fmtSalary(summary.avg_salary)}
                      </span>
                    </span>
                  ) : null}
                </span>
              </button>

              {isExpanded && summary != null ? (
                <ExpandPanel summary={summary} />
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
