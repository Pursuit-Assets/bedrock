/**
 * Jobs · Opportunities — the employer-deal home.
 *
 * Renders one of two sub-views; the toggle that drives `sub` lives in the
 * page header (Jobs.tsx), to the right of the "Jobs Pipeline" title.
 *   • overview — weekly pipeline health (summary, aging, heatmaps, activity)
 *   • set      — the day-to-day deal list (JobsTeam)
 */
import { JobsOpportunitiesOverview } from "./JobsOpportunitiesOverview";
import { JobsTeam } from "./JobsTeam";

export type OppsSub = "overview" | "set";

export function JobsOpportunities({ sub }: { sub: OppsSub }) {
  return sub === "overview" ? <JobsOpportunitiesOverview /> : <JobsTeam />;
}
