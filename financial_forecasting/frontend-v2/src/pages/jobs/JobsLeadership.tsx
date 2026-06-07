import { useMemo, useState } from "react";
import { Users, Target, DollarSign, Building2, ChevronUp, ChevronDown } from "lucide-react";

import {
  useJobsPipeline,
  useJobsOpportunities,
  useContactsSummary,
  useMetricDrill,
  useJobRoles,
  ACTIVE_STAGES,
  DEAL_TYPE_LABELS,
  type PipelineStageSummary,
  type JobsOpportunity,
  type JobStage,
  type DealType,
  type JobRole,
  type RoleSegment,
} from "@/services/jobs";
import { cn } from "@/lib/utils";
import { JobsFunnel } from "@/components/jobs/JobsFunnel";
import { MetricDrawer } from "@/components/jobs/MetricDrawer";

// ── SOP targets ───────────────────────────────────────────────────────────

const TARGET_ACTIVE_ORGS_LO = 25;
const TARGET_ACTIVE_ORGS_HI = 30;
const TARGET_PLACEMENTS = 20;
const TARGET_AVG_SALARY = 85_000;
const OUTREACH_TO_CALL_LO = 0.20;
const OUTREACH_TO_CALL_HI = 0.25;
const ACTIVE_TO_INTERVIEW = 0.40;
const INTERVIEW_TO_PLACEMENT = 0.20;

// Owner display names keyed by email
const OWNER_DISPLAY: Record<string, string> = {
  "avni@pursuit.org": "Avni",
  "damon.kornhauser@pursuit.org": "Damon",
  "devika@pursuit.org": "Devika",
};
const TRACKED_OWNERS = Object.keys(OWNER_DISPLAY);

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtSalary(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function statusColor(value: number, lo: number): string {
  if (value >= lo) return "text-[var(--green)]";
  if (value >= lo * 0.75) return "text-[var(--amber)]";
  return "text-[var(--red)]";
}

function progressBarColor(value: number, lo: number): string {
  if (value >= lo) return "bg-[var(--green)]";
  if (value >= lo * 0.75) return "bg-[var(--amber)]";
  return "bg-[var(--red)]";
}

// ── Metric card ───────────────────────────────────────────────────────────

interface MetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  isLoading: boolean;
  target?: string;
  progress?: { value: number; max: number; colorClass: string };
  valueColor?: string;
  onClick?: () => void;
}

function MetricCard({
  icon,
  label,
  value,
  isLoading,
  target,
  progress,
  valueColor,
  onClick,
}: MetricCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex flex-col gap-3 rounded-[8px] border border-border-strong bg-surface p-5 shadow-[var(--shadow-sm)]",
        onClick && "cursor-pointer transition-colors hover:border-accent",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          {label}
        </span>
        <span className="text-ink-4">{icon}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span
          className={cn(
            "font-mono text-[28px] font-semibold leading-none tabular-nums",
            isLoading ? "text-ink-4" : (valueColor ?? "text-ink"),
          )}
        >
          {isLoading ? "—" : value}
        </span>
        {target ? (
          <span className="text-[11.5px] text-ink-3">{target}</span>
        ) : null}
      </div>
      {progress ? (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className={cn("h-full rounded-full", progress.colorClass)}
            style={{
              width: `${Math.min(100, (progress.value / progress.max) * 100)}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────

function SectionWrap({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {title}
      </div>
      {children}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

export function JobsLeadership() {
  const [openMetric, setOpenMetric] = useState<string | null>(null);

  const pipelineQ = useJobsPipeline();
  const oppsQ = useJobsOpportunities({ limit: 500 });
  const contactsQ = useContactsSummary();
  const candidatesSubmittedQ = useMetricDrill("candidates_submitted");
  const interviewingQ = useMetricDrill("interviewing");
  const rolesQ = useJobRoles();

  const isLoading = pipelineQ.isLoading || oppsQ.isLoading;

  // ── Derived pipeline metrics ────────────────────────────────────────────

  const stageMap = useMemo<Map<JobStage, PipelineStageSummary>>(() => {
    const m = new Map<JobStage, PipelineStageSummary>();
    for (const s of pipelineQ.data ?? []) {
      m.set(s.stage, s);
    }
    return m;
  }, [pipelineQ.data]);

  const activeOrgsCount = useMemo(() => {
    return ACTIVE_STAGES.reduce((sum, stage) => {
      return sum + (stageMap.get(stage)?.total ?? 0);
    }, 0);
  }, [stageMap]);

  const builderInterviewCount = useMemo(
    () => stageMap.get("active_builder_interview")?.total ?? 0,
    [stageMap],
  );

  const closedWonSummary = useMemo(
    () => stageMap.get("closed_won"),
    [stageMap],
  );
  const placementsCount = closedWonSummary?.total ?? 0;
  const avgSalary = closedWonSummary?.avg_salary ?? null;

  // ── Conversion rates (from pipeline summary totals) ─────────────────────

  const outreachTotal = stageMap.get("initial_outreach")?.total ?? 0;
  const callsTotal =
    (stageMap.get("active_in_discussions")?.total ?? 0) +
    (stageMap.get("active_opportunity_confirmed")?.total ?? 0) +
    (stageMap.get("active_builder_interview")?.total ?? 0);
  const outreachToCallRate = outreachTotal > 0 ? callsTotal / outreachTotal : null;

  const activeTotal = ACTIVE_STAGES.reduce(
    (s, stage) => s + (stageMap.get(stage)?.total ?? 0),
    0,
  );
  const interviewTotal = stageMap.get("active_builder_interview")?.total ?? 0;
  const activeToInterviewRate =
    activeTotal > 0 ? interviewTotal / activeTotal : null;
  const interviewToPlacementRate =
    interviewTotal > 0 ? placementsCount / interviewTotal : null;

  // ── Owner breakdown (from opportunities list) ───────────────────────────

  const ownerRows = useMemo(() => {
    const rawData = oppsQ.data as { data: JobsOpportunity[]; total: number } | undefined;
    const opps: JobsOpportunity[] = rawData?.data ?? [];

    return TRACKED_OWNERS.map((email) => {
      const owned = opps.filter((o) => o.owner_email === email);
      const totalActive = owned.filter((o) =>
        ACTIVE_STAGES.includes(o.stage as (typeof ACTIVE_STAGES)[number]),
      ).length;
      const inDiscussions = owned.filter(
        (o) => o.stage === "active_in_discussions",
      ).length;
      const builderInterview = owned.filter(
        (o) => o.stage === "active_builder_interview",
      ).length;
      const won = owned.filter((o) => o.stage === "closed_won").length;
      return { email, name: OWNER_DISPLAY[email] ?? email, totalActive, inDiscussions, builderInterview, won };
    });
  }, [oppsQ.data]);

  // ── Deal type breakdown for closed_won ─────────────────────────────────

  const dealTypeBreakdown = useMemo<Partial<Record<DealType, number>>>(() => {
    return closedWonSummary?.by_type ?? {};
  }, [closedWonSummary]);

  const dealTypeOrder: DealType[] = ["ft", "pt_contract", "capstone", "volunteer"];

  // ── Contacts & Outreach derived values ─────────────────────────────────

  const contactsLoading = contactsQ.isLoading;
  const totalLeads = contactsQ.data?.contacts.total ?? null;
  const engagedLeads = contactsQ.data?.contacts.engaged ?? null;
  const outreachAllTime = contactsQ.data?.activity.outreach_total ?? null;
  const outreachThisWeek = contactsQ.data?.activity.outreach_this_week ?? null;
  const callsAllTime = contactsQ.data?.activity.calls_total ?? null;
  const callsThisWeek = contactsQ.data?.activity.calls_this_week ?? null;

  // ── Salary color ────────────────────────────────────────────────────────

  const salaryColor =
    avgSalary == null
      ? "text-ink-4"
      : avgSalary >= TARGET_AVG_SALARY
        ? "text-[var(--green)]"
        : avgSalary >= TARGET_AVG_SALARY * 0.9
          ? "text-[var(--amber)]"
          : "text-[var(--red)]";

  return (
    <div className="flex flex-col gap-8">
      {/* ── Prospects ─────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Prospects
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            onClick={() => setOpenMetric("total_leads")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Total Leads
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {contactsLoading ? "—" : (totalLeads ?? "—")}
            </span>
          </div>
          <div
            onClick={() => setOpenMetric("engaged_leads")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Engaged Leads
            </span>
            <span className="text-[10.5px] text-ink-4 -mt-1">
              Received an initial email and beyond
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {contactsLoading ? "—" : (engagedLeads ?? "—")}
            </span>
          </div>
        </div>
      </div>

      {/* ── Employer Outreach ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Employer Outreach
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div
            onClick={() => setOpenMetric("outreach_week")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              All Outreach
            </span>
            <span className="text-[10.5px] text-ink-4 -mt-1">in last week</span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {contactsLoading ? "—" : (outreachThisWeek ?? "—")}
            </span>
            <span className="text-[10.5px] text-ink-4">
              {contactsLoading ? "—" : `${outreachAllTime ?? "—"} all time`}
            </span>
          </div>
          <div
            onClick={() => setOpenMetric("calls_total")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Calls in total
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {contactsLoading ? "—" : (callsAllTime ?? "—")}
            </span>
          </div>
          <div
            onClick={() => setOpenMetric("calls_week")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Calls in last week
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {contactsLoading ? "—" : (callsThisWeek ?? "—")}
            </span>
          </div>
        </div>
      </div>

      {/* ── Active Engagements ────────────────────────────────────────── */}
      <div className="flex flex-col gap-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Active Engagements
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            onClick={() => setOpenMetric("active_companies")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Active Companies
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {isLoading ? "—" : activeOrgsCount}
            </span>
          </div>
          <div
            onClick={() => setOpenMetric("in_discussion")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              In Discussion
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {isLoading ? "—" : (stageMap.get("active_in_discussions")?.total ?? 0)}
            </span>
          </div>
          <div
            onClick={() => setOpenMetric("candidates_submitted")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Companies with Candidates Submitted
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {candidatesSubmittedQ.isLoading ? "—" : (candidatesSubmittedQ.data?.count ?? 0)}
            </span>
          </div>
          <div
            onClick={() => setOpenMetric("interviewing")}
            className="flex cursor-pointer flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-accent"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Companies Interviewing Builders
            </span>
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {interviewingQ.isLoading ? "—" : (interviewingQ.data?.count ?? 0)}
            </span>
          </div>
        </div>
      </div>

      {/* ── KPI cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          icon={<Building2 size={15} />}
          label="Active Orgs"
          value={activeOrgsCount}
          isLoading={isLoading}
          onClick={() => setOpenMetric("active_orgs")}
          target={`Target: ${TARGET_ACTIVE_ORGS_LO}–${TARGET_ACTIVE_ORGS_HI}`}
          progress={{
            value: activeOrgsCount,
            max: TARGET_ACTIVE_ORGS_HI,
            colorClass: progressBarColor(activeOrgsCount, TARGET_ACTIVE_ORGS_LO),
          }}
          valueColor={statusColor(activeOrgsCount, TARGET_ACTIVE_ORGS_LO)}
        />
        <MetricCard
          icon={<Users size={15} />}
          label="Builder Interviews"
          value={builderInterviewCount}
          isLoading={isLoading}
          onClick={() => setOpenMetric("builder_interviews")}
          target="Target: 2–3 per week"
        />
        <MetricCard
          icon={<Target size={15} />}
          label="Placements This Cycle"
          value={placementsCount}
          isLoading={isLoading}
          onClick={() => setOpenMetric("placements")}
          target={`Target ${TARGET_PLACEMENTS} by end of July`}
          progress={{
            value: placementsCount,
            max: TARGET_PLACEMENTS,
            colorClass: progressBarColor(placementsCount, TARGET_PLACEMENTS * 0.7),
          }}
          valueColor={statusColor(placementsCount, TARGET_PLACEMENTS * 0.7)}
        />
        <MetricCard
          icon={<DollarSign size={15} />}
          label="Avg Placed Salary"
          value={fmtSalary(avgSalary)}
          isLoading={isLoading}
          target={`Target ${fmtSalary(TARGET_AVG_SALARY)}+`}
          valueColor={salaryColor}
        />
      </div>

      {/* ── Jobs funnel ───────────────────────────────────────────────── */}
      <JobsFunnel pipeline={pipelineQ.data ?? []} />

      {/* ── Conversion rates ──────────────────────────────────────────── */}
      <SectionWrap title="Conversion Rates">
        <div className="rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-5 py-2 text-left font-semibold">Metric</th>
                <th className="px-5 py-2 text-right font-semibold">Actual</th>
                <th className="px-5 py-2 text-right font-semibold">Target</th>
                <th className="w-[140px] px-5 py-2 text-left font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              <ConversionRow
                label="Outreach → Call"
                rate={outreachToCallRate}
                targetLo={OUTREACH_TO_CALL_LO}
                targetHi={OUTREACH_TO_CALL_HI}
                targetLabel="20–25%"
                isLoading={isLoading}
              />
              <ConversionRow
                label="Active → Builder Interview"
                rate={activeToInterviewRate}
                targetLo={ACTIVE_TO_INTERVIEW}
                targetLabel="40%"
                isLoading={isLoading}
              />
              <ConversionRow
                label="Interview → Placement"
                rate={interviewToPlacementRate}
                targetLo={INTERVIEW_TO_PLACEMENT}
                targetLabel="20%"
                isLoading={isLoading}
              />
            </tbody>
          </table>
        </div>
      </SectionWrap>

      {/* ── Owner breakdown ────────────────────────────────────────────── */}
      <SectionWrap title="Owner Breakdown">
        <div className="rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-5 py-2 text-left font-semibold">Owner</th>
                <th className="px-5 py-2 text-right font-semibold">Total Active</th>
                <th className="px-5 py-2 text-right font-semibold">In Discussions</th>
                <th className="px-5 py-2 text-right font-semibold">Builder Interview</th>
                <th className="px-5 py-2 text-right font-semibold">Won</th>
              </tr>
            </thead>
            <tbody>
              {oppsQ.isLoading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <tr key={i} className="border-t border-border-strong">
                      {Array.from({ length: 5 }).map((_, j) => (
                        <td key={j} className="px-5 py-3">
                          <div className="h-3 animate-pulse rounded bg-surface-2" />
                        </td>
                      ))}
                    </tr>
                  ))
                : ownerRows.map((row) => (
                    <tr
                      key={row.email}
                      className="border-t border-border-strong hover:bg-surface-2/40"
                    >
                      <td className="px-5 py-2.5 font-medium text-ink">
                        {row.name}
                        <span className="ml-1.5 text-[11px] text-ink-4">
                          {row.email}
                        </span>
                      </td>
                      <td className="font-mono px-5 py-2.5 text-right tabular-nums text-ink">
                        {row.totalActive}
                      </td>
                      <td className="font-mono px-5 py-2.5 text-right tabular-nums text-ink-2">
                        {row.inDiscussions}
                      </td>
                      <td className="font-mono px-5 py-2.5 text-right tabular-nums text-ink-2">
                        {row.builderInterview}
                      </td>
                      <td className="font-mono px-5 py-2.5 text-right tabular-nums font-semibold text-[var(--green)]">
                        {row.won}
                      </td>
                    </tr>
                  ))}
            </tbody>
            {!oppsQ.isLoading ? (
              <tfoot>
                <tr className="border-t-2 border-border-strong bg-surface-2 font-semibold text-[12px]">
                  <td className="px-5 py-2 text-ink-3">Total</td>
                  <td className="font-mono px-5 py-2 text-right tabular-nums">
                    {ownerRows.reduce((s, r) => s + r.totalActive, 0)}
                  </td>
                  <td className="font-mono px-5 py-2 text-right tabular-nums text-ink-2">
                    {ownerRows.reduce((s, r) => s + r.inDiscussions, 0)}
                  </td>
                  <td className="font-mono px-5 py-2 text-right tabular-nums text-ink-2">
                    {ownerRows.reduce((s, r) => s + r.builderInterview, 0)}
                  </td>
                  <td className="font-mono px-5 py-2 text-right tabular-nums text-[var(--green)]">
                    {ownerRows.reduce((s, r) => s + r.won, 0)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </SectionWrap>

      {/* ── Deal type breakdown (closed_won) ──────────────────────────── */}
      <SectionWrap title="Placement Types">
        <div className="flex flex-wrap items-center gap-3">
          {pipelineQ.isLoading
            ? Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-8 w-[120px] animate-pulse rounded-full bg-surface-2"
                />
              ))
            : dealTypeOrder.map((type) => {
                const count = dealTypeBreakdown[type] ?? 0;
                return (
                  <div
                    key={type}
                    className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-surface px-4 py-1.5 shadow-[var(--shadow-sm)]"
                  >
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                      {DEAL_TYPE_LABELS[type]}
                    </span>
                    <span
                      className={cn(
                        "font-mono text-[14px] font-semibold tabular-nums",
                        count > 0 ? "text-ink" : "text-ink-4",
                      )}
                    >
                      {count}
                    </span>
                  </div>
                );
              })}
          {!pipelineQ.isLoading && placementsCount > 0 ? (
            <span className="text-[11.5px] text-ink-3">
              {placementsCount} total placement{placementsCount !== 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      </SectionWrap>

      {/* ── Jobs ──────────────────────────────────────────────────────── */}
      <SectionWrap title="Jobs">
        <JobsRolesSection rolesQ={rolesQ} />
      </SectionWrap>

      <MetricDrawer metricKey={openMetric} onClose={() => setOpenMetric(null)} />
    </div>
  );
}

// ── Jobs roles section (breakdown cards + segment table) ────────────────────

type RolesQuery = ReturnType<typeof useJobRoles>;

const SEGMENT_TABS: { segment: RoleSegment; label: string }[] = [
  { segment: "hired_ft", label: "Hired — FT" },
  { segment: "hired_contract", label: "Hired — PT/Contract" },
  { segment: "interviewing", label: "Interviewing" },
  { segment: "applied", label: "Applied" },
  { segment: "rejected", label: "Rejected" },
  { segment: "withdrawn", label: "Withdrawn" },
];

type SortKey = "builder" | "role_title" | "company_name" | "salary" | "stage";
type SortDir = "asc" | "desc";

function JobsRolesSection({ rolesQ }: { rolesQ: RolesQuery }) {
  const [segment, setSegment] = useState<RoleSegment>("hired_ft");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("builder");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const rows = rolesQ.data?.rows ?? [];

  const segmentCounts = useMemo(() => {
    const counts = {} as Record<RoleSegment, number>;
    for (const tab of SEGMENT_TABS) counts[tab.segment] = 0;
    for (const r of rows) {
      if (r.segment in counts) counts[r.segment] += 1;
    }
    return counts;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows
      .filter((r) => r.segment === segment)
      .filter((r) => {
        if (!q) return true;
        return (
          r.builder.toLowerCase().includes(q) ||
          r.role_title.toLowerCase().includes(q) ||
          r.company_name.toLowerCase().includes(q)
        );
      });

    const sorted = [...filtered].sort((a, b) => {
      let cmp: number;
      if (sortKey === "salary") {
        const av = a.salary;
        const bv = b.salary;
        if (av == null && bv == null) cmp = 0;
        else if (av == null) cmp = 1; // nulls last regardless of dir
        else if (bv == null) cmp = -1;
        else cmp = av - bv;
        if (av == null || bv == null) return cmp; // keep nulls last
      } else {
        cmp = String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""), undefined, {
          sensitivity: "base",
        });
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

    return sorted;
  }, [rows, segment, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const cards: { label: string; value: string | number; subtitle?: string }[] = [
    { label: "Hired — Full-Time", value: rolesQ.isLoading ? "—" : (rolesQ.data?.hired_ft ?? 0) },
    { label: "Hired — PT/Contract", value: rolesQ.isLoading ? "—" : (rolesQ.data?.hired_contract ?? 0) },
    {
      label: "Committed Roles",
      value: rolesQ.isLoading ? "—" : (rolesQ.data?.committed ?? 0),
      subtitle: "hired + interviewing",
    },
    {
      label: "Avg $ (FT Placed)",
      value: rolesQ.isLoading ? "—" : fmtSalary(rolesQ.data?.avg_salary_ft),
    },
  ];

  const columns: { key: SortKey; label: string; align: "left" | "right" }[] = [
    { key: "builder", label: "Builder", align: "left" },
    { key: "role_title", label: "Role", align: "left" },
    { key: "company_name", label: "Company", align: "left" },
    { key: "salary", label: "Salary", align: "right" },
    { key: "stage", label: "Stage", align: "left" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Breakdown cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="flex flex-col gap-2 rounded-[8px] border border-border-strong bg-surface p-4 shadow-[var(--shadow-sm)]"
          >
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              {c.label}
            </span>
            {c.subtitle ? (
              <span className="text-[10.5px] text-ink-4 -mt-1">{c.subtitle}</span>
            ) : null}
            <span className="font-mono text-[28px] font-semibold leading-none tabular-nums text-ink">
              {c.value}
            </span>
          </div>
        ))}
      </div>

      {/* Segment tabs + search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex flex-wrap rounded-lg border border-border-strong bg-surface-2 p-1">
          {SEGMENT_TABS.map((tab) => {
            const active = tab.segment === segment;
            return (
              <button
                key={tab.segment}
                type="button"
                onClick={() => setSegment(tab.segment)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                  active
                    ? "bg-surface text-ink shadow-sm"
                    : "text-ink-3 hover:text-ink-2",
                )}
              >
                {tab.label} ({segmentCounts[tab.segment] ?? 0})
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search builder, role, company…"
          className="w-full rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none sm:w-[260px]"
        />
      </div>

      {/* Table */}
      <div className="max-h-[440px] overflow-auto rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)]">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              {columns.map((col) => {
                const isActive = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "cursor-pointer select-none px-5 py-2 font-semibold",
                      col.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex items-center gap-1",
                        col.align === "right" && "flex-row-reverse",
                      )}
                    >
                      {col.label}
                      {isActive ? (
                        sortDir === "asc" ? (
                          <ChevronUp size={12} />
                        ) : (
                          <ChevronDown size={12} />
                        )
                      ) : null}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rolesQ.isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-t border-border-strong">
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-5 py-3">
                      <div className="h-3 animate-pulse rounded bg-surface-2" />
                    </td>
                  ))}
                </tr>
              ))
            ) : visibleRows.length === 0 ? (
              <tr className="border-t border-border-strong">
                <td colSpan={5} className="px-5 py-6 text-center text-ink-4">
                  No roles in this segment.
                </td>
              </tr>
            ) : (
              visibleRows.map((row: JobRole) => (
                <tr
                  key={row.id}
                  className="border-t border-border-strong hover:bg-surface-2/50"
                >
                  <td className="px-5 py-2.5 font-medium text-ink">{row.builder}</td>
                  <td className="px-5 py-2.5 text-ink-2">{row.role_title}</td>
                  <td className="px-5 py-2.5 text-ink-2">{row.company_name}</td>
                  <td className="font-mono px-5 py-2.5 text-right tabular-nums text-ink">
                    {fmtSalary(row.salary)}
                  </td>
                  <td className="px-5 py-2.5">
                    <StagePill stage={row.stage} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Stage pill ──────────────────────────────────────────────────────────────

function StagePill({ stage }: { stage: string }) {
  const STAGE_META: Record<string, { label: string; className: string }> = {
    accepted: { label: "Hired", className: "text-[var(--green)] bg-[var(--green-soft)]" },
    interview: { label: "Interviewing", className: "text-[var(--amber)] bg-[var(--amber-soft)]" },
    applied: { label: "Applied", className: "text-[var(--accent)] bg-[var(--accent-soft)]" },
    rejected: { label: "Rejected", className: "text-[var(--red)] bg-[var(--red-soft)]" },
    withdrawn: { label: "Withdrawn", className: "text-ink-3 bg-surface-2" },
  };

  const meta = STAGE_META[stage] ?? {
    label: stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : "—",
    className: "text-ink-3 bg-surface-2",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
        meta.className,
      )}
    >
      {meta.label}
    </span>
  );
}

// ── Conversion row ────────────────────────────────────────────────────────

function ConversionRow({
  label,
  rate,
  targetLo,
  targetHi,
  targetLabel,
  isLoading,
}: {
  label: string;
  rate: number | null;
  targetLo: number;
  targetHi?: number;
  targetLabel: string;
  isLoading: boolean;
}) {
  const effectiveHi = targetHi ?? targetLo;
  const actualDisplay =
    isLoading || rate == null ? "—" : `${Math.round(rate * 100)}%`;

  const colorClass =
    isLoading || rate == null
      ? "text-ink-4"
      : rate >= targetLo
        ? "text-[var(--green)]"
        : rate >= targetLo * 0.75
          ? "text-[var(--amber)]"
          : "text-[var(--red)]";

  const barColor =
    isLoading || rate == null
      ? "bg-surface-2"
      : rate >= targetLo
        ? "bg-[var(--green)]"
        : rate >= targetLo * 0.75
          ? "bg-[var(--amber)]"
          : "bg-[var(--red)]";

  const fillPct =
    rate == null ? 0 : Math.min(100, (rate / effectiveHi) * 100);

  const statusText =
    isLoading || rate == null
      ? null
      : rate >= targetLo
        ? "On target"
        : rate >= targetLo * 0.75
          ? "Below target"
          : "Needs attention";

  const statusClass =
    isLoading || rate == null
      ? "text-ink-4 bg-surface-2"
      : rate >= targetLo
        ? "text-[var(--green)] bg-[var(--green-soft)]"
        : rate >= targetLo * 0.75
          ? "text-[var(--amber)] bg-[var(--amber-soft)]"
          : "text-[var(--red)] bg-[var(--red-soft)]";

  return (
    <tr className="border-t border-border-strong">
      <td className="px-5 py-3 font-medium text-ink">{label}</td>
      <td className="px-5 py-3 text-right">
        <span className={cn("font-mono text-[15px] font-semibold tabular-nums", colorClass)}>
          {actualDisplay}
        </span>
        {rate != null && !isLoading ? (
          <div className="mt-1 ml-auto h-1 w-[80px] overflow-hidden rounded-full bg-surface-2">
            <div
              className={cn("h-full rounded-full", barColor)}
              style={{ width: `${fillPct}%` }}
            />
          </div>
        ) : null}
      </td>
      <td className="font-mono px-5 py-3 text-right tabular-nums text-ink-3">
        {targetLabel}
      </td>
      <td className="px-5 py-3">
        {statusText ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
              statusClass,
            )}
          >
            {statusText}
          </span>
        ) : (
          <span className="text-[11px] text-ink-4">—</span>
        )}
      </td>
    </tr>
  );
}
