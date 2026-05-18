import { useMemo } from "react";
import { AlertCircle, CalendarClock, Flame } from "lucide-react";

import { fmtMoneyFull } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useOpportunities } from "@/services/opportunities";
import { useMyTasks } from "@/services/tasks";

/**
 * At-a-glance status row for the home page header. Sourced from the same
 * queries the rest of the page uses (no extra fetches), so the chips
 * snap to the same values the modules below them show.
 *
 * Three signals chosen for the home surface — keep it terse:
 *   • Overdue tasks — what needs catching up
 *   • Closing this week — what to push
 *   • Weighted pipeline — running revenue forecast
 */
export function HomeStatsStrip({
  currentUserId,
  className,
}: {
  currentUserId: string | null;
  className?: string;
}) {
  const tasksQ = useMyTasks();
  const oppsQ = useOpportunities();

  const stats = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const overdueTasks = (tasksQ.data ?? []).filter((t) => {
      if (t.Status === "Completed" || t.IsClosed) return false;
      if (!t.ActivityDate) return false;
      return new Date(t.ActivityDate) < today;
    }).length;

    const myOpps = (oppsQ.data ?? []).filter((o) => {
      if (o.IsClosed) return false;
      if (currentUserId && o.OwnerId !== currentUserId) return false;
      return true;
    });

    const closingThisWeek = myOpps.filter((o) => {
      if (!o.CloseDate) return false;
      const d = new Date(o.CloseDate);
      return d >= today && d <= weekEnd;
    }).length;

    const weightedPipeline = myOpps.reduce((sum, o) => {
      const amount = o.Amount ?? 0;
      const prob =
        (o.Manager_Probability_Override__c ?? o.Probability ?? 0) / 100;
      return sum + amount * prob;
    }, 0);

    return { overdueTasks, closingThisWeek, weightedPipeline };
  }, [tasksQ.data, oppsQ.data, currentUserId]);

  const loading = tasksQ.isLoading || oppsQ.isLoading;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-[11.5px]",
        className,
      )}
      aria-live="polite"
    >
      <Chip
        icon={<AlertCircle size={12} className="text-red" />}
        label="Overdue tasks"
        value={loading ? "…" : String(stats.overdueTasks)}
        tone={stats.overdueTasks > 0 ? "red" : "neutral"}
      />
      <Chip
        icon={<CalendarClock size={12} className="text-amber" />}
        label="Closing this week"
        value={loading ? "…" : String(stats.closingThisWeek)}
        tone={stats.closingThisWeek > 0 ? "amber" : "neutral"}
      />
      <Chip
        icon={<Flame size={12} className="text-accent-ink" />}
        label="Weighted pipeline"
        value={loading ? "…" : fmtMoneyFull(stats.weightedPipeline)}
        tone="accent"
      />
    </div>
  );
}

function Chip({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "red" | "amber" | "accent" | "neutral";
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-2 py-1 font-medium",
        tone === "red" && "border-red/40 bg-red-soft/40 text-ink",
        tone === "amber" && "border-amber/40 bg-amber-soft/40 text-ink",
        tone === "accent" && "border-accent/30 bg-accent-soft/50 text-ink",
        tone === "neutral" && "border-border-strong bg-surface-2 text-ink-3",
      )}
    >
      {icon}
      <span className="text-ink-3">{label}</span>
      <span className="mono font-semibold tabular-nums text-ink">{value}</span>
    </div>
  );
}
