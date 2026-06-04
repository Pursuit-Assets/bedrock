import { Fragment, useState } from "react";
import {
  useJobsOpportunities,
  useJobsOpportunity,
  useUpdateOpportunity,
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  ACTIVE_STAGES,
  STAGES_ORDERED,
  type JobStage,
  type DealType,
  type JobsOpportunity,
  type JobContact,
} from "@/services/jobs";
import { JobStageChip, DealTypeChip } from "@/components/jobs/JobStageChip";
import { ChevronDown, ChevronRight, Building2, Users, Activity, Clock, Mail, Linkedin } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

// ── Owner config ─────────────────────────────────────────────────────────────

interface OwnerDef {
  label: string;
  email: string;
  initials: string;
  color: string;
}

const OWNERS: OwnerDef[] = [
  { label: "Avni",   email: "avni@pursuit.org",             initials: "A",  color: "bg-violet-100 text-violet-700" },
  { label: "Damon",  email: "damon.kornhauser@pursuit.org", initials: "D",  color: "bg-sky-100 text-sky-700" },
  { label: "Devika", email: "devika@pursuit.org",           initials: "De", color: "bg-rose-100 text-rose-700" },
];

function ownerLabel(email: string | null): string {
  if (!email) return "—";
  const match = OWNERS.find((o) => o.email === email);
  if (match) return match.label;
  return email.split("@")[0] ?? email;
}

function ownerInitials(email: string | null): string {
  if (!email) return "?";
  const match = OWNERS.find((o) => o.email === email);
  if (match) return match.initials;
  const part = email.split("@")[0] ?? "";
  return part.slice(0, 2).toUpperCase();
}

function ownerColor(email: string | null): string {
  const match = OWNERS.find((o) => o.email === email);
  return match?.color ?? "bg-stone-100 text-stone-600";
}

// ── Stage group filter ────────────────────────────────────────────────────────

type StageGroup = "all" | "active" | "on_hold" | "closed";

const STAGE_GROUP_LABELS: Record<StageGroup, string> = {
  all:     "All",
  active:  "Active",
  on_hold: "On Hold",
  closed:  "Closed",
};

function stageMatchesGroup(stage: JobStage, group: StageGroup): boolean {
  if (group === "all") return true;
  if (group === "active") return ACTIVE_STAGES.includes(stage) || stage === "lead_submitted" || stage === "initial_outreach";
  if (group === "on_hold") return stage.startsWith("on_hold");
  if (group === "closed") return stage.startsWith("closed");
  return true;
}

// ── Stage dropdown color ──────────────────────────────────────────────────────

const STAGE_SELECT_STYLES: Record<JobStage, string> = {
  lead_submitted:               "text-stone-600",
  initial_outreach:             "text-blue-700",
  active_in_discussions:        "text-amber-700",
  active_opportunity_confirmed: "text-emerald-700",
  active_builder_interview:     "text-emerald-800 font-semibold",
  closed_won:                   "text-green-800 font-semibold",
  closed_lost:                  "text-red-600",
  on_hold_not_selected:         "text-stone-500",
  on_hold_not_interested:       "text-stone-500",
  on_hold_not_responsive:       "text-stone-500",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}

function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

function fmtSalary(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-US")}`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OwnerAvatar({ email, size = "sm" }: { email: string | null; size?: "sm" | "md" }) {
  const sz = size === "sm" ? "h-5 w-5 text-[10px]" : "h-6 w-6 text-[11px]";
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold leading-none",
        sz,
        ownerColor(email),
      )}
      title={ownerLabel(email)}
    >
      {ownerInitials(email)}
    </span>
  );
}

function CountBadge({
  count,
  icon: Icon,
  title,
}: {
  count: number;
  icon: React.ElementType;
  title: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-3"
      title={title}
    >
      <Icon size={11} className="shrink-0" />
      <span className="font-mono tabular-nums">{count}</span>
    </span>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3 w-3 animate-spin text-ink-3"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Expanded detail panel ────────────────────────────────────────────────────

function DealDetailPanel({ deal }: { deal: JobsOpportunity }) {
  const [activeTab, setActiveTab] = useState<"activity" | "history" | "contacts">("activity");
  const detailQ = useJobsOpportunity(deal.id);
  const updateOpp = useUpdateOpportunity();

  const detail = detailQ.data;
  const isPending = updateOpp.isPending;

  function handleStageChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newStage = e.target.value as JobStage;
    if (newStage === deal.stage) return;
    updateOpp.mutate({ id: deal.id, stage: newStage });
  }

  function handleDealTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    updateOpp.mutate({ id: deal.id, deal_type: val === "" ? null : val });
  }

  return (
    <div
      className="grid min-h-[280px] grid-cols-[1fr_340px] border-t border-border-strong bg-surface"
      style={{ boxShadow: "0 2px 8px rgba(20,18,14,0.04) inset" }}
    >
      {/* Left — deal fields */}
      <div className="flex flex-col gap-4 border-r border-border-strong px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* Stage selector */}
          <div className="flex items-center gap-1.5">
            {isPending ? <Spinner /> : null}
            <label className="text-[11px] uppercase tracking-wider text-ink-3">Stage</label>
          </div>
          <select
            value={deal.stage}
            onChange={handleStageChange}
            disabled={isPending}
            className={cn(
              "rounded border border-border-strong bg-surface px-2 py-1 text-[12px] focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-60",
              STAGE_SELECT_STYLES[deal.stage],
            )}
          >
            {STAGES_ORDERED.map((s) => (
              <option key={s} value={s} className={STAGE_SELECT_STYLES[s]}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <Field label="Deal Type">
            <select
              value={deal.deal_type ?? ""}
              onChange={handleDealTypeChange}
              disabled={isPending}
              className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-60"
            >
              <option value="">— none —</option>
              {(Object.entries(DEAL_TYPE_LABELS) as [DealType, string][]).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>

          <Field label="Owner">
            <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
              <OwnerAvatar email={deal.owner_email} />
              {ownerLabel(deal.owner_email)}
            </span>
          </Field>

          <Field label="Follow-up">
            <span className="font-mono text-[12px] text-ink-2">{fmtShortDate(deal.follow_up_date)}</span>
          </Field>

          <Field label="Salary Expected">
            <span className="font-mono text-[12px] text-ink-2">{fmtSalary(deal.salary_expected)}</span>
          </Field>

          <Field label="Builders" className="col-span-2">
            {deal.builder_ids.length === 0 ? (
              <span className="text-[12px] text-ink-4">None linked</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {deal.builder_ids.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2 border border-border-strong"
                  >
                    {id}
                  </span>
                ))}
              </div>
            )}
          </Field>

          {deal.description ? (
            <Field label="Description" className="col-span-2">
              <p className="text-[12px] leading-relaxed text-ink-2">{deal.description}</p>
            </Field>
          ) : null}
        </div>

        <div className="mt-auto pt-2">
          <button
            type="button"
            className="rounded border border-border-strong bg-surface px-3 py-1 text-[12px] text-ink-2 hover:bg-surface-2 transition-colors"
            onClick={() => alert("Add Note — coming soon")}
          >
            + Add Note
          </button>
        </div>
      </div>

      {/* Right — tabs */}
      <div className="flex flex-col">
        <div className="flex border-b border-border-strong bg-surface px-3 pt-2">
          {(["activity", "history", "contacts"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "border-b-2 px-3 pb-1.5 pt-1 text-[12px] font-medium transition-colors",
                activeTab === tab
                  ? "border-accent text-ink"
                  : "border-transparent text-ink-3 hover:text-ink-2",
              )}
            >
              {tab === "activity" && "Activity"}
              {tab === "history" && "History"}
              {tab === "contacts" && (
                <>
                  Contacts
                  {(detail?.contacts?.length ?? 0) > 0 && (
                    <span className="ml-1 text-[10.5px] text-ink-4">
                      ({detail!.contacts.length})
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {detailQ.isLoading ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-ink-3">
              Loading…
            </div>
          ) : activeTab === "activity" ? (
            <ActivityTab entries={detail?.activity ?? []} />
          ) : activeTab === "history" ? (
            <HistoryTab entries={detail?.stage_history ?? []} />
          ) : (
            <ContactsTab contacts={detail?.contacts ?? []} />
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">{label}</span>
      <div>{children}</div>
    </div>
  );
}

function ActivityTab({
  entries,
}: {
  entries: import("@/services/jobs").ActivityEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No activity recorded yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-strong">
      {entries.map((e) => (
        <li key={e.id} className="px-4 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium text-ink">
                {e.subject ?? e.type ?? "Activity"}
              </span>
              {e.description ? (
                <span className="text-[11.5px] text-ink-3 line-clamp-2">{e.description}</span>
              ) : null}
              {e.logged_by ? (
                <span className="text-[10.5px] text-ink-4">by {e.logged_by}</span>
              ) : null}
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-ink-4">
              {e.activity_date ? format(new Date(e.activity_date), "MMM d") : "—"}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function HistoryTab({
  entries,
}: {
  entries: import("@/services/jobs").StageHistoryEntry[];
}) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No stage changes recorded yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-strong">
      {entries.map((e) => (
        <li key={e.id} className="px-4 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                {e.from_stage ? (
                  <>
                    <span className="text-ink-3">{STAGE_LABELS[e.from_stage]}</span>
                    <span className="text-ink-4">→</span>
                  </>
                ) : null}
                <span className="font-medium text-ink">{STAGE_LABELS[e.to_stage]}</span>
              </div>
              {e.note ? (
                <span className="text-[11px] text-ink-3 italic">{e.note}</span>
              ) : null}
              {e.changed_by ? (
                <span className="text-[10.5px] text-ink-4">by {e.changed_by}</span>
              ) : null}
            </div>
            <span className="shrink-0 font-mono text-[10.5px] text-ink-4">
              {format(new Date(e.changed_at), "MMM d")}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Contact stage pill ────────────────────────────────────────────────────────

const CONTACT_STAGE_STYLES: Record<
  string,
  { label: string; className: string }
> = {
  active:           { label: "Active",           className: "bg-green-50 text-green-700" },
  initial_outreach: { label: "Initial Outreach", className: "bg-accent-soft text-accent-ink" },
  lead:             { label: "Lead",             className: "bg-stone-100 text-stone-500" },
  on_hold:          { label: "On Hold",          className: "bg-amber-50 text-amber-600" },
};

function ContactStagePill({ stage }: { stage: string | null }) {
  if (!stage) return null;
  const style = CONTACT_STAGE_STYLES[stage];
  if (!style) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

function contactInitials(contact: JobContact): string {
  if (contact.first_name && contact.last_name) {
    return (contact.first_name[0] + contact.last_name[0]).toUpperCase();
  }
  if (contact.full_name) {
    const parts = contact.full_name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0]! + parts[parts.length - 1][0]!).toUpperCase();
    }
    return contact.full_name.slice(0, 2).toUpperCase();
  }
  return "??";
}

function ContactsTab({ contacts }: { contacts: JobContact[] }) {
  if (contacts.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No contacts linked to this deal.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border-strong">
      {contacts.map((c) => (
        <li key={c.contact_id} className="flex items-center gap-3 px-4 py-2.5">
          {/* Initials avatar */}
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold leading-none text-accent-ink">
            {contactInitials(c)}
          </span>

          {/* Middle — name / title / stage */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-semibold text-ink">
              {c.full_name ?? (`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "—")}
            </span>
            {(c.current_title || c.current_company) ? (
              <span className="truncate text-[12px] text-ink-3">
                {[c.current_title, c.current_company].filter(Boolean).join(" @ ")}
              </span>
            ) : null}
            <ContactStagePill stage={c.contact_stage} />
          </div>

          {/* Right — email + LinkedIn */}
          <div className="flex shrink-0 items-center gap-2">
            {c.email ? (
              <a
                href={`mailto:${c.email}`}
                title={c.email}
                className="text-ink-3 transition-colors hover:text-accent"
                onClick={(e) => e.stopPropagation()}
              >
                <Mail size={14} />
              </a>
            ) : null}
            {c.linkedin_url ? (
              <a
                href={c.linkedin_url}
                target="_blank"
                rel="noreferrer"
                title="LinkedIn"
                className="text-ink-3 transition-colors hover:text-accent"
                onClick={(e) => e.stopPropagation()}
              >
                <Linkedin size={14} />
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Deal row ──────────────────────────────────────────────────────────────────

function DealRow({
  deal,
  isExpanded,
  onToggle,
}: {
  deal: JobsOpportunity;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Fragment>
      <tr
        className={cn(
          "h-[44px] cursor-pointer border-t border-border-strong transition-colors",
          isExpanded ? "bg-surface-2/60" : "hover:bg-surface-2/40",
        )}
        onClick={onToggle}
      >
        {/* Chevron */}
        <td className="w-7 px-2 align-middle">
          {isExpanded ? (
            <ChevronDown size={13} className="text-ink-4" />
          ) : (
            <ChevronRight size={13} className="text-ink-4" />
          )}
        </td>

        {/* Company */}
        <td className="px-3 align-middle">
          <div className="flex items-center gap-2">
            <Building2 size={13} className="shrink-0 text-ink-4" />
            <span className="truncate text-[14px] font-semibold text-ink">
              {deal.account_name}
            </span>
          </div>
        </td>

        {/* Stage chip */}
        <td className="w-[170px] px-3 align-middle">
          <JobStageChip stage={deal.stage} />
        </td>

        {/* Deal type chip */}
        <td className="w-[110px] px-3 align-middle">
          {deal.deal_type ? (
            <DealTypeChip type={deal.deal_type} />
          ) : (
            <span className="text-[11px] text-ink-4">—</span>
          )}
        </td>

        {/* Owner avatar */}
        <td className="w-[48px] px-3 align-middle">
          <OwnerAvatar email={deal.owner_email} />
        </td>

        {/* Badges */}
        <td className="w-[120px] px-1 align-middle">
          <div className="flex items-center">
            {deal.builder_ids.length > 0 ? (
              <CountBadge count={deal.builder_ids.length} icon={Users} title="Builders" />
            ) : null}
            {(deal.activity_count ?? 0) > 0 ? (
              <CountBadge count={deal.activity_count!} icon={Activity} title="Activities" />
            ) : null}
            {deal.touch_count > 0 ? (
              <CountBadge count={deal.touch_count} icon={Clock} title="Touches" />
            ) : null}
          </div>
        </td>

        {/* Updated */}
        <td className="w-[120px] px-3 align-middle text-right">
          <span className="font-mono text-[11px] text-ink-4" title={fmtShortDate(deal.updated_at)}>
            {fmtRelative(deal.updated_at)}
          </span>
        </td>
      </tr>

      {isExpanded ? (
        <tr>
          <td colSpan={7} className="p-0">
            <DealDetailPanel deal={deal} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function JobsTeam() {
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
  const [stageGroup, setStageGroup] = useState<StageGroup>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: rawData, isLoading } = useJobsOpportunities(
    ownerFilter ? { owner_email: ownerFilter } : {},
  );

  const allDeals: JobsOpportunity[] = (rawData as { data: JobsOpportunity[]; total: number } | undefined)?.data ?? [];

  const visible = allDeals.filter((d) => stageMatchesGroup(d.stage, stageGroup));

  const stageGroups: StageGroup[] = ["all", "active", "on_hold", "closed"];

  return (
    <div className="flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-4 border-b border-border-strong bg-surface px-5 py-2.5">
        {/* Owner pills */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOwnerFilter(null)}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] font-medium transition-colors",
              ownerFilter === null
                ? "border-accent bg-accent/5 text-accent"
                : "border-border-strong bg-surface text-ink-3 hover:text-ink-2",
            )}
          >
            All
          </button>
          {OWNERS.map((o) => (
            <button
              key={o.email}
              type="button"
              onClick={() => setOwnerFilter(ownerFilter === o.email ? null : o.email)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium transition-colors",
                ownerFilter === o.email
                  ? "border-accent bg-accent/5 text-accent"
                  : "border-border-strong bg-surface text-ink-2 hover:bg-surface-2",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                  o.color,
                )}
              >
                {o.initials}
              </span>
              {o.label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border-strong" />

        {/* Stage group filter */}
        <div className="flex items-center gap-0.5 rounded-md border border-border-strong bg-surface-2 p-0.5">
          {stageGroups.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setStageGroup(g)}
              className={cn(
                "rounded px-2.5 py-1 text-[12px] font-medium transition-colors",
                stageGroup === g
                  ? "bg-surface text-ink shadow-sm"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              {STAGE_GROUP_LABELS[g]}
            </button>
          ))}
        </div>

        {/* Count badge */}
        <span className="ml-auto font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${visible.length} deal${visible.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Table */}
      {isLoading ? (
        <EmptyState>Loading deals…</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>
          No deals match your filters.{" "}
          <button
            type="button"
            className="text-accent underline underline-offset-2"
            onClick={() => { setOwnerFilter(null); setStageGroup("all"); }}
          >
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-7 px-2 py-2" />
              <th className="px-3 py-2 text-left font-semibold">Company</th>
              <th className="w-[170px] px-3 py-2 text-left font-semibold">Stage</th>
              <th className="w-[110px] px-3 py-2 text-left font-semibold">Type</th>
              <th className="w-[48px] px-3 py-2 text-left font-semibold">Owner</th>
              <th className="w-[120px] px-1 py-2 text-left font-semibold">Signals</th>
              <th className="w-[120px] px-3 py-2 text-right font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((deal) => (
              <DealRow
                key={deal.id}
                deal={deal}
                isExpanded={expandedId === deal.id}
                onToggle={() => setExpandedId(expandedId === deal.id ? null : deal.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center px-6 py-16 text-center text-[13px] text-ink-3">
      {children}
    </div>
  );
}
