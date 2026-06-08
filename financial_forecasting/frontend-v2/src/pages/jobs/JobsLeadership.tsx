import { useMemo, useState } from "react";
import { Users, Target, DollarSign, Building2, ChevronUp, ChevronDown } from "lucide-react";

import {
  useJobsPipeline,
  useJobsOpportunities,
  useContactsSummary,
  useJobRoles,
  usePlacements,
  ACTIVE_STAGES,
  type PipelineStageSummary,
  type JobStage,
  type JobRole,
  type RoleSegment,
} from "@/services/jobs";
import { cn } from "@/lib/utils";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { MetricDrawer } from "@/components/jobs/MetricDrawer";

// ── SOP targets ───────────────────────────────────────────────────────────

const TARGET_ACTIVE_ORGS_LO = 25;
const TARGET_ACTIVE_ORGS_HI = 30;
const TARGET_PLACEMENTS = 20;
const TARGET_AVG_SALARY = 85_000;

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
  const [rolesOpen, setRolesOpen] = useState(true);

  const pipelineQ = useJobsPipeline();
  const oppsQ = useJobsOpportunities({ limit: 500 });
  const contactsQ = useContactsSummary();
  const rolesQ = useJobRoles();
  const placementsQ = usePlacements();

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
  const avgSalary = closedWonSummary?.avg_salary ?? null;

  // ── Builders placed (distinct builders, paid work) ──────────────────────
  // Two tracked numbers: placed full-time, and placed in any paid work.

  const placedFt = placementsQ.data?.ft_builders ?? 0;
  const placedAny = placementsQ.data?.any_builders ?? 0;

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
    <div className="flex flex-col gap-6">
      {/* ── ZONE 1 · North Star (outcomes) ────────────────────────────── */}
      <SectionWrap title="North Star · Outcomes">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[8px] border border-border-strong bg-border-strong shadow-[var(--shadow-sm)] sm:grid-cols-4">
          <NorthStarCell
            label="Builders Placed FT"
            value={placementsQ.isLoading ? "—" : placedFt}
            isLoading={placementsQ.isLoading}
            valueColor={statusColor(placedFt, TARGET_PLACEMENTS * 0.7)}
            sub={`of ${TARGET_PLACEMENTS} by end of July`}
            subLead={placementsQ.isLoading ? undefined : `${placedAny} in any paid work`}
            progress={{
              value: placedFt,
              max: TARGET_PLACEMENTS,
              colorClass: progressBarColor(placedFt, TARGET_PLACEMENTS * 0.7),
            }}
            icon={<Target size={14} />}
            onClick={() => setOpenMetric("placements")}
          />
          <NorthStarCell
            label="Avg FT Salary"
            value={fmtSalary(avgSalary)}
            isLoading={isLoading}
            valueColor={salaryColor}
            sub={`target ${fmtSalary(TARGET_AVG_SALARY)}+`}
            progress={{
              value: avgSalary ?? 0,
              max: TARGET_AVG_SALARY,
              colorClass:
                avgSalary == null
                  ? "bg-surface-2"
                  : avgSalary >= TARGET_AVG_SALARY
                    ? "bg-[var(--green)]"
                    : avgSalary >= TARGET_AVG_SALARY * 0.9
                      ? "bg-[var(--amber)]"
                      : "bg-[var(--red)]",
            }}
            icon={<DollarSign size={14} />}
          />
          <NorthStarCell
            label="Active Orgs"
            value={activeOrgsCount}
            isLoading={isLoading}
            valueColor={statusColor(activeOrgsCount, TARGET_ACTIVE_ORGS_LO)}
            sub={`target ${TARGET_ACTIVE_ORGS_LO}–${TARGET_ACTIVE_ORGS_HI}`}
            progress={{
              value: activeOrgsCount,
              max: TARGET_ACTIVE_ORGS_HI,
              colorClass: progressBarColor(activeOrgsCount, TARGET_ACTIVE_ORGS_LO),
            }}
            icon={<Building2 size={14} />}
            onClick={() => setOpenMetric("active_orgs")}
          />
          <NorthStarCell
            label="Builder Interviews"
            value={builderInterviewCount}
            isLoading={isLoading}
            sub="target 2–3 / week"
            icon={<Users size={14} />}
            onClick={() => setOpenMetric("builder_interviews")}
          />
        </div>
      </SectionWrap>

      {/* ── ZONE 2 · The Funnel (the engine) ──────────────────────────── */}
      <JobsFunnels />

      {/* ── ZONE 3 · Prospect Activity (leading indicators) ───────────── */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Prospect Activity
        </div>
        <div className="text-[11px] text-ink-4">
          Top-of-funnel engagement feeding the pipeline.
        </div>
        <div className="mt-1 flex flex-col divide-y divide-border-strong overflow-hidden rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)] sm:flex-row sm:divide-y-0 sm:divide-x">
          <ActivityStat
            label="Total Leads"
            value={totalLeads ?? "—"}
            isLoading={contactsLoading}
            sub={
              totalLeads != null && engagedLeads != null && totalLeads > 0
                ? `${Math.round((engagedLeads / totalLeads) * 100)}% engaged`
                : undefined
            }
            onClick={() => setOpenMetric("total_leads")}
          />
          <ActivityStat
            label="Engaged"
            value={engagedLeads ?? "—"}
            isLoading={contactsLoading}
            sub="prospects we've contacted"
            onClick={() => setOpenMetric("engaged_leads")}
          />
          <ActivityStat
            label="Outreach · wk"
            value={outreachThisWeek ?? "—"}
            isLoading={contactsLoading}
            sub={`${outreachAllTime ?? "—"} all time`}
            onClick={() => setOpenMetric("outreach_week")}
          />
          <ActivityStat
            label="Calls/Mtgs · wk"
            value={callsThisWeek ?? "—"}
            isLoading={contactsLoading}
            sub={`${callsAllTime ?? "—"} all time`}
            onClick={() => setOpenMetric("calls_week")}
          />
        </div>
      </div>

      {/* ── ZONE 4 · Details (secondary, collapsible) ─────────────────── */}
      <Collapsible
        title="Jobs Roles"
        open={rolesOpen}
        onToggle={() => setRolesOpen((o) => !o)}
      >
        <JobsRolesSection rolesQ={rolesQ} />
      </Collapsible>

      <MetricDrawer metricKey={openMetric} onClose={() => setOpenMetric(null)} />
    </div>
  );
}

// ── North Star cell (Zone 1 — biggest numbers) ──────────────────────────────

function NorthStarCell({
  label,
  value,
  isLoading,
  valueColor,
  sub,
  subLead,
  progress,
  icon,
  onClick,
}: {
  label: string;
  value: string | number;
  isLoading: boolean;
  valueColor?: string;
  sub?: string;
  subLead?: string;
  progress?: { value: number; max: number; colorClass: string };
  icon?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex flex-col gap-2 bg-surface p-4",
        onClick && "cursor-pointer transition-colors hover:bg-surface-2/40",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          {label}
        </span>
        <span className="text-ink-4">{icon}</span>
      </div>
      <span
        className={cn(
          "font-mono text-[30px] font-semibold leading-none tabular-nums",
          isLoading ? "text-ink-4" : (valueColor ?? "text-ink"),
        )}
      >
        {isLoading ? "—" : value}
      </span>
      {subLead ? (
        <span className="text-[11px] text-ink-3">{subLead}</span>
      ) : null}
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
      {sub ? <span className="text-[10.5px] text-ink-4">{sub}</span> : null}
    </div>
  );
}

// ── Activity stat (Zone 3 — compact prospect-activity strip cell) ───────────

function ActivityStat({
  label,
  value,
  isLoading,
  sub,
  onClick,
}: {
  label: string;
  value: string | number;
  isLoading: boolean;
  sub?: string;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex flex-1 flex-col gap-0.5 px-4 py-2.5",
        onClick && "cursor-pointer transition-colors hover:bg-surface-2/40",
      )}
    >
      <span className="text-[9.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      <span className="font-mono text-[20px] font-semibold leading-none tabular-nums text-ink">
        {isLoading ? "—" : value}
      </span>
      {sub ? (
        <span className="text-[10px] text-ink-4">{isLoading ? "—" : sub}</span>
      ) : null}
    </div>
  );
}

// ── Collapsible section (Zone 4 — secondary detail) ─────────────────────────

function Collapsible({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1.5 self-start text-[11px] font-semibold uppercase tracking-wider text-ink-3 transition-colors hover:text-ink-2"
      >
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {title}
      </button>
      {open ? children : null}
    </div>
  );
}

// ── Jobs roles section (breakdown cards + segment table) ────────────────────

type RolesQuery = ReturnType<typeof useJobRoles>;

const SEGMENT_TABS: { segment: RoleSegment; label: string }[] = [
  { segment: "hired_ft", label: "Hired — FT" },
  { segment: "hired_contract", label: "Hired — Other Paid" },
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

  const cards: { label: string; value: string | number; sub?: string }[] = [
    { label: "Hired — Full-Time", value: rolesQ.data?.hired_ft ?? 0 },
    { label: "Hired — Other Paid", value: rolesQ.data?.hired_contract ?? 0, sub: "any paid work, not FT" },
    {
      label: "Committed Roles",
      value: rolesQ.data?.committed ?? 0,
      sub: "hired + interviewing",
    },
    {
      label: "Avg $ (FT Placed)",
      value: fmtSalary(rolesQ.data?.avg_salary_ft),
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
      {/* Breakdown strip */}
      <div className="flex flex-col divide-y divide-border-strong overflow-hidden rounded-[8px] border border-border-strong bg-surface shadow-[var(--shadow-sm)] sm:flex-row sm:divide-y-0 sm:divide-x">
        {cards.map((c) => (
          <div key={c.label} className="flex flex-1 flex-col gap-1 px-4 py-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              {c.label}
            </span>
            <span className="font-mono text-[20px] font-semibold leading-none tabular-nums text-ink">
              {rolesQ.isLoading ? "—" : c.value}
            </span>
            {c.sub ? <span className="text-[10px] text-ink-4">{c.sub}</span> : null}
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
