import { Mail, Coffee, TrendingUp } from "lucide-react";
import { format } from "date-fns";

import {
  useThisWeekSummary,
  STAGE_LABELS,
  type JobStage,
  type WeekSummaryPerson,
  type WeekSummaryProgress,
} from "@/services/jobs";
import { BUBBLE_TONES, type BubbleTone } from "@/components/jobs/JobsStatBubble";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_ROWS = 4;

function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return format(t, "MMM d");
}

function stageLabel(key: string): string {
  return STAGE_LABELS[key as JobStage] ?? key.replace(/_/g, " ");
}

function personPrimary(p: WeekSummaryPerson): string {
  return p.name?.trim() || p.company?.trim() || p.email || "—";
}

function personSecondary(p: WeekSummaryPerson): string | null {
  // If we led with a name, the company is useful context underneath.
  if (p.name?.trim() && p.company?.trim()) return p.company.trim();
  return null;
}

// ── Group card ─────────────────────────────────────────────────────────────

function RecapGroup({
  tone,
  icon,
  title,
  count,
  isLoading,
  children,
  empty,
}: {
  tone: BubbleTone;
  icon: React.ReactNode;
  title: string;
  count: number;
  isLoading: boolean;
  children: React.ReactNode;
  empty: boolean;
}) {
  const spec = BUBBLE_TONES[tone];
  return (
    <div
      className="flex flex-1 flex-col gap-2.5 rounded-2xl border border-white/60 p-4"
      style={{
        background: spec.bg,
        boxShadow: "0 1px 2px rgba(20,18,14,0.04), 0 6px 18px -12px rgba(20,18,14,0.25)",
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg"
          style={{ color: spec.ink, background: spec.track }}
        >
          {icon}
        </span>
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: spec.ink }}
        >
          {title}
        </span>
        <span
          className="ml-auto inline-flex min-w-[22px] items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums"
          style={{ color: "#fff", background: spec.ring }}
        >
          {isLoading ? "·" : count}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-3.5 w-full animate-pulse rounded bg-white/60" />
          ))
        ) : empty ? (
          <span className="py-1 text-[11.5px] text-ink-3">Nothing yet this week.</span>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function RecapRow({
  primary,
  secondary,
  when,
}: {
  primary: React.ReactNode;
  secondary?: string | null;
  when: string | null;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="min-w-0 flex-1 truncate font-medium text-ink">
        {primary}
        {secondary ? (
          <span className="ml-1 font-normal text-ink-3">· {secondary}</span>
        ) : null}
      </span>
      {when ? (
        <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-ink-4">
          {when}
        </span>
      ) : null}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

export function ThisWeekRecap() {
  const { data, isLoading } = useThisWeekSummary();

  const emailed = data?.emailed ?? [];
  const met = data?.met ?? [];
  const progressed = data?.progressed ?? [];
  const counts = data?.counts ?? { emailed: 0, met: 0, progressed: 0 };

  function overflow(total: number, shown: number) {
    const extra = total - shown;
    return extra > 0 ? (
      <span className="pt-0.5 text-[10.5px] font-medium text-ink-4">
        +{extra} more
      </span>
    ) : null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          This Week
        </span>
        <span aria-hidden>🎉</span>
      </div>
      <div className="text-[11px] text-ink-4">
        A quick recap of the team's outreach and pipeline wins over the last 7 days.
      </div>

      <div className="mt-1 flex flex-col gap-3 sm:flex-row">
        <RecapGroup
          tone="sky"
          icon={<Mail size={13} />}
          title="Emailed"
          count={counts.emailed}
          isLoading={isLoading}
          empty={emailed.length === 0}
        >
          {emailed.slice(0, MAX_ROWS).map((p: WeekSummaryPerson, i) => (
            <RecapRow
              key={`${p.email}-${i}`}
              primary={personPrimary(p)}
              secondary={personSecondary(p)}
              when={fmtWhen(p.when)}
            />
          ))}
          {overflow(emailed.length, Math.min(emailed.length, MAX_ROWS))}
        </RecapGroup>

        <RecapGroup
          tone="violet"
          icon={<Coffee size={13} />}
          title="Met"
          count={counts.met}
          isLoading={isLoading}
          empty={met.length === 0}
        >
          {met.slice(0, MAX_ROWS).map((p: WeekSummaryPerson, i) => (
            <RecapRow
              key={`${p.email}-${i}`}
              primary={personPrimary(p)}
              secondary={personSecondary(p)}
              when={fmtWhen(p.when)}
            />
          ))}
          {overflow(met.length, Math.min(met.length, MAX_ROWS))}
        </RecapGroup>

        <RecapGroup
          tone="emerald"
          icon={<TrendingUp size={13} />}
          title="Progressed"
          count={counts.progressed}
          isLoading={isLoading}
          empty={progressed.length === 0}
        >
          {progressed.slice(0, MAX_ROWS).map((m: WeekSummaryProgress, i) => (
            <RecapRow
              key={`${m.account}-${i}`}
              primary={
                <span>
                  <span className="font-semibold">{m.account ?? "—"}</span>
                  <span className="font-normal text-ink-3">
                    {": "}
                    {stageLabel(m.from_stage)} → {stageLabel(m.to_stage)}
                  </span>
                </span>
              }
              when={fmtWhen(m.when)}
            />
          ))}
          {overflow(progressed.length, Math.min(progressed.length, MAX_ROWS))}
        </RecapGroup>
      </div>
    </div>
  );
}
