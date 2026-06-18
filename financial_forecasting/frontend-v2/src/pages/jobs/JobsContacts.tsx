/**
 * Jobs · Contacts — contact-level view.
 *
 * A flat, individual-contact table (the account-level rollup lives on the
 * Accounts tab). Search / stage filter / sortable headers; clicking a row
 * expands that contact's full detail INLINE (activity, connected staff, linked
 * deal). The "find any contact" search (SF / LinkedIn / Jobs) sits on top:
 * picking someone already a prospect expands their row; picking someone new
 * shows a preview with an Add-to-Jobs CTA.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Linkedin, Plus, Search, UserSearch, X } from "lucide-react";

import { ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { ContactExpandTabs, jobsContactPath } from "@/components/jobs/jobsEntity";
import { withReferrer } from "@/components/detail";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { useSort, sortBy } from "@/lib/sort";
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

const STAGE_FILTER: { value: string; label: string }[] = [
  { value: "", label: "All stages" },
  ...CONTACT_STAGE_SELECT,
];

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

type SortKey = "name" | "title" | "company" | "stage";

function extract(c: JobContactWithDeal, key: SortKey): string {
  switch (key) {
    case "name":    return c.full_name ?? "";
    case "title":   return c.current_title ?? "";
    case "company": return c.current_company ?? "";
    case "stage":   return c.contact_stage ?? "";
  }
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

// ── Contact row + inline detail ─────────────────────────────────────────────────

function ContactRow({ contact, expanded, onOpen }: { contact: JobContactWithDeal; expanded: boolean; onOpen: () => void }) {
  const updateContact = useUpdateContact();
  return (
    <Fragment>
      <tr id={`contact-${contact.contact_id}`} className={cn("cursor-pointer border-t border-border-strong hover:bg-surface-2/40", expanded && "bg-surface-2/40")} onClick={onOpen}>
        <td className="px-3 py-1.5 align-middle">
          <span className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">{initials(contact.full_name)}</span>
            <span className="truncate text-[13px] font-medium text-ink">{contact.full_name || "—"}</span>
            <Link to={jobsContactPath(contact.contact_id)} state={withReferrer({ pathname: "/jobs", label: "Jobs" })} onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-4 hover:text-accent" title="Open contact detail"><ExternalLink size={12} /></Link>
          </span>
        </td>
        <td className="px-3 py-1.5 align-middle"><span className="truncate text-[12.5px] text-ink-2">{contact.current_title || "—"}</span></td>
        <td className="px-3 py-1.5 align-middle"><span className="truncate text-[12.5px] text-ink-2">{contact.current_company || "—"}</span></td>
        <td className="px-3 py-1.5 align-middle">
          {contact.email
            ? <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()} className="truncate text-[12.5px] text-ink-2 hover:text-accent hover:underline">{contact.email}</a>
            : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-3 py-1.5 align-middle" onClick={(e) => e.stopPropagation()}>
          <InlineSelect<string>
            value={contact.contact_stage}
            options={CONTACT_STAGE_SELECT}
            emptyLabel="—"
            renderValue={(v) => <ContactStagePill stage={v ?? null} />}
            onSave={(v) => new Promise<void>((resolve, reject) =>
              updateContact.mutate({ id: contact.contact_id, contact_stage: v || null }, { onSuccess: () => resolve(), onError: reject }),
            )}
          />
        </td>
        <td className="px-3 py-1.5 align-middle">
          {contact.deal
            ? <span className="truncate text-[12px] text-ink-2">{contact.deal.account_name}<span className="ml-1 text-[10.5px] text-ink-4">{STAGE_LABELS[contact.deal.stage as JobStage] ?? contact.deal.stage}</span></span>
            : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-3 py-1.5 align-middle">
          {contact.linkedin_url
            ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-accent"><Linkedin size={14} /></a>
            : <span className="text-ink-4">—</span>}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface-2/20">
          <td colSpan={7} className="p-0">
            <ContactExpandTabs contactId={contact.contact_id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Main component ────────────────────────────────────────────────────────────────

export function JobsContacts(
  { initialQuery, initialContactId }: { initialQuery?: string; initialContactId?: number } = {},
) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [stageFilter, setStageFilter] = useState("");
  const [showNewContact, setShowNewContact] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { sort, toggle } = useSort<SortKey>({ key: "name", direction: "asc" });

  // Find-any-contact search (cross SF / LinkedIn / Jobs) — seed from ?q=.
  const [globalSearch, setGlobalSearch] = useState(initialQuery ?? "");
  const [previewContact, setPreviewContact] = useState<ContactSearchResult | null>(null);
  const [showDropdown, setShowDropdown] = useState(Boolean(initialQuery));
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addedToJobsIds, setAddedToJobsIds] = useState<Set<number>>(new Set());
  const [bannerAddedToJobs, setBannerAddedToJobs] = useState(false);

  const { data: globalSearchResults } = useContactSearch(globalSearch);
  const searchResults = globalSearchResults ?? [];
  const { mutate: addContactToJobs } = useAddContactToJobs();

  const { data: rawData, isLoading } = useJobsContacts({ limit: 500 });
  const allContacts: JobContactWithDeal[] = useMemo(() => rawData?.data ?? [], [rawData]);

  // Open a contact: expand inline if they're in the list; else preview (Add CTA).
  const openContact = useCallback(
    (result: ContactSearchResult) => {
      const inList = allContacts.some((c) => c.contact_id === result.contact_id);
      if (inList) {
        setExpandedId(result.contact_id);
        setPreviewContact(null);
        requestAnimationFrame(() => document.getElementById(`contact-${result.contact_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
      } else {
        setPreviewContact(result);
        setBannerAddedToJobs(false);
      }
    },
    [allContacts],
  );

  // Deep-link ?contact=<id>.
  const deepLinkDetail = useContactDetail(initialContactId ?? null);
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !deepLinkDetail.data) return;
    const d = deepLinkDetail.data;
    openedDeepLink.current = true;
    openContact({
      contact_id: d.contact_id, full_name: d.full_name, email: d.email,
      current_title: d.current_title, current_company: d.current_company,
      source: null, airtable_id: d.airtable_id, contact_stage: d.contact_stage,
      in_sf: false, contact_ref: d.airtable_id ? `airtable:${d.airtable_id}` : `pub:${d.contact_id}`,
    });
  }, [deepLinkDetail.data, openContact]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = allContacts.filter((c) => {
      if (stageFilter && c.contact_stage !== stageFilter) return false;
      if (!q) return true;
      return (
        (c.full_name ?? "").toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q) ||
        (c.current_company ?? "").toLowerCase().includes(q) ||
        (c.current_title ?? "").toLowerCase().includes(q)
      );
    });
    return sort.key == null ? f : sortBy(f, sort, (c, key) => extract(c, key));
  }, [allContacts, q, stageFilter, sort]);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      {showNewContact && <NewContactModal onClose={() => setShowNewContact(false)} />}

      {/* Find any contact */}
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
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { openContact(result); setGlobalSearch(""); setShowDropdown(false); }} className="flex min-w-0 flex-1 items-center gap-3 text-left">
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

      {/* Preview of a contact not yet in the pipeline */}
      {previewContact && (
        <div className="overflow-hidden rounded-xl border border-border-strong bg-surface">
          <div className="flex items-center gap-3 border-b border-border-strong bg-surface-2 px-4 py-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">{initials(previewContact.full_name)}</div>
            <div className="min-w-0 flex-1">
              <span className="mr-2 text-[14px] font-semibold text-ink">{previewContact.full_name || "—"}</span>
              {(previewContact.current_title || previewContact.current_company) && (
                <span className="mr-2 text-[12px] text-ink-3">{[previewContact.current_title, previewContact.current_company].filter(Boolean).join(" @ ")}</span>
              )}
              <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">Preview · not in pipeline</span>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {bannerAddedToJobs ? (
                <span className="text-[12px] font-medium text-accent">✓ In Jobs Pipeline</span>
              ) : (
                <button type="button" onClick={() => { addContactToJobs({ id: previewContact.contact_id, add: true }, { onSuccess: () => setBannerAddedToJobs(true) }); }} className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90"><Plus size={13} /> Add to Jobs Pipeline</button>
              )}
              <button type="button" onClick={() => setPreviewContact(null)} className="flex items-center gap-1 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink"><X size={13} /> Close</button>
            </div>
          </div>
          <ContactDetail contactId={previewContact.contact_id} />
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input placeholder="Search name, company, title, email…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 w-60 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink" />
        </div>
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} title="Filter by stage" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {STAGE_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">{isLoading ? "…" : `${filtered.length} contact${filtered.length === 1 ? "" : "s"}`}</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setShowNewContact(true)} className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} /> New Contact</button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-auto rounded-lg border border-border-strong bg-surface">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold"><SortableHeader label="Name" sortKey="name" sort={sort} onToggle={toggle} /></th>
              <th className="px-3 py-1.5 text-left font-semibold"><SortableHeader label="Title" sortKey="title" sort={sort} onToggle={toggle} /></th>
              <th className="px-3 py-1.5 text-left font-semibold"><SortableHeader label="Company" sortKey="company" sort={sort} onToggle={toggle} /></th>
              <th className="px-3 py-1.5 text-left font-semibold">Email</th>
              <th className="w-[130px] px-3 py-1.5 text-left font-semibold"><SortableHeader label="Stage" sortKey="stage" sort={sort} onToggle={toggle} /></th>
              <th className="px-3 py-1.5 text-left font-semibold">Linked deal</th>
              <th className="w-[70px] px-3 py-1.5 text-left font-semibold">LinkedIn</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading contacts…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  No contacts match your filters.{" "}
                  <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setStageFilter(""); }}>Clear filters</button>
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <ContactRow key={c.contact_id} contact={c} expanded={expandedId === c.contact_id} onOpen={() => setExpandedId((prev) => (prev === c.contact_id ? null : c.contact_id))} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
