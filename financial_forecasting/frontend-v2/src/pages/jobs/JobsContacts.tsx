/**
 * Jobs · Prospects — configurable contacts table, mirroring the portfolio
 * Accounts page and the Opportunities tab: column chooser, per-column filter
 * rules, group-by, resizable columns, sortable headers, and Saved Views.
 *
 * The "find any contact" search (across SF / LinkedIn / Jobs) + add-to-jobs +
 * the contact detail drawer are preserved above the table; clicking a table row
 * opens the same drawer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linkedin, Plus, Search, UserSearch, X } from "lucide-react";

import { ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { Toolbar } from "@/components/ui/Toolbar";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { useSessionState } from "@/lib/useSessionState";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import {
  AddFilterButton,
  FilterChip,
  describeRule,
  ruleApplies,
  type FieldMeta,
  type FilterRule,
} from "@/pages/cleanup/Filters";
import { cn } from "@/lib/utils";
import {
  useJobsContacts,
  useUpdateContact,
  useAddContactToJobs,
  useContactSearch,
  useContactDetail,
  useCreateContact,
  STAGE_LABELS,
  type JobStage,
  type JobContactWithDeal,
  type ContactSearchResult,
  type ContactCreateBody,
} from "@/services/jobs";

// ── Contact-stage metadata ─────────────────────────────────────────────────────

const CONTACT_STAGE_SELECT: { value: string; label: string }[] = [
  { value: "active",           label: "Active" },
  { value: "initial_outreach", label: "Initial Outreach" },
  { value: "lead",             label: "Lead" },
  { value: "on_hold",          label: "On Hold" },
];

const CONTACT_STAGE_STYLES: Record<string, { label: string; className: string }> = {
  active:           { label: "Active",   className: "bg-green-50 text-green-700" },
  initial_outreach: { label: "Outreach", className: "bg-accent-soft text-accent-ink" },
  lead:             { label: "Lead",     className: "bg-stone-100 text-stone-500" },
  on_hold:          { label: "On Hold",  className: "bg-amber-50 text-amber-600" },
};

function ContactStagePill({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-ink-4">—</span>;
  const s = CONTACT_STAGE_STYLES[stage];
  if (!s) return <span className="text-[12px] text-ink-2">{stage}</span>;
  return (
    <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", s.className)}>
      {s.label}
    </span>
  );
}

// Source is derived — the flat contact list doesn't carry a source column.
type SourceKey = "jobs" | "linkedin" | "other";
const SOURCE_OPTIONS: { value: string; label: string }[] = [
  { value: "jobs",     label: "Jobs" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "other",    label: "Other" },
];
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(SOURCE_OPTIONS.map((s) => [s.value, s.label]));
function sourceOf(c: JobContactWithDeal): SourceKey {
  if (c.airtable_id) return "jobs";
  if (c.linkedin_url) return "linkedin";
  return "other";
}

const SOURCE_BADGE: Record<SourceKey, string> = {
  jobs:     "bg-accent-soft text-accent-ink",
  linkedin: "bg-indigo-50 text-indigo-600",
  other:    "bg-stone-100 text-stone-500",
};

// ── Columns ────────────────────────────────────────────────────────────────────

type ProspectColKey = "name" | "title" | "company" | "email" | "contact_stage" | "source" | "deal" | "linkedin";

const COLUMN_ORDER: ProspectColKey[] = ["name", "title", "company", "email", "contact_stage", "source", "deal", "linkedin"];
const DEFAULT_VISIBLE: ProspectColKey[] = ["name", "title", "company", "email", "contact_stage", "deal"];
const COL_LABELS: Record<ProspectColKey, string> = {
  name: "Name", title: "Title", company: "Company", email: "Email",
  contact_stage: "Stage", source: "Source", deal: "Linked deal", linkedin: "LinkedIn",
};
const DEFAULT_WIDTHS: Record<ProspectColKey, number> = {
  name: 220, title: 200, company: 200, email: 250, contact_stage: 150, source: 110, deal: 230, linkedin: 90,
};

const EDITABLE_COLS = new Set<ProspectColKey>(["contact_stage"]);

function extractProspect(c: JobContactWithDeal, key: ProspectColKey): string | number {
  switch (key) {
    case "name":          return c.full_name ?? "";
    case "title":         return c.current_title ?? "";
    case "company":       return c.current_company ?? "";
    case "email":         return c.email ?? "";
    case "contact_stage": return c.contact_stage ?? "";
    case "source":        return sourceOf(c);
    case "deal":          return c.deal?.account_name ?? "";
    case "linkedin":      return c.linkedin_url ? 1 : 0;
  }
}

// ── Filter rules + group-by metadata ───────────────────────────────────────────

type ProspectField = "name" | "title" | "company" | "email" | "contact_stage" | "source" | "has_deal";

const FILTERABLE: Record<ProspectField, FieldMeta<JobContactWithDeal>> = {
  name:          { label: "Name",        type: "text",   getValue: (c) => c.full_name ?? "" },
  title:         { label: "Title",       type: "text",   getValue: (c) => c.current_title ?? "" },
  company:       { label: "Company",     type: "text",   getValue: (c) => c.current_company ?? "" },
  email:         { label: "Email",       type: "text",   getValue: (c) => c.email ?? "" },
  contact_stage: { label: "Stage",       type: "select", getValue: (c) => c.contact_stage ?? "" },
  source:        { label: "Source",      type: "select", getValue: (c) => sourceOf(c) },
  has_deal:      { label: "Linked deal", type: "select", getValue: (c) => (c.deal ? "yes" : "no") },
};

const GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: "",              label: "No grouping" },
  { value: "company",       label: "Group by Company" },
  { value: "contact_stage", label: "Group by Stage" },
  { value: "source",        label: "Group by Source" },
  { value: "has_deal",      label: "Group by Linked deal" },
];

const HAS_DEAL_OPTIONS = [
  { value: "yes", label: "Has linked deal" },
  { value: "no",  label: "No linked deal" },
];

interface JobsProspectView {
  query?: string;
  rules?: FilterRule<ProspectField>[];
  visibleCols?: ProspectColKey[];
  widths?: Partial<Record<ProspectColKey, number>>;
  groupBy?: string;
  sort?: SortState<ProspectColKey>;
}

/** JobContactWithDeal → the ContactSearchResult shape the detail drawer expects. */
function toSearchResult(c: JobContactWithDeal): ContactSearchResult {
  return {
    contact_id: c.contact_id,
    full_name: c.full_name,
    email: c.email,
    current_title: c.current_title,
    current_company: c.current_company,
    source: null,
    airtable_id: c.airtable_id,
    contact_stage: c.contact_stage,
    in_sf: false,
    contact_ref: c.airtable_id ? `airtable:${c.airtable_id}` : `pub:${c.contact_id}`,
  };
}

// ── New Contact modal ───────────────────────────────────────────────────────────

type ContactStageValue = "active" | "initial_outreach" | "lead" | "on_hold";

const NEW_CONTACT_STAGE_OPTIONS: { value: ContactStageValue; label: string }[] = [
  { value: "lead",             label: "Lead" },
  { value: "initial_outreach", label: "Initial Outreach" },
  { value: "active",           label: "Active" },
  { value: "on_hold",          label: "On Hold" },
];

interface NewContactForm {
  fullName: string; email: string; title: string; company: string;
  linkedIn: string; stage: ContactStageValue; notes: string;
}

const DEFAULT_NEW_CONTACT_FORM: NewContactForm = {
  fullName: "", email: "", title: "", company: "", linkedIn: "", stage: "lead", notes: "",
};

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function NewContactModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState<NewContactForm>(DEFAULT_NEW_CONTACT_FORM);
  const createContact = useCreateContact();

  function set<K extends keyof NewContactForm>(key: K, value: NewContactForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.fullName.trim()) return;
    const body: ContactCreateBody = {
      full_name: form.fullName.trim(),
      email: form.email.trim() || undefined,
      current_title: form.title.trim() || undefined,
      current_company: form.company.trim() || undefined,
      linkedin_url: form.linkedIn.trim() || undefined,
      contact_stage: form.stage,
      notes: form.notes.trim() || undefined,
    };
    await createContact.mutateAsync(body);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">New Contact</h2>
          <button type="button" onClick={onClose} className="text-ink-3 transition-colors hover:text-ink" aria-label="Close"><X size={16} /></button>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Full Name <span className="text-red-500">*</span></label>
            <input type="text" required value={form.fullName} onChange={(e) => set("fullName", e.target.value)} placeholder="Jane Smith" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Email</label>
              <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="jane@acme.com" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Stage</label>
              <select value={form.stage} onChange={(e) => set("stage", e.target.value as ContactStageValue)} className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40">
                {NEW_CONTACT_STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Title</label>
              <input type="text" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Engineering Manager" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Company</label>
              <input type="text" value={form.company} onChange={(e) => set("company", e.target.value)} placeholder="Acme Corp" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">LinkedIn URL</label>
            <input type="url" value={form.linkedIn} onChange={(e) => set("linkedIn", e.target.value)} placeholder="https://linkedin.com/in/janesmith" className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Add any initial notes…" className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40" />
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-[13px] font-medium text-ink-3 transition-colors hover:text-ink">Cancel</button>
            <button type="submit" disabled={createContact.isPending || !form.fullName.trim()} className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50">
              {createContact.isPending ? <Spinner /> : <Plus size={13} />}
              {createContact.isPending ? "Creating…" : "Create Contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Prospect row ─────────────────────────────────────────────────────────────────

function ProspectRow({
  contact,
  visibleCols,
  onOpen,
}: {
  contact: JobContactWithDeal;
  visibleCols: ProspectColKey[];
  onOpen: (c: JobContactWithDeal) => void;
}) {
  const updateContact = useUpdateContact();
  const src = sourceOf(contact);

  const cells: Record<ProspectColKey, React.ReactNode> = {
    name: (
      <span className="flex min-w-0 items-center gap-2">
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">
          {initials(contact.full_name)}
        </span>
        <span className="truncate text-[13px] font-medium text-ink">{contact.full_name || "—"}</span>
      </span>
    ),
    title: <span className="truncate text-[12.5px] text-ink-2">{contact.current_title || "—"}</span>,
    company: <span className="truncate text-[12.5px] text-ink-2">{contact.current_company || "—"}</span>,
    email: contact.email
      ? <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()} className="truncate text-[12.5px] text-ink-2 hover:text-accent hover:underline">{contact.email}</a>
      : <span className="text-ink-4">—</span>,
    contact_stage: (
      <InlineSelect<string>
        value={contact.contact_stage}
        options={CONTACT_STAGE_SELECT}
        emptyLabel="—"
        renderValue={(v) => <ContactStagePill stage={v ?? null} />}
        onSave={(v) => new Promise<void>((resolve, reject) =>
          updateContact.mutate({ id: contact.contact_id, contact_stage: v || null }, { onSuccess: () => resolve(), onError: reject }),
        )}
      />
    ),
    source: (
      <span className={cn("inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide leading-none", SOURCE_BADGE[src])}>
        {SOURCE_LABELS[src]}
      </span>
    ),
    deal: contact.deal
      ? (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[12px] text-ink-2">{contact.deal.account_name}</span>
          <span className="truncate text-[10.5px] text-ink-4">{STAGE_LABELS[contact.deal.stage as JobStage] ?? contact.deal.stage}</span>
        </span>
      )
      : <span className="text-ink-4">—</span>,
    linkedin: contact.linkedin_url
      ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-accent"><Linkedin size={14} /></a>
      : <span className="text-ink-4">—</span>,
  };

  return (
    <tr className="cursor-pointer border-t border-border-strong hover:bg-surface-2/40" onClick={() => onOpen(contact)}>
      {visibleCols.map((key) => (
        <td
          key={key}
          className="overflow-hidden px-3 py-1.5 align-middle"
          onClick={EDITABLE_COLS.has(key) ? (e) => e.stopPropagation() : undefined}
        >
          {cells[key]}
        </td>
      ))}
    </tr>
  );
}

// ── Main component ────────────────────────────────────────────────────────────────

const EMPTY_COLLAPSED: string[] = [];

export function JobsContacts(
  { initialQuery, initialContactId }: { initialQuery?: string; initialContactId?: number } = {},
) {
  // Table state (mirrors Opportunities/Accounts)
  const [query, setQuery] = useState(initialQuery ?? "");
  const [rules, setRules] = useState<FilterRule<ProspectField>[]>([]);
  const [groupBy, setGroupBy] = useSessionState<string>("jobs-prospects:groupBy", "");
  const [collapsedGroups, setCollapsedGroups] = useSessionState<string[]>("jobs-prospects:groupCollapsed", EMPTY_COLLAPSED);
  const [showNewContact, setShowNewContact] = useState(false);

  const { sort, toggle, setSort } = useSort<ProspectColKey>({ key: "name", direction: "asc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ProspectColKey>("bedrock-v2:vis:jobs-prospects", COLUMN_ORDER, DEFAULT_VISIBLE);
  const { widths, startResize, replaceAll: replaceWidths } =
    useColumnWidths<ProspectColKey>("bedrock-v2:cols:jobs-prospects:v1", DEFAULT_WIDTHS);

  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroup = useCallback(
    (key: string) => setCollapsedGroups((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])),
    [setCollapsedGroups],
  );

  // Find-any-contact search (preserved) — seed from ?q= deep-link.
  const [globalSearch, setGlobalSearch] = useState(initialQuery ?? "");
  const [selectedContact, setSelectedContact] = useState<ContactSearchResult | null>(null);
  const [showDropdown, setShowDropdown] = useState(Boolean(initialQuery));
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addedToJobsIds, setAddedToJobsIds] = useState<Set<number>>(new Set());
  const [bannerAddedToJobs, setBannerAddedToJobs] = useState(false);

  const { data: globalSearchResults } = useContactSearch(globalSearch);
  const searchResults = globalSearchResults ?? [];
  const { mutate: addContactToJobs } = useAddContactToJobs();

  // Deep-link open: ?contact=<id> from the top-bar search opens that contact's
  // detail drawer once (even LinkedIn-only contacts that aren't jobs prospects).
  const deepLinkDetail = useContactDetail(initialContactId ?? null);
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !deepLinkDetail.data) return;
    openedDeepLink.current = true;
    setSelectedContact(toSearchResult(deepLinkDetail.data));
  }, [deepLinkDetail.data]);

  // Flat prospect list (all jobs-pipeline contacts) — filter/sort/group client-side.
  const { data: rawData, isLoading } = useJobsContacts({ limit: 500 });
  const allContacts: JobContactWithDeal[] = rawData?.data ?? [];

  const selectOptions: Partial<Record<ProspectField, { value: string; label: string }[]>> = useMemo(
    () => ({ contact_stage: CONTACT_STAGE_SELECT, source: SOURCE_OPTIONS, has_deal: HAS_DEAL_OPTIONS }),
    [],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = allContacts.filter((c) => {
      if (
        q &&
        !(
          (c.full_name ?? "").toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q) ||
          (c.current_company ?? "").toLowerCase().includes(q) ||
          (c.current_title ?? "").toLowerCase().includes(q)
        )
      )
        return false;
      for (const r of rules) if (!ruleApplies(c, r, FILTERABLE)) return false;
      return true;
    });
    return sort.key == null ? f : sortBy(f, sort, (c, key) => extractProspect(c, key));
  }, [allContacts, q, rules, sort]);

  const groupLabelFor = useCallback(
    (k: string) => {
      if (k === "") return "—";
      if (groupBy === "contact_stage") return CONTACT_STAGE_STYLES[k]?.label ?? k;
      if (groupBy === "source") return SOURCE_LABELS[k] ?? k;
      if (groupBy === "has_deal") return k === "yes" ? "Has linked deal" : "No linked deal";
      return k;
    },
    [groupBy],
  );

  type DisplayRow =
    | { kind: "row"; contact: JobContactWithDeal }
    | { kind: "header"; key: string; label: string; count: number; collapsed: boolean };
  const groupedRows: DisplayRow[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = FILTERABLE[groupBy as ProspectField];
    if (!field) return null;
    const buckets = new Map<string, JobContactWithDeal[]>();
    for (const c of filtered) {
      const raw = field.getValue(c);
      const k = raw == null || raw === "" ? "" : String(raw);
      const list = buckets.get(k);
      if (list) list.push(c);
      else buckets.set(k, [c]);
    }
    const keys = [...buckets.keys()].sort((a, b) => groupLabelFor(a).localeCompare(groupLabelFor(b)));
    const out: DisplayRow[] = [];
    for (const k of keys) {
      const list = buckets.get(k) ?? [];
      const collapsed = collapsedSet.has(k);
      out.push({ kind: "header", key: k, label: groupLabelFor(k), count: list.length, collapsed });
      if (!collapsed) for (const c of list) out.push({ kind: "row", contact: c });
    }
    return out;
  }, [filtered, groupBy, collapsedSet, groupLabelFor]);

  const tableMinWidth = totalWidth(widths);
  const openDrawer = useCallback((c: JobContactWithDeal) => {
    setSelectedContact(toSearchResult(c));
    setBannerAddedToJobs(false);
  }, []);
  const renderRow = (c: JobContactWithDeal) => (
    <ProspectRow key={c.contact_id} contact={c} visibleCols={visibleCols} onOpen={openDrawer} />
  );

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      {showNewContact && <NewContactModal onClose={() => setShowNewContact(false)} />}

      {/* ── Find any contact (across SF / LinkedIn / Jobs) ─────────────────── */}
      <div className="relative">
        <div className="relative">
          <UserSearch size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={globalSearch}
            onChange={(e) => { setGlobalSearch(e.target.value); setShowDropdown(true); }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => { blurTimerRef.current = setTimeout(() => setShowDropdown(false), 150); }}
            placeholder="Find any contact across SF, LinkedIn, or Jobs pipeline…"
            className="w-full rounded-xl border-2 border-border-strong bg-surface py-2.5 pl-10 pr-4 text-[14px] transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none"
          />
          {globalSearch && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setGlobalSearch(""); setShowDropdown(false); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 transition-colors hover:text-ink"><X size={14} /></button>
          )}
        </div>

        {showDropdown && globalSearch.trim().length >= 1 && searchResults.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-border-strong bg-surface shadow-lg">
            {searchResults.slice(0, 10).map((result) => {
              const isJobs = !!result.airtable_id;
              const isSF = result.in_sf;
              const isLinkedIn = result.source === "linkedin_import";
              return (
                <div key={result.contact_id} className="flex w-full items-center gap-3 border-b border-border-strong px-4 py-2.5 transition-colors last:border-0 hover:bg-surface-2">
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setSelectedContact(result); setBannerAddedToJobs(false); setGlobalSearch(""); setShowDropdown(false); }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{initials(result.full_name)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">{result.full_name || "—"}</div>
                      {(result.current_title || result.current_company) && (
                        <div className="truncate text-[11px] text-ink-3">{[result.current_title, result.current_company].filter(Boolean).join(" @ ")}</div>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      {isJobs ? <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-0.5 font-medium leading-none text-accent-ink" style={{ fontSize: 10 }}>Jobs</span>
                        : isSF ? <span className="inline-flex items-center rounded-full bg-sky-50 px-1.5 py-0.5 font-medium leading-none text-sky-600" style={{ fontSize: 10 }}>SF</span>
                        : isLinkedIn ? <span className="inline-flex items-center rounded-full bg-indigo-50 px-1.5 py-0.5 font-medium leading-none text-indigo-600" style={{ fontSize: 10 }}>LinkedIn</span>
                        : null}
                    </div>
                  </button>
                  {!isJobs && (
                    <div className="ml-2 flex-shrink-0">
                      {addedToJobsIds.has(result.contact_id) ? (
                        <span className="text-[11px] font-medium text-accent">✓ Added</span>
                      ) : (
                        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); addContactToJobs({ id: result.contact_id, add: true }, { onSuccess: () => setAddedToJobsIds((prev) => new Set(prev).add(result.contact_id)) }); }} className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:border-accent hover:text-accent">+ Add to Jobs</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Selected contact drawer ───────────────────────────────────────── */}
      {selectedContact && (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-border-strong bg-surface-2 px-4 py-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{initials(selectedContact.full_name)}</div>
            <div className="min-w-0 flex-1">
              <span className="mr-2 text-[14px] font-semibold text-ink">{selectedContact.full_name || "—"}</span>
              {(selectedContact.current_title || selectedContact.current_company) && (
                <span className="mr-2 text-[12px] text-ink-3">{[selectedContact.current_title, selectedContact.current_company].filter(Boolean).join(" @ ")}</span>
              )}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {!selectedContact.airtable_id && !selectedContact.in_sf && (
                bannerAddedToJobs ? (
                  <span className="text-[12px] font-medium text-accent">✓ In Jobs Pipeline</span>
                ) : (
                  <button type="button" onClick={() => { addContactToJobs({ id: selectedContact.contact_id, add: true }, { onSuccess: () => setBannerAddedToJobs(true) }); }} className="flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-[12px] font-medium text-ink-3 transition-colors hover:border-accent hover:text-accent">+ Add to Jobs Pipeline</button>
                )
              )}
              <button type="button" onClick={() => setSelectedContact(null)} className="flex items-center gap-1 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink"><X size={13} /> Close</button>
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-border-strong bg-surface">
            <ContactDetail contactId={selectedContact.contact_id} />
          </div>
          <hr className="my-0 border-border-strong" />
        </>
      )}

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <Toolbar>
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            placeholder="Search name, company, title, email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-60 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <AddFilterButton<ProspectField>
          filterable={FILTERABLE as Record<ProspectField, FieldMeta<unknown>>}
          selectOptions={selectOptions}
          onAdd={(r) => setRules((prev) => [...prev, r])}
          buttonLabel="Filter"
        />
        <select
          value={groupBy}
          onChange={(e) => { setGroupBy(e.target.value); setCollapsedGroups([]); }}
          title="Group rows by a field"
          className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent"
        >
          {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${filtered.length} contact${filtered.length === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["name"]} onToggle={toggleCol} />
          <SavedViewsPicker<JobsProspectView>
            scopeKey="jobs-prospects"
            currentFilters={{ query, rules, visibleCols, widths, groupBy, sort }}
            onLoad={(v) => {
              setQuery(v.query ?? "");
              setRules(v.rules ?? []);
              setGroupBy(v.groupBy ?? "");
              setCollapsedGroups([]);
              if (v.visibleCols && v.visibleCols.length > 0) replaceVisibleCols(v.visibleCols);
              if (v.widths && Object.keys(v.widths).length > 0) replaceWidths(v.widths);
              if (v.sort) setSort(v.sort);
            }}
          />
          <button type="button" onClick={() => setShowNewContact(true)} className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} /> New Contact</button>
        </div>
      </Toolbar>

      {/* Active filter chips */}
      {rules.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-x border-t border-border-strong bg-surface px-3 py-2">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, FILTERABLE, (field, v) => {
                if (field === "contact_stage") return CONTACT_STAGE_STYLES[v]?.label ?? v;
                if (field === "source") return SOURCE_LABELS[v] ?? v;
                if (field === "has_deal") return v === "yes" ? "Has linked deal" : "No linked deal";
                return v;
              })}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button type="button" onClick={() => setRules([])} className="ml-1 whitespace-nowrap text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      ) : null}

      <div className="overflow-auto rounded-b-lg border border-border-strong bg-surface">
        <table className="border-collapse" style={{ tableLayout: "fixed", width: "100%", minWidth: tableMinWidth }}>
          <ColGroup order={visibleCols} widths={widths} />
          <thead className="sticky top-0 z-10">
            <tr>
              {visibleCols.map((key, idx) => (
                <ResizableTh key={key} width={widths[key]} onStartResize={(e) => startResize(key, e)} isLast={idx === visibleCols.length - 1}>
                  <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading prospects…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  No prospects match your filters.{" "}
                  <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setRules([]); }}>Clear filters</button>
                </td>
              </tr>
            ) : groupedRows ? (
              groupedRows.map((item) =>
                item.kind === "header" ? (
                  <tr key={`grp-${item.key}`} className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2" onClick={() => toggleGroup(item.key)}>
                    <td colSpan={visibleCols.length} className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2">
                      <span className="inline-block w-3 text-ink-3">{item.collapsed ? "▸" : "▾"}</span>
                      {item.label}
                      <span className="ml-2 normal-case tracking-normal text-ink-3">{item.count}</span>
                    </td>
                  </tr>
                ) : (
                  renderRow(item.contact)
                ),
              )
            ) : (
              filtered.map((c) => renderRow(c))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
