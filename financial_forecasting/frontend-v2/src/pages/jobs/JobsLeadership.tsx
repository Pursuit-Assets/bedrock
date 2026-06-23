import { useState } from "react";
import { Users, Trophy, DollarSign, Building2, UserCheck } from "lucide-react";

import {
  useContactsSummary,
  usePlacements,
  useBuilderSegments,
} from "@/services/jobs";
import { JobsFunnels } from "@/components/jobs/JobsFunnels";
import { ActivityTrends } from "@/components/jobs/ActivityTrends";
import { MetricDrawer } from "@/components/jobs/MetricDrawer";
import { JobsStatBubble } from "@/components/jobs/JobsStatBubble";

// ── SOP targets ───────────────────────────────────────────────────────────

const TARGET_PLACEMENTS = 20;

// ── Helpers ───────────────────────────────────────────────────────────────

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
  const [segment, setSegment] = useState<string>("all");

  const contactsQ = useContactsSummary();
  const placementsQ = usePlacements(segment);
  const segmentsQ = useBuilderSegments();

  const p = placementsQ.data;
  const pLoading = placementsQ.isLoading;

  // ── Contacts & Outreach derived values ─────────────────────────────────
  const contactsLoading = contactsQ.isLoading;
  const totalLeads = contactsQ.data?.contacts.total ?? null;
  const engagedLeads = contactsQ.data?.contacts.engaged ?? null;

  return (
    <div className="flex flex-col gap-7">
      {/* ── Segment filter (scopes builder outcomes to an L3 cohort) ──── */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">Segment</span>
        <select
          value={segment}
          onChange={(e) => setSegment(e.target.value)}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent"
        >
          <option value="all">All L3+ ({segmentsQ.data?.total ?? "…"})</option>
          {(segmentsQ.data?.segments ?? []).map((s) => (
            <option key={s.value} value={s.value}>{s.label} ({s.count})</option>
          ))}
        </select>
        <span className="text-[11px] text-ink-4">L3 cohort that fed the job-ready pool · scopes builder outcomes &amp; funnel</span>
      </div>

      {/* ── ZONE 1 · North Star (outcomes) ────────────────────────────── */}
      <SectionWrap title="North Star · Outcomes">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <JobsStatBubble
            label="FT Roles Secured"
            value={p?.ft_roles_secured ?? 0}
            tone="violet"
            icon={<Trophy size={14} />}
            isLoading={pLoading}
            celebrate={!pLoading && (p?.ft_roles_secured ?? 0) > 0}
            subLead={pLoading ? undefined : `${p?.ft_builders ?? 0} placed · ${p?.committed_ft_roles ?? 0} committed`}
            sub={`of ${TARGET_PLACEMENTS} by end of July`}
            progressPct={pct(p?.ft_roles_secured ?? 0, TARGET_PLACEMENTS)}
            progressLabel={`${pct(p?.ft_roles_secured ?? 0, TARGET_PLACEMENTS)}%`}
            onClick={() => setOpenMetric("placements")}
          />
          <JobsStatBubble
            label="FT Builders Placed"
            value={p?.ft_builders ?? 0}
            tone="emerald"
            icon={<Trophy size={14} />}
            isLoading={pLoading}
            sub="builders in full-time roles"
            onClick={() => setOpenMetric("placements")}
          />
          <JobsStatBubble
            label="Builders w/ Paid Work"
            value={p?.any_builders ?? 0}
            tone="sky"
            icon={<Users size={14} />}
            isLoading={pLoading}
            sub="any paid placement (FT, PT, contract)"
            onClick={() => setOpenMetric("any_paid")}
          />
          <JobsStatBubble
            label="Interviewing"
            value={p?.interviewing ?? 0}
            tone="amber"
            icon={<Users size={14} />}
            isLoading={pLoading}
            sub="builders in active interviews"
            onClick={() => setOpenMetric("interviewing_builders")}
          />
          <JobsStatBubble
            label="Avg FT Salary · Placed"
            value={p?.avg_salary_ft_placed ?? 0}
            tone="emerald"
            icon={<DollarSign size={14} />}
            format="salary"
            isLoading={pLoading}
            sub="actual pay of FT placements"
          />
          <JobsStatBubble
            label="Avg FT Salary · Secured"
            value={p?.avg_salary_ft_secured ?? 0}
            tone="violet"
            icon={<DollarSign size={14} />}
            format="salary"
            isLoading={pLoading}
            sub="placed + committed FT roles"
          />
          <JobsStatBubble
            label="Committed Roles · Unfilled"
            value={p?.committed_ft_roles ?? 0}
            tone="sky"
            icon={<Building2 size={14} />}
            isLoading={pLoading}
            sub="locked-in FT reqs awaiting a builder"
            onClick={() => setOpenMetric("committed_roles")}
          />
        </div>
      </SectionWrap>

      {/* ── ZONE 2 · The Funnel (the engine) ──────────────────────────── */}
      <JobsFunnels builderSegment={segment} />

      {/* ── ZONE 3 · Prospect Activity (leading indicators) ───────────── */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
          Prospect Activity
        </div>
        <div className="text-[11px] text-ink-4">
          Top-of-funnel engagement feeding the pipeline.
        </div>
        <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>
      </div>

      {/* ── ZONE 3a · Outreach & activation over time ─────────────────── */}
      <ActivityTrends />

      <MetricDrawer metricKey={openMetric} onClose={() => setOpenMetric(null)} />
    </div>
  );
}
