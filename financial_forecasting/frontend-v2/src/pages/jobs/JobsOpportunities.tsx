/**
 * Jobs · Opportunities — the employer-deal home.
 *
 * Wraps two sub-views behind a toggle:
 *   • Overview        — weekly pipeline health (summary, aging, heatmaps, …)
 *   • Opportunities set — the day-to-day deal list (JobsTeam)
 *
 * Reached from the left nav (Jobs → Opportunities). Deep-linkable via
 * ?view=opportunities&opps=overview|set.
 */
import { useSearchParams } from "react-router-dom";
import { useSessionState } from "@/lib/useSessionState";
import { cn } from "@/lib/utils";
import { JobsOpportunitiesOverview } from "./JobsOpportunitiesOverview";
import { JobsTeam } from "./JobsTeam";

type Sub = "overview" | "set";
const SUBS: { id: Sub; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "set", label: "Opportunities set" },
];

export function JobsOpportunities() {
  const [searchParams] = useSearchParams();
  const param = searchParams.get("opps");
  const initial: Sub = param === "set" || param === "overview" ? param : "overview";
  const [sub, setSub] = useSessionState<Sub>("jobs:opps-sub", initial);

  return (
    <div className="flex flex-col gap-4">
      <div className="inline-flex w-fit rounded-lg border border-border-strong bg-surface-2 p-1">
        {SUBS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSub(t.id)}
            className={cn(
              "rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors",
              sub === t.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "overview" ? <JobsOpportunitiesOverview /> : <JobsTeam />}
    </div>
  );
}
