import { useMemo } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import { useOpportunities } from "@/services/opportunities";
import { useOwnerGoals } from "@/services/ownerGoals";
import { useActiveUsers } from "@/services/users";
import { AWARD_ELIGIBLE_STAGES } from "@/lib/stages";

const COLORS = {
  collected: "var(--green, #16a34a)",
  projected: "var(--amber, #f59e0b)",
  remaining: "var(--surface-2, #e5e7eb)",
};

export interface GoalTrackerProps {
  /** SF user id whose goal + opps to surface. Pass null for the team view. */
  filterUserId: string | null;
  className?: string;
}

/**
 * Annual goal donut + year-pace status. Sums revenue from opportunities
 * in `AWARD_ELIGIBLE_STAGES` (the same predicate that produces awards)
 * whose CloseDate falls within the current fiscal year (Jan 1 – Dec 31).
 *
 * Projection extrapolates the run-rate (collected / months-elapsed) to
 * 12 months. Status compares progress-to-goal vs. progress-through-year:
 * on-track / close / behind.
 *
 * Mirrors `frontend/src/components/GoalTracker.tsx:30–178` with v2
 * primitives + design tokens, sized for the home page's left rail.
 */
export function GoalTracker({ filterUserId, className }: GoalTrackerProps) {
  const oppsQ = useOpportunities();
  const goalsQ = useOwnerGoals();
  const usersQ = useActiveUsers();

  const isTeam = filterUserId == null;

  const goalAmount = useMemo(() => {
    const goals = goalsQ.data ?? [];
    if (isTeam) return goals.reduce((s, g) => s + (g.goal_amount ?? 0), 0);
    const personal = goals.find((g) => g.sf_user_id === filterUserId);
    return personal?.goal_amount ?? 0;
  }, [goalsQ.data, filterUserId, isTeam]);

  const ownerName = useMemo(() => {
    if (isTeam) return null;
    return (
      (usersQ.data ?? []).find((u) => u.Id === filterUserId)?.Name ?? null
    );
  }, [usersQ.data, filterUserId, isTeam]);

  const stats = useMemo(() => {
    const now = new Date();
    const fyStart = new Date(now.getFullYear(), 0, 1);
    const fyEnd = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    const fyLabel = `FY${String(now.getFullYear()).slice(-2)}`;

    const opps = (oppsQ.data ?? []).filter((o) => {
      if (!o.StageName || !AWARD_ELIGIBLE_STAGES.has(o.StageName)) return false;
      if (!isTeam && o.OwnerId !== filterUserId) return false;
      if (!o.CloseDate) return false;
      const d = new Date(o.CloseDate);
      return d >= fyStart && d <= fyEnd;
    });

    const collected = opps.reduce((s, o) => s + (o.Amount ?? 0), 0);
    const gPct = goalAmount > 0 ? collected / goalAmount : 0;

    const totalMs = fyEnd.getTime() - fyStart.getTime();
    const elapsedMs = now.getTime() - fyStart.getTime();
    const yPct = Math.max(0, Math.min(1, elapsedMs / totalMs));
    const monthsElapsed = Math.max(1, yPct * 12);
    const projected = (collected / monthsElapsed) * 12;
    const monthsRemaining = Math.max(0, Math.round((1 - yPct) * 12));

    let status: "on-track" | "close" | "behind";
    if (gPct >= yPct) status = "on-track";
    else if (gPct >= yPct * 0.75) status = "close";
    else status = "behind";

    return {
      collected,
      gPct,
      yPct,
      projected,
      monthsRemaining,
      status,
      fyLabel,
    };
  }, [oppsQ.data, goalAmount, filterUserId, isTeam]);

  const collectedClamped = Math.min(stats.collected, goalAmount || stats.collected);
  const projectedClamped = Math.min(stats.projected, goalAmount || stats.projected);
  const chart = [
    { name: "Collected", value: collectedClamped, fill: COLORS.collected },
    {
      name: "Projected",
      value: Math.max(0, projectedClamped - collectedClamped),
      fill: COLORS.projected,
    },
    {
      name: "Remaining",
      value: Math.max(0, (goalAmount || stats.collected) - projectedClamped),
      fill: COLORS.remaining,
    },
  ];

  const statusVariant = (
    stats.status === "on-track" ? "green" : stats.status === "close" ? "amber" : "red"
  ) as "green" | "amber" | "red";
  const statusLabel =
    stats.status === "on-track" ? "On track" : stats.status === "close" ? "Close" : "Behind pace";

  const heading = isTeam ? "Team goal" : ownerName ? `${ownerName}'s goal` : "My goal";
  const goalsLoading = goalsQ.isLoading || oppsQ.isLoading;
  const noGoalSet = !goalsLoading && goalAmount <= 0;

  if (noGoalSet) {
    return (
      <section
        className={cn(
          "flex flex-col gap-2 rounded-lg border border-dashed border-border-strong bg-surface p-4",
          className,
        )}
      >
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          {heading}
        </h2>
        <p className="text-[12.5px] text-ink-3">
          {isTeam
            ? "No team goals have been set for the current fiscal year."
            : "No revenue goal set for the current fiscal year."}
        </p>
        <a
          href="/settings"
          className="self-start text-[11.5px] font-medium text-accent-ink hover:underline"
        >
          Set a goal in Settings →
        </a>
      </section>
    );
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border-strong bg-surface p-4",
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          {heading}
        </h2>
        <Tag variant={statusVariant}>{statusLabel}</Tag>
      </header>

      <div className="flex items-center gap-4">
        <div className="relative h-32 w-32 flex-shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chart}
                cx="50%"
                cy="50%"
                innerRadius={46}
                outerRadius={62}
                dataKey="value"
                startAngle={90}
                endAngle={-270}
                stroke="none"
              >
                {chart.map((c, i) => (
                  <Cell key={i} fill={c.fill} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[18px] font-semibold leading-none text-ink">
              {fmtDollars(stats.collected)}
            </div>
            <div className="mt-1 text-[10.5px] text-ink-3">
              {Math.round(stats.gPct * 100)}% of {fmtDollars(goalAmount)}
            </div>
          </div>
        </div>

        <dl className="flex flex-1 flex-col gap-1.5 text-[11.5px]">
          <div className="flex items-baseline justify-between">
            <dt className="text-ink-3">FY</dt>
            <dd className="mono tabular-nums text-ink">{stats.fyLabel}</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-ink-3">Months left</dt>
            <dd className="mono tabular-nums text-ink">{stats.monthsRemaining}</dd>
          </div>
          <div className="flex items-baseline justify-between">
            <dt className="text-ink-3">Year elapsed</dt>
            <dd className="mono tabular-nums text-ink">
              {Math.round(stats.yPct * 100)}%
            </dd>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: COLORS.projected }}
              aria-hidden
            />
            <span className="text-ink-3">
              Projected{" "}
              <span className="mono font-medium tabular-nums text-ink">
                {fmtDollars(stats.projected)}
              </span>
            </span>
          </div>
        </dl>
      </div>
    </section>
  );
}

function fmtDollars(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}
