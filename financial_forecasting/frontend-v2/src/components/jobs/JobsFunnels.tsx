import { useState } from "react";
import { ChevronRight, ChevronDown, ArrowUp, ArrowDown } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import {
  useJobsFunnel,
  type FunnelType,
  type FunnelStage,
  type FunnelProgression,
} from "@/services/jobs";
import { cn } from "@/lib/utils";

// ── Funnel-type config ─────────────────────────────────────────────────────

const FUNNEL_TABS: { type: FunnelType; label: string }[] = [
  { type: "opportunities", label: "Opportunities" },
  { type: "prospects", label: "Prospects" },
  { type: "builders", label: "Builders" },
];

const FUNNEL_TITLE: Record<FunnelType, string> = {
  opportunities: "Opportunities",
  prospects: "Prospects",
  builders: "Builders",
};

const FUNNEL_SUBTITLE: Record<FunnelType, string> = {
  opportunities: "Employer deals by stage · transitions in the last 30d",
  prospects: "Outreach contacts by stage",
  builders: "Builder applications by stage",
};

const FUNNEL_NOUN: Record<FunnelType, string> = {
  opportunities: "companies",
  prospects: "contacts",
  builders: "builders",
};

// Final/won stage keys per funnel — these render green.
const WON_STAGE_KEYS = new Set(["closed_won", "accepted"]);

const RECORD_CAP = 50;

// ── Component ───────────────────────────────────────────────────────────────

export function JobsFunnels() {
  const [funnel, setFunnel] = useState<FunnelType>("opportunities");
  const { data, isLoading } = useJobsFunnel(funnel);

  return (
    <div className="flex flex-col gap-4">
      {/* Funnel-type switcher */}
      <div className="inline-flex w-fit rounded-lg border border-border-strong bg-surface-2 p-1">
        {FUNNEL_TABS.map((tab) => {
          const active = tab.type === funnel;
          return (
            <button
              key={tab.type}
              type="button"
              onClick={() => setFunnel(tab.type)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                active
                  ? "bg-surface text-ink shadow-sm"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Funnel card */}
      <FunnelCard funnel={funnel} stages={data?.stages ?? []} isLoading={isLoading} />

      {/* Progression panel / muted notes */}
      {funnel === "opportunities" ? (
        <ProgressionPanel progression={data?.progression ?? []} isLoading={isLoading} />
      ) : (
        <p className="text-[11.5px] text-ink-3">
          Stage-change history isn't tracked for this funnel yet — counts
          reflect current state.
        </p>
      )}
    </div>
  );
}

// ── Funnel card ───────────────────────────────────────────────────────────

function FunnelCard({
  funnel,
  stages,
  isLoading,
}: {
  funnel: FunnelType;
  stages: FunnelStage[];
  isLoading: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      {/* Header bar */}
      <div className="border-b border-border-strong bg-surface-2 px-5 py-2">
        <div className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          {FUNNEL_TITLE[funnel]} Pipeline
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-3">
          {FUNNEL_SUBTITLE[funnel]}
        </div>
      </div>

      {/* Stage rows */}
      {isLoading ? (
        <div className="flex flex-col">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-t border-border-strong px-4 py-2 first:border-t-0"
            >
              <div className="h-3 w-3 flex-shrink-0 animate-pulse rounded bg-surface-2" />
              <div className="h-3 w-[180px] flex-shrink-0 animate-pulse rounded bg-surface-2" />
              <div className="h-2.5 w-[30%] animate-pulse rounded-full bg-surface-2" />
              <div className="ml-auto h-3 w-24 animate-pulse rounded bg-surface-2" />
            </div>
          ))}
        </div>
      ) : stages.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-4">
          No stages to display.
        </div>
      ) : (
        <div className="flex flex-col">
          {stages.map((stage) => {
            const isExpanded = expanded === stage.key;
            const isWon = WON_STAGE_KEYS.has(stage.key);
            const barColor = isWon ? "var(--green)" : "var(--accent)";

            return (
              <div key={stage.key}>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded(isExpanded ? null : stage.key)
                  }
                  className="flex w-full items-center gap-3 border-t border-border-strong px-4 py-2 text-left transition-colors hover:bg-surface-2/40 first:border-t-0"
                >
                  <span className="flex-shrink-0 text-ink-4">
                    {isExpanded ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </span>

                  <span
                    className="w-[180px] flex-shrink-0 truncate text-[12.5px] font-semibold text-ink"
                    title={stage.label}
                  >
                    {stage.label}
                  </span>

                  <div
                    className="h-2.5 flex-shrink-0 overflow-hidden rounded-full bg-surface-2"
                    style={{ width: "30%" }}
                    title={`${stage.count} ${FUNNEL_NOUN[funnel]} · ${Math.round(stage.pct_of_max)}% of largest stage`}
                  >
                    <div
                      className="h-full rounded-full transition-[width] duration-300"
                      style={{
                        width: `${stage.pct_of_max}%`,
                        backgroundColor: barColor,
                      }}
                    />
                  </div>

                  <div className="flex flex-1 items-center justify-end gap-2 text-[11.5px]">
                    <span className="text-ink-2">
                      <span className="font-mono font-semibold tabular-nums text-ink">
                        {stage.count}
                      </span>{" "}
                      {FUNNEL_NOUN[funnel]}
                    </span>
                    {stage.conversion_to_next != null ? (
                      <span
                        className="text-ink-3"
                        title="Conversion rate to next stage"
                      >
                        → {stage.conversion_to_next}% to next
                      </span>
                    ) : null}
                  </div>
                </button>

                {isExpanded ? <StageRecords stage={stage} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── Stage expand panel ──────────────────────────────────────────────────────

function StageRecords({ stage }: { stage: FunnelStage }) {
  const records = stage.records ?? [];
  const shown = records.slice(0, RECORD_CAP);
  const extra = records.length - shown.length;

  return (
    <div className="border-t border-border-strong bg-surface-2/30 px-5 py-3">
      {records.length === 0 ? (
        <div className="text-[12px] text-ink-3">No records.</div>
      ) : (
        <div className="flex flex-col gap-1">
          {shown.map((r, i) => (
            <div
              key={i}
              className="flex items-baseline gap-2 text-[12px]"
            >
              <span className="truncate font-medium text-ink">
                {r.name ?? "—"}
              </span>
              {r.detail ? (
                <span className="truncate text-[11px] text-ink-3">
                  — {r.detail}
                </span>
              ) : null}
            </div>
          ))}
          {extra > 0 ? (
            <div className="mt-1 text-[11px] text-ink-4">+{extra} more</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ── Progression panel (opportunities only) ──────────────────────────────────

function ProgressionPanel({
  progression,
  isLoading,
}: {
  progression: FunnelProgression[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-8 w-full animate-pulse rounded bg-surface-2"
          />
        ))}
      </div>
    );
  }

  if (progression.length === 0) {
    return (
      <p className="text-[11.5px] text-ink-3">
        No stage changes recorded in the last 30 days. Movement will appear
        here as the team updates opportunities in Bedrock.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        Recent Movement (30d)
      </div>
      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
        {progression.map((p, i) => {
          const advanced = p.direction === "advanced";
          const rel = relativeTime(p.when);
          return (
            <div
              key={i}
              className="flex items-center gap-3 border-t border-border-strong px-4 py-2 text-[12px] first:border-t-0"
            >
              <span className="min-w-[140px] flex-shrink-0 truncate font-medium text-ink">
                {p.name}
              </span>
              <span className="flex flex-1 items-center gap-1.5 text-ink-3">
                <span className="truncate">{p.from_label}</span>
                <span className="text-ink-4">→</span>
                <span className="truncate text-ink-2">{p.to_label}</span>
              </span>
              <span
                className={cn(
                  "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                  advanced
                    ? "bg-[var(--green-soft)] text-[var(--green)]"
                    : "bg-[var(--amber-soft)] text-[var(--amber)]",
                )}
              >
                {advanced ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                {advanced ? "advanced" : "regressed"}
              </span>
              {rel ? (
                <span className="w-[80px] flex-shrink-0 text-right text-[11px] text-ink-4">
                  {rel}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return formatDistanceToNow(t, { addSuffix: true });
}
