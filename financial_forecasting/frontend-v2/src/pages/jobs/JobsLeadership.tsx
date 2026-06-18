import { useMemo, useState } from "react";
import {
  Users,
  Trophy,
  DollarSign,
  Building2,
  ChevronUp,
  ChevronDown,
  Phone,
  Send,
  UserCheck,
} from "lucide-react";

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
import { JobsStatBubble, type BubbleTone } from "@/components/jobs/JobsStatBubble";
import { ThisWeekRecap } from "@/components/jobs/ThisWeekRecap";

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

function pct(value: number, max: number): number {
  if (!max) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
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

  // Avg FT salary = actual pay per distinct FT-placed builder (from /roles),
  // matching the Jobs Roles section and Airtable. NOT the per-deal
  // salary_expected average, which counts multi-hire employers (e.g. JP Morgan,
  // 3 builders) only once and so understates the figure.
  const avgSalary = rolesQ.data?.avg_salary_ft ?? null;

  // ── FT roles secured (placed + committed) ───────────────────────────────
  // Headline outcome = roles secured (placed FT + committed FT). Breakdown
  // splits it back into placed vs committed.

  const ftRolesSecured = placementsQ.data?.ft_roles_secured ?? 0;
  const placedFt = placementsQ.data?.ft_builders ?? 0;
  const committedFtRoles = placementsQ.data?.committed_ft_roles ?? 0;

  // ── Contacts & Outreach derived values ─────────────────────────────────

  const contactsLoading = contactsQ.isLoading;
  const totalLeads = contactsQ.data?.contacts.total ?? null;
  const engagedLeads = contactsQ.data?.contacts.engaged ?? null;
  const outreachAllTime = contactsQ.data?.activity.outreach_total ?? null;
  const outreachThisWeek = contactsQ.data?.activity.outreach_this_week ?? null;
  const callsAllTime = contactsQ.data?.activity.calls_total ?? null;
  const callsThisWeek = contactsQ.data?.activity.calls_this_week ?? null;

  return (
    <div className="flex flex-col gap-7">
      {/* ── ZONE 1 · North Star (outcomes) ────────────────────────────── */}
      <SectionWrap title="North Star · Outcomes">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <JobsStatBubble
            label="FT Roles Secured"
            value={ftRolesSecured}
            tone="violet"
            icon={<Trophy size={14} />}
            isLoading={placementsQ.isLoading}
            celebrate={!placementsQ.isLoading && ftRolesSecured > 0}
            subLead={
              placementsQ.isLoading
                ? undefined
                : `${placedFt} placed · ${committedFtRoles} committed`
            }
            sub={`of ${TARGET_PLACEMENTS} by end of July`}
            progressPct={pct(ftRolesSecured, TARGET_PLACEMENTS)}
            progressLabel={`${pct(ftRolesSecured, TARGET_PLACEMENTS)}%`}
            onClick={() => setOpenMetric("placements")}
          />
          <JobsStatBubble
            label="Avg FT Salary"
            value={avgSalary ?? 0}
            tone="emerald"
            icon={<DollarSign size={14} />}
            format="salary"
            isLoading={isLoading}
            sub={`target ${fmtSalary(TARGET_AVG_SALARY)}+`}
            progressPct={pct(avgSalary ?? 0, TARGET_AVG_SALARY)}
            progressLabel={`${pct(avgSalary ?? 0, TARGET_AVG_SALARY)}%`}
          />
          <JobsStatBubble
            label="Active Orgs"
            value={activeOrgsCount}
            tone="sky"
            icon={<Building2 size={14} />}
            isLoading={isLoading}
            sub={`target ${TARGET_ACTIVE_ORGS_LO}–${TARGET_ACTIVE_ORGS_HI}`}
            progressPct={pct(activeOrgsCount, TARGET_ACTIVE_ORGS_HI)}
            progressLabel={`${pct(activeOrgsCount, TARGET_ACTIVE_ORGS_HI)}%`}
            onClick={() => setOpenMetric("active_orgs")}
          />
          <JobsStatBubble
            label="Builder Interviews"
            value={builderInterviewCount}
            tone="amber"
            icon={<Users size={14} />}
            isLoading={isLoading}
            sub="target 2–3 / week"
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
          Top-of-funnel engagement feeding the pipeline. Outreach counts first
          touches by the jobs team only — each contact counts once, ever.
        </div>
        <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <JobsStatBubble
            label="Total Leads"
            value={totalLeads ?? 0}
            tone="violet"
            icon={<Users size={14} />}
            isLoading={contactsLoading}
            sub={
              totalLeads != null && engagedLeads != null && totalLeads > 0
                ? `${Math.round((engagedLeads / totalLeads) * 100)}% engaged`
                : undefined
            }
            onClick={() => setOpenMetric("total_leads")}
          />
          <JobsStatBubble
            label="Engaged"
            value={engagedLeads ?? 0}
            tone="sky"
            icon={<UserCheck size={14} />}
            isLoading={contactsLoading}
            sub="prospects we've contacted"
            onClick={() => setOpenMetric("engaged_leads")}
          />
          <JobsStatBubble
            label="New Outreach · wk"
            value={outreachThisWeek ?? 0}
            tone="rose"
            icon={<Send size={14} />}
            isLoading={contactsLoading}
            sub={`${outreachAllTime ?? "—"} contacts reached all time`}
            onClick={() => setOpenMetric("outreach_week")}
          />
          <JobsStatBubble
            label="New Calls/Mtgs · wk"
            value={callsThisWeek ?? 0}
            tone="amber"
            icon={<Phone size={14} />}
            isLoading={contactsLoading}
            sub={`${callsAllTime ?? "—"} contacts met all time`}
            onClick={() => setOpenMetric("calls_week")}
          />
        </div>
      </div>

      {/* ── ZONE 3b · This Week recap ─────────────────────────────────── */}
      <ThisWeekRecap />

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

  const cards: {
    label: string;
    value: number;
    tone: BubbleTone;
    icon: React.ReactNode;
    format?: "int" | "salary";
    sub?: string;
  }[] = [
    {
      label: "Hired — Full-Time",
      value: rolesQ.data?.hired_ft ?? 0,
      tone: "violet",
      icon: <Trophy size={14} />,
    },
    {
      label: "Hired — Other Paid",
      value: rolesQ.data?.hired_contract ?? 0,
      tone: "sky",
      icon: <UserCheck size={14} />,
      sub: "any paid work, not FT",
    },
    {
      label: "Committed Roles",
      value: rolesQ.data?.committed ?? 0,
      tone: "amber",
      icon: <Users size={14} />,
      sub: "hired + interviewing",
    },
    {
      label: "Avg $ (FT Placed)",
      value: rolesQ.data?.avg_salary_ft ?? 0,
      tone: "emerald",
      icon: <DollarSign size={14} />,
      format: "salary",
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
      {/* Breakdown strip — bubble cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <JobsStatBubble
            key={c.label}
            label={c.label}
            value={c.value}
            tone={c.tone}
            icon={c.icon}
            format={c.format}
            sub={c.sub}
            isLoading={rolesQ.isLoading}
          />
        ))}
      </div>

      {/* Counting note — cards count distinct paid builders; table lists all */}
      <p className="-mt-1 text-[11px] text-ink-4">
        Hired counts are distinct builders with pay recorded (&gt;$0). The table
        lists every placement, including paid work without an amount entered yet.
      </p>

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
