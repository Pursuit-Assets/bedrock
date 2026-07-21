/**
 * Jobs · Contacts — contact-level view.
 *
 * Configurable table like the rest of the app: search, per-column filters,
 * group-by, sortable headers, column chooser, saved views. Fluid layout (no
 * horizontal scroll). Rows show connected LinkedIn staff and expand inline to
 * the contact's tabs. The cross-source "find any contact" search + Add-to-Jobs
 * preview + New Contact sit above the table.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Briefcase, CheckSquare, ExternalLink, Linkedin, Plus, Search, X, Zap } from "lucide-react";

import { ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { ContactExpandTabs, jobsContactPath, warmthTier, warmthRank } from "@/components/jobs/jobsEntity";
import { CompanyPicker } from "@/components/jobs/CompanyPicker";
import { withReferrer } from "@/components/detail";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Toolbar } from "@/components/ui/Toolbar";
import { RECENCY_OPTIONS, recencyLabel } from "@/lib/recencyFilter";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { useColumnWidths } from "@/lib/columnWidths";
import { ResizableTh, ColGroup } from "@/components/ui/ResizableTable";
import { useSessionState } from "@/lib/useSessionState";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies, serializeRulesForServer,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";
import { cn } from "@/lib/utils";
import {
  useJobsContacts, useAddContactToJobs,
  useContactDetail, useCreateContact, STAGE_LABELS,
  useFlagContactsForJobs, useUnflagJobsContact, useUpdateJobsMembership, MEMBERSHIP_STAGE_LABELS, MEMBERSHIP_STAGES,
  useContactTagCatalog, useStaff, useUpdateContact,
  type JobStage, type JobContactWithDeal, type ContactSearchResult, type ContactCreateBody, type MembershipStage,
} from "@/services/jobs";

// ── stage metadata ────────────────────────────────────────────────────────────
const CONTACT_STAGE_SELECT = [
  { value: "active", label: "Active" }, { value: "initial_outreach", label: "Initial Outreach" },
  { value: "lead", label: "Lead" }, { value: "on_hold", label: "On Hold" },
];
const CONTACT_STAGE_STYLES: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "bg-green-50 text-green-700" },
  initial_outreach: { label: "Outreach", className: "bg-accent-soft text-accent-ink" },
  lead: { label: "Lead", className: "bg-stone-100 text-stone-500" },
  on_hold: { label: "On Hold", className: "bg-amber-50 text-amber-600" },
};

// ── warmth: recency + responsiveness (shared model with accounts) ──────────────
function warmthInput(c: JobContactWithDeal) {
  return { recent: c.recent_activity_count, last_activity_at: c.last_activity_at, responded: c.responded };
}
function Warmth({ c }: { c: JobContactWithDeal }) {
  const t = warmthTier(warmthInput(c));
  return (
    <span className="flex items-center gap-1.5" title={t.hint}>
      <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", t.dot)} />
      <span className={cn("text-[11.5px] font-medium", t.txt)}>{t.label}</span>
    </span>
  );
}

// ── columns ──────────────────────────────────────────────────────────────────
type ColKey = "name" | "prospect" | "flag" | "title" | "company" | "tags" | "owner" | "industry" | "warmth" | "listings" | "tasks" | "connected" | "deal" | "email" | "linkedin";
const COLUMN_ORDER: ColKey[] = ["name", "prospect", "flag", "title", "company", "tags", "owner", "industry", "warmth", "listings", "tasks", "connected", "deal", "email", "linkedin"];
const DEFAULT_VISIBLE: ColKey[] = ["name", "prospect", "flag", "title", "company", "tags", "owner", "connected", "warmth", "listings"];
const COL_LABELS: Record<ColKey, string> = {
  name: "Name", prospect: "Jobs prospect", flag: "Jobs stage", title: "Title", company: "Company", tags: "Tags", owner: "Owner", industry: "Industry",
  warmth: "Warmth", listings: "Job listings", tasks: "Open tasks", connected: "Connected staff", deal: "Linked deal", email: "Email", linkedin: "LinkedIn",
};
// Default pixel widths — user-resizable via drag handles (useColumnWidths),
// same grid components as the Opportunities table.
const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 190, prospect: 90, flag: 130, title: 150, company: 160, tags: 190, owner: 150, industry: 130, warmth: 95, listings: 105, tasks: 85, connected: 155, deal: 145, email: 170, linkedin: 60,
};
const SORTABLE = new Set<ColKey>(["name", "prospect", "flag", "title", "company", "owner", "industry", "warmth", "listings", "tasks"]);
const MEMBERSHIP_STAGE_OPTIONS = MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] }));

function extract(c: JobContactWithDeal, key: ColKey): string | number {
  switch (key) {
    case "name": return (c.full_name ?? "").toLowerCase();
    case "prospect": return c.is_jobs_contact ? 0 : 1;
    case "owner": return (c.owner_email ?? "").toLowerCase();
    case "flag": return c.membership_stage ?? "";
    case "title": return (c.current_title ?? "").toLowerCase();
    case "company": return (c.current_company ?? "").toLowerCase();
    case "industry": return (c.company_industry ?? "").toLowerCase();
    case "warmth": return warmthRank(warmthInput(c));
    case "listings": return (c.open_roles ?? 0) + (c.builder_apps ?? 0);
    case "tasks": return c.open_tasks ?? 0;
    default: return "";
  }
}

// ── filters + grouping ─────────────────────────────────────────────────────────
type Field = "name" | "title" | "company" | "industry" | "stage" | "flag" | "is_jobs" | "owner" | "tags" | "listings" | "has_deal" | "connected" | "connection_count" | "last_activity" | "first_contact_date" | "last_contact_date";
const FILTERABLE: Record<Field, FieldMeta<JobContactWithDeal>> = {
  name: { label: "Name", type: "text", getValue: (c) => c.full_name ?? "" },
  title: { label: "Title", type: "text", getValue: (c) => c.current_title ?? "" },
  company: { label: "Company", type: "text", getValue: (c) => c.current_company ?? "" },
  industry: { label: "Industry", type: "text", getValue: (c) => c.company_industry ?? "" },
  stage: { label: "Contact stage", type: "select", getValue: (c) => c.contact_stage ?? "" },
  flag: { label: "Jobs stage", type: "select", getValue: (c) => c.membership_stage ?? "" },
  is_jobs: { label: "Jobs prospect", type: "select", getValue: (c) => (c.is_jobs_contact ? "yes" : "no") },
  owner: { label: "Owner", type: "select", getValue: (c) => c.owner_email ?? "" },
  tags: { label: "Tags", type: "tags", getValue: (c) => (c.crm_tags ?? []).join(",") },
  listings: { label: "Job listings (sourced + applied)", type: "number", getValue: (c) => (c.open_roles ?? 0) + (c.builder_apps ?? 0) },
  has_deal: { label: "Linked deal", type: "select", getValue: (c) => (c.deal ? "yes" : "no") },
  // Text: filter "Connected staff contains <person>" (a SPECIFIC staffer), plus
  // is_empty / is_not_empty for none / any connection.
  connected: { label: "Connected staff (name)", type: "text", getValue: (c) => (c.connected_staff_names ?? []).join(", ") },
  // Number: "connected to more than N staff".
  connection_count: { label: "# staff connections", type: "number", getValue: (c) => (c.connected_staff_names ?? []).length },
  // Top-of-funnel triage: filter by activity recency (Last 7/30/90 days dropdown).
  last_activity: { label: "Last activity", type: "recency", getValue: (c) => c.last_activity_at ?? "" },
  // Exact-date windows on the touch history (before/after a calendar date).
  first_contact_date: { label: "Initial outreach date", type: "date", getValue: (c) => c.first_activity_at ?? "" },
  last_contact_date: { label: "Last contact date", type: "date", getValue: (c) => c.last_activity_at ?? "" },
};
const GROUP_OPTIONS = [
  { value: "", label: "No grouping" },
  { value: "stage", label: "Group by Stage" },
  { value: "company", label: "Group by Company" },
  { value: "has_deal", label: "Group by Linked deal" },
];
const YESNO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

interface JobsContactsView {
  query?: string; rules?: FilterRule<Field>[]; visibleCols?: ColKey[]; groupBy?: string; sort?: SortState<ColKey>;
}
const EMPTY: string[] = [];

// ── New Contact modal (unchanged) ────────────────────────────────────────────────
type ContactStageValue = "active" | "initial_outreach" | "lead" | "on_hold";
const NEW_CONTACT_STAGE_OPTIONS: { value: ContactStageValue; label: string }[] = [
  { value: "lead", label: "Lead" }, { value: "initial_outreach", label: "Initial Outreach" },
  { value: "active", label: "Active" }, { value: "on_hold", label: "On Hold" },
];
interface NewContactForm { fullName: string; email: string; title: string; company: string; linkedIn: string; stage: ContactStageValue; }
const DEFAULT_NEW_CONTACT_FORM: NewContactForm = { fullName: "", email: "", title: "", company: "", linkedIn: "", stage: "lead" };
function Spinner() {
  return <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>;
}
function NewContactModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [form, setForm] = useState<NewContactForm>(DEFAULT_NEW_CONTACT_FORM);
  const createContact = useCreateContact();
  const set = <K extends keyof NewContactForm>(k: K, v: NewContactForm[K]) => setForm((p) => ({ ...p, [k]: v }));
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fullName.trim()) return;
    const body: ContactCreateBody = {
      full_name: form.fullName.trim(), email: form.email.trim() || undefined, current_title: form.title.trim() || undefined,
      current_company: form.company.trim() || undefined, linkedin_url: form.linkedIn.trim() || undefined,
      contact_stage: form.stage,
    };
    const created = await createContact.mutateAsync(body);
    onClose();
    if (created?.contact_id) nav(jobsContactPath(created.contact_id));
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4"><h2 className="text-[15px] font-semibold text-ink">New Contact</h2><button type="button" onClick={onClose} className="text-ink-3 hover:text-ink"><X size={16} /></button></div>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Full Name *</label><input required value={form.fullName} onChange={(e) => set("fullName", e.target.value)} placeholder="Jane Smith" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Email</label><input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
            <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Stage</label><select value={form.stage} onChange={(e) => set("stage", e.target.value as ContactStageValue)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40">{NEW_CONTACT_STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Title</label><input value={form.title} onChange={(e) => set("title", e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
            <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Company</label><CompanyPicker value={form.company} onChange={(v) => set("company", v)} /></div>
          </div>
          <div className="flex flex-col gap-1"><label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">LinkedIn URL</label><input type="url" value={form.linkedIn} onChange={(e) => set("linkedIn", e.target.value)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40" /></div>
          <div className="flex items-center justify-end gap-3 pt-1"><button type="button" onClick={onClose} className="px-4 py-2 text-[13px] font-medium text-ink-3 hover:text-ink">Cancel</button><button type="submit" disabled={createContact.isPending || !form.fullName.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">{createContact.isPending ? <Spinner /> : <Plus size={13} />}{createContact.isPending ? "Creating…" : "Create Contact"}</button></div>
        </form>
      </div>
    </div>
  );
}

// ── tags cell (chips + fixed-position popover editor) ────────────────────────
function TagsCell({ contact }: { contact: JobContactWithDeal }) {
  const { data: catalog = [] } = useContactTagCatalog();
  const update = useUpdateContact();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [draft, setDraft] = useState<string[]>([]);
  const labels = useMemo(() => Object.fromEntries(catalog.map((t) => [t.slug, t.label])), [catalog]);
  const tags = contact.crm_tags ?? [];
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Edit tags"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ top: r.bottom + 4, left: r.left });
          setDraft(tags);
          setOpen((v) => !v);
        }}
        className="flex min-h-[20px] w-full flex-wrap items-center gap-1 text-left"
      >
        {tags.length > 0
          ? tags.map((t) => <span key={t} className="truncate rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">{labels[t] ?? t}</span>)
          : <span className="text-[12px] text-ink-4">—</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div style={{ position: "fixed", top: pos.top, left: pos.left }} className="z-50 max-h-72 w-60 overflow-auto rounded-md border border-border-strong bg-surface p-2 shadow-xl">
            {catalog.map((t) => (
              <label key={t.slug} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[12px] text-ink-2 hover:bg-surface-2">
                <input type="checkbox" checked={draft.includes(t.slug)} onChange={() => setDraft((d) => d.includes(t.slug) ? d.filter((x) => x !== t.slug) : [...d, t.slug])} className="h-3.5 w-3.5 accent-[color:var(--accent,#4242EA)]" />
                {t.label}
              </label>
            ))}
            <div className="mt-1 flex items-center justify-end gap-2 border-t border-border-strong pt-1.5">
              <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-3 hover:text-ink">Cancel</button>
              <button type="button" disabled={update.isPending}
                onClick={() => update.mutate({ id: contact.contact_id, tags: draft }, { onSuccess: () => setOpen(false) })}
                className="rounded bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">
                {update.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── row ──────────────────────────────────────────────────────────────────────
function ContactRow({ contact, expanded, onOpen, visibleCols, selected, onToggleSelect }: { contact: JobContactWithDeal; expanded: boolean; onOpen: () => void; visibleCols: ColKey[]; selected: boolean; onToggleSelect: () => void }) {
  const updateMembership = useUpdateJobsMembership();
  const flagOne = useFlagContactsForJobs();
  const addToJobs = useAddContactToJobs();
  const updateContact = useUpdateContact();
  const { data: staffList = [] } = useStaff();
  const staffOptions = useMemo(
    () => [{ value: "", label: "—" }, ...staffList.map((s) => ({ value: s.email, label: s.name }))],
    [staffList],
  );
  const staffName = (email: string | null | undefined) =>
    staffList.find((s) => s.email === email)?.name ?? email ?? "—";
  const staff = contact.connected_staff_names ?? [];
  const cells: Record<ColKey, React.ReactNode> = {
    name: (
      <span className="flex min-w-0 items-center gap-2">
        <input type="checkbox" checked={selected} onClick={(e) => e.stopPropagation()} onChange={onToggleSelect} className="h-3.5 w-3.5 shrink-0 accent-[color:var(--accent,#4242EA)]" aria-label="Select contact" />
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">{initials(contact.full_name)}</span>
        <span className="truncate text-[13px] font-medium text-ink">{contact.full_name || "—"}</span>
        <Link to={jobsContactPath(contact.contact_id)} state={withReferrer({ pathname: "/jobs", label: "Jobs" })} onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-4 hover:text-accent" title="Open contact detail"><ExternalLink size={12} /></Link>
      </span>
    ),
    prospect: (
      <span className="flex items-center justify-center" title={contact.is_jobs_contact ? "Jobs prospect — click to remove" : "Mark as jobs prospect"}>
        <input
          type="checkbox"
          checked={!!contact.is_jobs_contact}
          disabled={addToJobs.isPending}
          onClick={(e) => e.stopPropagation()}
          onChange={() => addToJobs.mutate({ id: contact.contact_id, add: !contact.is_jobs_contact })}
          className="h-4 w-4 cursor-pointer accent-[color:var(--accent,#4242EA)]"
          aria-label="Jobs prospect"
        />
      </span>
    ),
    owner: (
      <InlineSelect<string>
        value={contact.owner_email ?? ""}
        options={staffOptions}
        renderValue={(v) => <span className={cn("truncate text-[12.5px]", (v ?? contact.owner_email) ? "text-ink-2" : "text-ink-4")}>{staffName(v ?? contact.owner_email)}</span>}
        onSave={(v) => new Promise<void>((res, rej) => updateContact.mutate({ id: contact.contact_id, owner_email: v || null }, { onSuccess: () => res(), onError: rej }))}
      />
    ),
    tags: <TagsCell contact={contact} />,
    title: <span className="truncate text-[12.5px] text-ink-2">{contact.current_title || "—"}</span>,
    company: <span className="truncate text-[12.5px] text-ink-2">{contact.current_company || "—"}</span>,
    flag: contact.membership_stage
      ? <InlineSelect<string> value={contact.membership_stage} options={MEMBERSHIP_STAGE_OPTIONS}
          renderValue={(v) => <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">{MEMBERSHIP_STAGE_LABELS[(v ?? contact.membership_stage) as MembershipStage] ?? v}</span>}
          onSave={(v) => new Promise<void>((res, rej) => updateMembership.mutate({ contact_id: contact.contact_id, stage: v || undefined }, { onSuccess: () => res(), onError: rej }))} />
      : <button type="button" onClick={(e) => { e.stopPropagation(); flagOne.mutate({ contact_ids: [contact.contact_id] }); }}
          className="inline-flex items-center gap-1 rounded border border-dashed border-border-strong px-2 py-0.5 text-[11px] text-ink-3 hover:border-accent hover:text-accent"><Zap size={10} /> Flag</button>,
    industry: <span className="truncate text-[12px] text-ink-3">{contact.company_industry || "—"}</span>,
    listings: (() => {
      const src = contact.open_roles ?? 0, app = contact.builder_apps ?? 0, tot = src + app;
      return tot > 0
        ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2" title={`${src} team-sourced · ${app} builder-applied`}><Briefcase size={11} className="text-ink-4" />{tot}</span>
        : <span className="text-ink-4">—</span>;
    })(),
    warmth: <Warmth c={contact} />,
    tasks: (contact.open_tasks ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><CheckSquare size={11} className="text-ink-4" />{contact.open_tasks}</span>
      : <span className="text-ink-4">—</span>,
    connected: staff.length > 0
      ? <span className="flex min-w-0 flex-wrap items-center gap-1"><Linkedin size={11} className="shrink-0 text-indigo-500" />{staff.slice(0, 2).map((n) => <span key={n} className="truncate rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">{n}</span>)}{staff.length > 2 && <span className="text-[10px] text-ink-4">+{staff.length - 2}</span>}</span>
      : <span className="text-ink-4">—</span>,
    deal: contact.deal
      ? <span className="truncate text-[12px] text-ink-2">{contact.deal.account_name}<span className="ml-1 text-[10.5px] text-ink-4">{STAGE_LABELS[contact.deal.stage as JobStage] ?? contact.deal.stage}</span></span>
      : <span className="text-ink-4">—</span>,
    email: contact.email
      ? <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()} className="truncate text-[12.5px] text-ink-2 hover:text-accent hover:underline">{contact.email}</a>
      : <span className="text-ink-4">—</span>,
    linkedin: contact.linkedin_url
      ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-accent"><Linkedin size={14} /></a>
      : <span className="text-ink-4">—</span>,
  };
  return (
    <Fragment>
      <tr id={`contact-${contact.contact_id}`} className={cn("cursor-pointer border-t border-border-strong hover:bg-surface-2/40", expanded && "bg-surface-2/40")} onClick={onOpen}>
        {visibleCols.map((key, i) => (
          <td key={key} className={cn("overflow-hidden px-3 py-1.5 align-middle", i === 0 && "sticky left-0 z-10 bg-surface")} onClick={["flag", "prospect", "owner", "tags"].includes(key) ? (e) => e.stopPropagation() : undefined}>{cells[key]}</td>
        ))}
      </tr>
      {expanded && <tr className="bg-surface-2/20"><td colSpan={visibleCols.length} className="p-0"><ContactExpandTabs contactId={contact.contact_id} /></td></tr>}
    </Fragment>
  );
}

export function JobsContacts({ initialQuery, initialContactId }: { initialQuery?: string; initialContactId?: number } = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [rules, setRules] = useState<FilterRule<Field>[]>([]);
  const [groupBy, setGroupBy] = useSessionState<string>("jobs-contacts:groupBy", "");
  const [collapsedGroups, setCollapsedGroups] = useSessionState<string[]>("jobs-contacts:groupCollapsed", EMPTY);
  const [showNewContact, setShowNewContact] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Default = today's working view (jobs prospects only). "All contacts" opens
  // the full universe so anyone can be promoted via the prospect checkmark.
  const [scope, setScope] = useSessionState<"jobs" | "all">("jobs-contacts:scope", "jobs");
  const [flagView, setFlagView] = useState<"all" | "flagged" | "unflagged">("all");
  const [flagOwner, setFlagOwner] = useState("");
  const flagContacts = useFlagContactsForJobs();
  const unflag = useUnflagJobsContact();
  const toggleSelect = useCallback((id: number) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const { sort, toggle, setSort } = useSort<ColKey>({ key: "name", direction: "asc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:jobs-contacts-v2", COLUMN_ORDER, DEFAULT_VISIBLE);
  const { widths, startResize } = useColumnWidths<ColKey>("bedrock-v2:cols:jobs-contacts", DEFAULT_WIDTHS);
  const [showAllRows, setShowAllRows] = useState(false);

  const [previewContact, setPreviewContact] = useState<ContactSearchResult | null>(null);
  const [bannerAddedToJobs, setBannerAddedToJobs] = useState(false);
  const { mutate: addContactToJobs } = useAddContactToJobs();

  // Server-side search: the table only loads the first 500 pipeline contacts,
  // so the search box must query the SERVER (all contacts), not just filter
  // the loaded page — otherwise anyone past row 500 is unfindable. Debounced
  // so we don't refetch per keystroke; client-side filtering still applies on
  // top for instant narrowing.
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery ?? "");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);
  // Filter rules are translated to SQL server-side (see list_contacts) so a
  // rule like "connected staff contains jac" scans all 47k contacts — the old
  // client-only filtering silently sifted just the loaded page. Client-side
  // ruleApplies still runs on top for instant feedback while typing.
  const serverRules = useMemo(() => serializeRulesForServer(rules), [rules]);
  const filteringActive = serverRules.length > 0 || !!debouncedQuery;
  const { data: rawData, isLoading, isError, refetch } = useJobsContacts({
    limit: filteringActive ? 5000 : 500,
    search: debouncedQuery || undefined,
    flagged: flagView === "all" ? undefined : flagView === "flagged",
    scope,
    rules: serverRules.length > 0 ? serverRules : undefined,
  });
  const allContacts: JobContactWithDeal[] = useMemo(() => rawData?.data ?? [], [rawData]);
  const serverTotal = rawData?.total ?? 0;
  const universeTruncated = filteringActive && serverTotal > allContacts.length;

  const openContact = useCallback((result: ContactSearchResult) => {
    if (allContacts.some((c) => c.contact_id === result.contact_id)) {
      setExpandedId(result.contact_id); setPreviewContact(null);
      requestAnimationFrame(() => document.getElementById(`contact-${result.contact_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } else { setPreviewContact(result); setBannerAddedToJobs(false); }
  }, [allContacts]);

  const deepLinkDetail = useContactDetail(initialContactId ?? null);
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !deepLinkDetail.data) return;
    const d = deepLinkDetail.data; openedDeepLink.current = true;
    openContact({ contact_id: d.contact_id, full_name: d.full_name, email: d.email, current_title: d.current_title, current_company: d.current_company, source: null, airtable_id: d.airtable_id, contact_stage: d.contact_stage, in_sf: false, contact_ref: d.airtable_id ? `airtable:${d.airtable_id}` : `pub:${d.contact_id}` });
  }, [deepLinkDetail.data, openContact]);

  const { data: tagCatalog = [] } = useContactTagCatalog();
  const { data: staffForFilter = [] } = useStaff();
  const selectOptions: Partial<Record<Field, { value: string; label: string }[]>> = useMemo(() => ({
    stage: CONTACT_STAGE_SELECT, has_deal: YESNO, is_jobs: YESNO, last_activity: RECENCY_OPTIONS,
    flag: MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] })),
    tags: tagCatalog.map((t) => ({ value: t.slug, label: t.label })),
    owner: staffForFilter.map((s) => ({ value: s.email, label: s.name })),
  }), [tagCatalog, staffForFilter]);

  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroup = useCallback((k: string) => setCollapsedGroups((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]), [setCollapsedGroups]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = allContacts.filter((c) => {
      for (const r of rules) if (!ruleApplies(c, r, FILTERABLE)) return false;
      if (!q) return true;
      return (c.full_name ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q)
        || (c.current_company ?? "").toLowerCase().includes(q) || (c.current_title ?? "").toLowerCase().includes(q);
    });
    return sort.key == null ? f : sortBy(f, sort, (c, k) => extract(c, k));
  }, [allContacts, q, rules, sort]);

  const groupLabel = useCallback((k: string) => {
    if (k === "") return "—";
    if (groupBy === "stage") return CONTACT_STAGE_STYLES[k]?.label ?? k;
    if (groupBy === "has_deal") return k === "yes" ? "Has linked deal" : "No linked deal";
    return k;
  }, [groupBy]);

  type DisplayRow = { kind: "row"; c: JobContactWithDeal } | { kind: "header"; key: string; label: string; count: number; collapsed: boolean };
  const grouped: DisplayRow[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = FILTERABLE[groupBy as Field]; if (!field) return null;
    const buckets = new Map<string, JobContactWithDeal[]>();
    for (const c of filtered) { const k = String(field.getValue(c) ?? ""); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(c); }
    const out: DisplayRow[] = [];
    for (const k of [...buckets.keys()].sort((x, y) => groupLabel(x).localeCompare(groupLabel(y)))) {
      const list = buckets.get(k)!; const collapsed = collapsedSet.has(k);
      out.push({ kind: "header", key: k, label: groupLabel(k), count: list.length, collapsed });
      if (!collapsed) for (const c of list) out.push({ kind: "row", c });
    }
    return out;
  }, [filtered, groupBy, collapsedSet, groupLabel]);

  const tableMinWidth = visibleCols.reduce((s, k) => s + widths[k], 0);
  const renderRow = (c: JobContactWithDeal) => (
    <ContactRow key={c.contact_id} contact={c} expanded={expandedId === c.contact_id} onOpen={() => setExpandedId((p) => p === c.contact_id ? null : c.contact_id)} visibleCols={visibleCols}
      selected={selected.has(c.contact_id)} onToggleSelect={() => toggleSelect(c.contact_id)} />
  );

  return (
    <div className="flex flex-col px-5 py-2">
      {showNewContact && <NewContactModal onClose={() => setShowNewContact(false)} />}

      {/* Preview */}
      {previewContact && (
        <div className="mb-2 overflow-hidden rounded-xl border border-border-strong bg-surface">
          <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-4 py-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{initials(previewContact.full_name)}</div>
            <div className="min-w-0 flex-1"><span className="mr-2 text-[14px] font-semibold text-ink">{previewContact.full_name || "—"}</span>{(previewContact.current_title || previewContact.current_company) && <span className="mr-2 text-[12px] text-ink-3">{[previewContact.current_title, previewContact.current_company].filter(Boolean).join(" @ ")}</span>}<span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">Preview · not in pipeline</span></div>
            <div className="flex flex-shrink-0 items-center gap-2">{bannerAddedToJobs ? <span className="text-[12px] font-medium text-accent">✓ In Jobs Pipeline</span> : <button type="button" onClick={() => addContactToJobs({ id: previewContact.contact_id, add: true }, { onSuccess: () => setBannerAddedToJobs(true) })} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90"><Plus size={13} /> Add to Jobs Pipeline</button>}<button type="button" onClick={() => setPreviewContact(null)} className="flex items-center gap-1 text-[12px] font-medium text-ink-3 hover:text-ink"><X size={13} /> Close</button></div>
          </div>
          <ContactDetail contactId={previewContact.contact_id} />
        </div>
      )}

      {/* Toolbar */}
      <Toolbar>
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input placeholder="Search name, company, title, email…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 w-60 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink" />
        </div>
        <AddFilterButton<Field> filterable={FILTERABLE as Record<Field, FieldMeta<unknown>>} selectOptions={selectOptions} onAdd={(r) => setRules((p) => [...p, r])} buttonLabel="Filter" />
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} title="Which contacts to show — jobs prospects only, or the entire contact universe" className={cn("h-7 rounded border px-2 text-[12.5px] outline-none focus:border-accent", scope === "all" ? "border-accent bg-accent-soft font-medium text-accent-ink" : "border-border-strong bg-surface text-ink-2")}>
          <option value="jobs">Jobs prospects</option>
          <option value="all">All contacts</option>
        </select>
        <select value={flagView} onChange={(e) => setFlagView(e.target.value as typeof flagView)} title="Filter by jobs-activation stage flag" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          <option value="all">Any jobs stage</option>
          <option value="flagged">Has jobs stage</option>
          <option value="unflagged">No jobs stage</option>
        </select>
        <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setCollapsedGroups([]); }} title="Group rows by a field" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="whitespace-nowrap font-mono text-[12px] text-ink-4">{isLoading ? "…" : `${filtered.length} contact${filtered.length === 1 ? "" : "s"}`}</span>
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["name"]} onToggle={toggleCol} />
          <SavedViewsPicker<JobsContactsView> scopeKey="jobs-contacts" currentFilters={{ query, rules, visibleCols, groupBy, sort }} onLoad={(v) => { setQuery(v.query ?? ""); setRules(v.rules ?? []); setGroupBy(v.groupBy ?? ""); setCollapsedGroups([]); if (v.visibleCols?.length) replaceVisibleCols(v.visibleCols); if (v.sort) setSort(v.sort); }} />
          <button type="button" onClick={() => setShowNewContact(true)} className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} /> New Contact</button>
        </div>
      </Toolbar>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-x border-t border-accent bg-accent-soft px-3 py-2 text-[12.5px]">
          <span className="font-semibold text-accent-ink">{selected.size} selected</span>
          <input value={flagOwner} onChange={(e) => setFlagOwner(e.target.value)} placeholder="owner email (optional)" className="h-7 w-56 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
          <button type="button" disabled={flagContacts.isPending} onClick={() => flagContacts.mutate({ contact_ids: [...selected], owner_email: flagOwner.trim() || undefined }, { onSuccess: () => setSelected(new Set()) })} className="inline-flex h-7 items-center gap-1 rounded bg-accent px-3 font-medium text-white hover:opacity-90 disabled:opacity-50"><Zap size={12} /> Flag for jobs activation</button>
          <select defaultValue="" onChange={(e) => { const st = e.target.value; if (!st) return; flagContacts.mutate({ contact_ids: [...selected], owner_email: flagOwner.trim() || undefined, stage: st }, { onSuccess: () => setSelected(new Set()) }); e.currentTarget.value = ""; }} className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
            <option value="">Set stage…</option>
            {MEMBERSHIP_STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button type="button" onClick={() => { [...selected].forEach((id) => unflag.mutate(id)); setSelected(new Set()); }} className="h-7 rounded border border-border-strong bg-surface px-3 text-ink-2 hover:text-ink">Unflag</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear selection</button>
        </div>
      )}

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => <FilterChip key={r.id} label={describeRule(r, FILTERABLE, (f, v) => f === "stage" ? (CONTACT_STAGE_STYLES[v]?.label ?? v) : f === "flag" ? (MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v) : f === "tags" ? (tagCatalog.find((t) => t.slug === v)?.label ?? v) : f === "owner" ? (staffForFilter.find((s) => s.email === v)?.name ?? v) : f === "last_activity" ? recencyLabel(v) : v)} onRemove={() => setRules((p) => p.filter((x) => x.id !== r.id))} />)}
          <button type="button" onClick={() => setRules([])} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}

      {universeTruncated && (
        <div className="border-x border-t border-amber-300 bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900">
          Filters matched {serverTotal.toLocaleString()} contacts — showing the first {allContacts.length.toLocaleString()}. Refine to narrow further.
        </div>
      )}

      <div
        className="overflow-auto rounded-b-lg border border-border-strong bg-surface"
        style={{ maxHeight: "calc(100vh - 220px)" }}
      >
        {/* Bounded data-grid viewport: scrolls both axes internally with a
            sticky header and pinned first column (same shell as
            Opportunities); columns keep real, user-resizable pixel widths. */}
        <table className="w-full table-fixed border-collapse" style={{ minWidth: tableMinWidth }}>
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-20 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>{visibleCols.map((key, idx) => (
              <ResizableTh
                key={key}
                width={widths[key]}
                onStartResize={(e) => startResize(key, e)}
                isLast={idx === visibleCols.length - 1}
                className={cn("py-1.5 font-semibold", idx === 0 && "sticky left-0 z-30")}
              >
                {SORTABLE.has(key) ? <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} /> : COL_LABELS[key]}
              </ResizableTh>
            ))}</tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading contacts…</td></tr>
            ) : isError ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-red">Couldn't load contacts.{" "}<button type="button" className="text-accent underline underline-offset-2" onClick={() => refetch()}>Retry</button></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">No contacts match.{" "}<button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setRules([]); }}>Clear filters</button></td></tr>
            ) : grouped ? (
              grouped.map((item) => item.kind === "header" ? (
                <tr key={`g-${item.key}`} className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2" onClick={() => toggleGroup(item.key)}>
                  <td colSpan={visibleCols.length} className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2"><span className="inline-block w-3 text-ink-3">{item.collapsed ? "▸" : "▾"}</span>{item.label}<span className="ml-2 normal-case tracking-normal text-ink-3">{item.count}</span></td>
                </tr>
              ) : renderRow(item.c))
            ) : (
              <>
                {(showAllRows ? filtered : filtered.slice(0, 300)).map(renderRow)}
                {!showAllRows && filtered.length > 300 && (
                  <tr>
                    <td colSpan={visibleCols.length} className="border-t border-border-strong px-6 py-2.5 text-center text-[12px] text-ink-3">
                      Showing 300 of {filtered.length.toLocaleString()} —{" "}
                      <button type="button" className="text-accent underline underline-offset-2" onClick={() => setShowAllRows(true)}>show all</button>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
