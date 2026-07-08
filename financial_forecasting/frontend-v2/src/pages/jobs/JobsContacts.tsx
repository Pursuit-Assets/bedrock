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
import { useSessionState } from "@/lib/useSessionState";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";
import { cn } from "@/lib/utils";
import {
  useJobsContacts, useUpdateContact, useAddContactToJobs,
  useContactDetail, useCreateContact, STAGE_LABELS,
  useFlagContactsForJobs, useUnflagJobsContact, MEMBERSHIP_STAGE_LABELS, MEMBERSHIP_STAGES,
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
function ContactStagePill({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-ink-4">—</span>;
  const s = CONTACT_STAGE_STYLES[stage];
  if (!s) return <span className="text-[12px] text-ink-2">{stage}</span>;
  return <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", s.className)}>{s.label}</span>;
}

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
type ColKey = "name" | "flag" | "title" | "company" | "industry" | "stage" | "warmth" | "roles" | "apps" | "tasks" | "connected" | "deal" | "email" | "linkedin";
const COLUMN_ORDER: ColKey[] = ["name", "flag", "title", "company", "industry", "stage", "warmth", "roles", "apps", "tasks", "connected", "deal", "email", "linkedin"];
const DEFAULT_VISIBLE: ColKey[] = ["name", "flag", "title", "company", "connected", "warmth", "roles", "apps"];
const COL_LABELS: Record<ColKey, string> = {
  name: "Name", flag: "Jobs stage", title: "Title", company: "Company", industry: "Industry", stage: "Contact stage",
  warmth: "Warmth", roles: "Open roles", apps: "Builder apps", tasks: "Open tasks", connected: "Connected staff", deal: "Linked deal", email: "Email", linkedin: "LinkedIn",
};
const COL_WEIGHT: Record<ColKey, number> = {
  name: 16, flag: 11, title: 12, company: 13, industry: 11, stage: 9, warmth: 8, roles: 7, apps: 8, tasks: 7, connected: 13, deal: 12, email: 14, linkedin: 5,
};
const SORTABLE = new Set<ColKey>(["name", "flag", "title", "company", "industry", "stage", "warmth", "roles", "apps", "tasks"]);

function extract(c: JobContactWithDeal, key: ColKey): string | number {
  switch (key) {
    case "name": return (c.full_name ?? "").toLowerCase();
    case "flag": return c.membership_stage ?? "";
    case "title": return (c.current_title ?? "").toLowerCase();
    case "company": return (c.current_company ?? "").toLowerCase();
    case "industry": return (c.company_industry ?? "").toLowerCase();
    case "stage": return c.contact_stage ?? "";
    case "warmth": return warmthRank(warmthInput(c));
    case "roles": return c.open_roles ?? 0;
    case "apps": return c.builder_apps ?? 0;
    case "tasks": return c.open_tasks ?? 0;
    default: return "";
  }
}

// ── filters + grouping ─────────────────────────────────────────────────────────
type Field = "name" | "title" | "company" | "industry" | "stage" | "flag" | "roles" | "apps" | "has_deal" | "connected" | "connection_count" | "last_activity" | "first_contact_date" | "last_contact_date";
const FILTERABLE: Record<Field, FieldMeta<JobContactWithDeal>> = {
  name: { label: "Name", type: "text", getValue: (c) => c.full_name ?? "" },
  title: { label: "Title", type: "text", getValue: (c) => c.current_title ?? "" },
  company: { label: "Company", type: "text", getValue: (c) => c.current_company ?? "" },
  industry: { label: "Industry", type: "text", getValue: (c) => c.company_industry ?? "" },
  stage: { label: "Contact stage", type: "select", getValue: (c) => c.contact_stage ?? "" },
  flag: { label: "Jobs stage", type: "select", getValue: (c) => c.membership_stage ?? "" },
  roles: { label: "Open roles (sourced)", type: "number", getValue: (c) => c.open_roles ?? 0 },
  apps: { label: "Builder applications", type: "number", getValue: (c) => c.builder_apps ?? 0 },
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

// ── row ──────────────────────────────────────────────────────────────────────
function ContactRow({ contact, expanded, onOpen, visibleCols, selected, onToggleSelect }: { contact: JobContactWithDeal; expanded: boolean; onOpen: () => void; visibleCols: ColKey[]; selected: boolean; onToggleSelect: () => void }) {
  const updateContact = useUpdateContact();
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
    title: <span className="truncate text-[12.5px] text-ink-2">{contact.current_title || "—"}</span>,
    company: <span className="truncate text-[12.5px] text-ink-2">{contact.current_company || "—"}</span>,
    stage: (
      <InlineSelect<string> value={contact.contact_stage} options={CONTACT_STAGE_SELECT} emptyLabel="—"
        renderValue={(v) => <ContactStagePill stage={v ?? null} />}
        onSave={(v) => new Promise<void>((res, rej) => updateContact.mutate({ id: contact.contact_id, contact_stage: v || null }, { onSuccess: () => res(), onError: rej }))} />
    ),
    flag: contact.membership_stage
      ? <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10.5px] font-medium text-accent-ink">{MEMBERSHIP_STAGE_LABELS[contact.membership_stage as MembershipStage] ?? contact.membership_stage}</span>
      : <span className="text-ink-4">—</span>,
    industry: <span className="truncate text-[12px] text-ink-3">{contact.company_industry || "—"}</span>,
    roles: (contact.open_roles ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><Briefcase size={11} className="text-ink-4" />{contact.open_roles}</span>
      : <span className="text-ink-4">—</span>,
    apps: (contact.builder_apps ?? 0) > 0
      ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2" title="Jobs builders applied to at this company">{contact.builder_apps}</span>
      : <span className="text-ink-4">—</span>,
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
        {visibleCols.map((key) => (
          <td key={key} className="overflow-hidden px-3 py-1.5 align-middle" onClick={key === "stage" ? (e) => e.stopPropagation() : undefined}>{cells[key]}</td>
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
  const [flagView, setFlagView] = useState<"all" | "flagged" | "unflagged">("all");
  const [flagOwner, setFlagOwner] = useState("");
  const flagContacts = useFlagContactsForJobs();
  const unflag = useUnflagJobsContact();
  const toggleSelect = useCallback((id: number) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const { sort, toggle, setSort } = useSort<ColKey>({ key: "name", direction: "asc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:jobs-contacts", COLUMN_ORDER, DEFAULT_VISIBLE);

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
  const { data: rawData, isLoading, isError, refetch } = useJobsContacts({
    limit: 500, search: debouncedQuery || undefined,
    flagged: flagView === "all" ? undefined : flagView === "flagged",
  });
  const allContacts: JobContactWithDeal[] = useMemo(() => rawData?.data ?? [], [rawData]);

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

  const selectOptions: Partial<Record<Field, { value: string; label: string }[]>> = useMemo(() => ({
    stage: CONTACT_STAGE_SELECT, has_deal: YESNO, last_activity: RECENCY_OPTIONS,
    flag: MEMBERSHIP_STAGES.map((s) => ({ value: s, label: MEMBERSHIP_STAGE_LABELS[s] })),
  }), []);

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

  const visibleWeight = visibleCols.reduce((s, k) => s + COL_WEIGHT[k], 0);
  const renderRow = (c: JobContactWithDeal) => (
    <ContactRow key={c.contact_id} contact={c} expanded={expandedId === c.contact_id} onOpen={() => setExpandedId((p) => p === c.contact_id ? null : c.contact_id)} visibleCols={visibleCols}
      selected={selected.has(c.contact_id)} onToggleSelect={() => toggleSelect(c.contact_id)} />
  );

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      {showNewContact && <NewContactModal onClose={() => setShowNewContact(false)} />}

      {/* Preview */}
      {previewContact && (
        <div className="overflow-hidden rounded-xl border border-border-strong bg-surface">
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
        <select value={flagView} onChange={(e) => setFlagView(e.target.value as typeof flagView)} title="Filter by jobs-activation flag" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          <option value="all">All contacts</option>
          <option value="flagged">Flagged for jobs</option>
          <option value="unflagged">Not flagged</option>
        </select>
        <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setCollapsedGroups([]); }} title="Group rows by a field" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">{isLoading ? "…" : `${filtered.length} contact${filtered.length === 1 ? "" : "s"}`}</span>
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["name"]} onToggle={toggleCol} />
          <SavedViewsPicker<JobsContactsView> scopeKey="jobs-contacts" currentFilters={{ query, rules, visibleCols, groupBy, sort }} onLoad={(v) => { setQuery(v.query ?? ""); setRules(v.rules ?? []); setGroupBy(v.groupBy ?? ""); setCollapsedGroups([]); if (v.visibleCols?.length) replaceVisibleCols(v.visibleCols); if (v.sort) setSort(v.sort); }} />
          <button type="button" onClick={() => setShowNewContact(true)} className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} /> New Contact</button>
        </div>
      </Toolbar>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-[12.5px]">
          <span className="font-semibold text-accent-ink">{selected.size} selected</span>
          <input value={flagOwner} onChange={(e) => setFlagOwner(e.target.value)} placeholder="owner email (optional)" className="h-7 w-56 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
          <button type="button" disabled={flagContacts.isPending} onClick={() => flagContacts.mutate({ contact_ids: [...selected], owner_email: flagOwner.trim() || undefined }, { onSuccess: () => setSelected(new Set()) })} className="inline-flex h-7 items-center gap-1 rounded bg-accent px-3 font-medium text-white hover:opacity-90 disabled:opacity-50"><Zap size={12} /> Flag for jobs activation</button>
          <button type="button" onClick={() => { [...selected].forEach((id) => unflag.mutate(id)); setSelected(new Set()); }} className="h-7 rounded border border-border-strong bg-surface px-3 text-ink-2 hover:text-ink">Unflag</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear selection</button>
        </div>
      )}

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {rules.map((r) => <FilterChip key={r.id} label={describeRule(r, FILTERABLE, (f, v) => f === "stage" ? (CONTACT_STAGE_STYLES[v]?.label ?? v) : f === "flag" ? (MEMBERSHIP_STAGE_LABELS[v as MembershipStage] ?? v) : f === "last_activity" ? recencyLabel(v) : v)} onRemove={() => setRules((p) => p.filter((x) => x.id !== r.id))} />)}
          <button type="button" onClick={() => setRules([])} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
        <table className="w-full table-fixed border-collapse">
          <colgroup>{visibleCols.map((k) => <col key={k} style={{ width: `${(COL_WEIGHT[k] / visibleWeight) * 100}%` }} />)}</colgroup>
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>{visibleCols.map((key) => <th key={key} className="px-3 py-1.5 text-left font-semibold">{SORTABLE.has(key) ? <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} /> : COL_LABELS[key]}</th>)}</tr>
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
              filtered.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
