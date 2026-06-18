/**
 * Jobs · Prospects — account-level view.
 *
 * Prospects roll up into their account (company). Each account is a parent row
 * showing its current opportunity + prospect count; expanding it reveals the
 * contacts at that company; clicking a contact expands its full detail INLINE
 * (activity, connected staff, add-to-jobs) as a nested row — no top popup.
 *
 * The "find any contact" search (SF / LinkedIn / Jobs) is preserved above the
 * table: picking someone already in the pipeline jumps to + expands their row;
 * picking someone new shows a lightweight preview with an Add-to-Jobs CTA.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Linkedin, Plus, Search, UserSearch, X } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { cn } from "@/lib/utils";
import {
  useContactsByAccount,
  useAddContactToJobs,
  useContactSearch,
  useContactDetail,
  useCreateContact,
  STAGE_LABELS,
  type JobStage,
  type DealType,
  type ProspectAccount,
  type ProspectAccountContact,
  type ContactSearchResult,
  type ContactCreateBody,
} from "@/services/jobs";

// ── Contact-stage metadata ─────────────────────────────────────────────────────

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

// ── Deal (opportunity) metadata for the account row ─────────────────────────────

const DEAL_STAGE_STYLE = (stage: JobStage): string => {
  if (stage.startsWith("active")) return "bg-accent-soft text-accent-ink";
  if (stage === "closed_won")     return "bg-green-50 text-green-700";
  if (stage === "closed_lost")    return "bg-stone-100 text-stone-500";
  if (stage.startsWith("on_hold")) return "bg-amber-50 text-amber-600";
  return "bg-stone-100 text-stone-500";
};

const DEAL_TYPE_LABELS: Record<DealType, string> = {
  ft: "FT", pt_contract: "Contract", capstone: "Capstone",
  volunteer: "Volunteer", workshop: "Workshop", pilot: "Pilot",
};

function DealCell({ deal }: { deal: ProspectAccount["deal"] }) {
  if (!deal) return <span className="text-[12px] text-ink-4">No open deal</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", DEAL_STAGE_STYLE(deal.stage))}>
        {STAGE_LABELS[deal.stage] ?? deal.stage}
      </span>
      {deal.deal_type && (
        <span className="text-[10.5px] font-medium uppercase tracking-wide text-ink-4">{DEAL_TYPE_LABELS[deal.deal_type] ?? deal.deal_type}</span>
      )}
    </span>
  );
}

const DEAL_TYPE_FILTER: { value: string; label: string }[] = [
  { value: "all",         label: "All deal types" },
  { value: "ft",          label: "Full-time" },
  { value: "pt_contract", label: "Contract" },
  { value: "capstone",    label: "Capstone" },
  { value: "volunteer",   label: "Volunteer" },
  { value: "workshop",    label: "Workshop" },
  { value: "pilot",       label: "Pilot" },
];

const STAGE_FILTER: { value: string; label: string }[] = [
  { value: "",                 label: "All stages" },
  { value: "active",           label: "Active" },
  { value: "initial_outreach", label: "Outreach" },
  { value: "lead",             label: "Lead" },
  { value: "on_hold",          label: "On Hold" },
];

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

function NewContactModal({ onClose, defaultCompany }: { onClose: () => void; defaultCompany?: string }) {
  const [form, setForm] = useState<NewContactForm>({ ...DEFAULT_NEW_CONTACT_FORM, company: defaultCompany ?? "" });
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

function ContactRow({
  contact,
  expanded,
  onToggle,
}: {
  contact: ProspectAccountContact;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Fragment>
      <tr id={`prospect-${contact.contact_id}`} className={cn("cursor-pointer border-t border-border-strong/70 hover:bg-surface-2/40", expanded && "bg-surface-2/40")} onClick={onToggle}>
        <td className="py-1.5 pl-9 pr-2 align-middle">
          {expanded ? <ChevronDown size={12} className="text-ink-3" /> : <ChevronRight size={12} className="text-ink-3" />}
        </td>
        <td className="px-3 py-1.5 align-middle">
          <span className="flex min-w-0 items-center gap-2">
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">
              {initials(contact.full_name)}
            </span>
            <span className="truncate text-[13px] font-medium text-ink">{contact.full_name || "—"}</span>
          </span>
        </td>
        <td className="px-3 py-1.5 align-middle"><span className="truncate text-[12.5px] text-ink-2">{contact.current_title || "—"}</span></td>
        <td className="px-3 py-1.5 align-middle">
          {contact.email
            ? <a href={`mailto:${contact.email}`} onClick={(e) => e.stopPropagation()} className="truncate text-[12.5px] text-ink-2 hover:text-accent hover:underline">{contact.email}</a>
            : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-3 py-1.5 align-middle"><ContactStagePill stage={contact.contact_stage} /></td>
        <td className="px-3 py-1.5 align-middle">
          {contact.linkedin_url
            ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-accent"><Linkedin size={14} /></a>
            : <span className="text-ink-4">—</span>}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-border-strong/70 bg-surface-2/20">
          <td colSpan={6} className="p-0">
            <div className="border-l-2 border-accent/30 bg-surface">
              <ContactDetail contactId={contact.contact_id} />
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Account row ──────────────────────────────────────────────────────────────────

function AccountRow({
  account,
  expanded,
  onToggle,
  expandedContactId,
  onToggleContact,
}: {
  account: ProspectAccount;
  expanded: boolean;
  onToggle: () => void;
  expandedContactId: number | null;
  onToggleContact: (id: number) => void;
}) {
  return (
    <Fragment>
      <tr className="cursor-pointer border-t border-border-strong bg-surface hover:bg-surface-2/50" onClick={onToggle}>
        <td className="py-2 pl-3 pr-2 align-middle">
          {expanded ? <ChevronDown size={13} className="text-ink-3" /> : <ChevronRight size={13} className="text-ink-3" />}
        </td>
        <td className="px-3 py-2 align-middle" colSpan={2}>
          <span className="flex min-w-0 items-center gap-2.5">
            <AccountAvatar name={account.account} logoUrl={null} size={20} />
            <span className="truncate text-[13.5px] font-semibold text-ink">{account.account}</span>
          </span>
        </td>
        <td className="px-3 py-2 align-middle"><DealCell deal={account.deal} /></td>
        <td className="px-3 py-2 align-middle" colSpan={2}>
          <span className="text-[12px] text-ink-3">{account.contact_count} prospect{account.contact_count === 1 ? "" : "s"}</span>
        </td>
      </tr>
      {expanded && account.contacts.map((c) => (
        <ContactRow
          key={c.contact_id}
          contact={c}
          expanded={expandedContactId === c.contact_id}
          onToggle={() => onToggleContact(c.contact_id)}
        />
      ))}
    </Fragment>
  );
}

// ── Main component ────────────────────────────────────────────────────────────────

export function JobsContacts(
  { initialQuery, initialContactId }: { initialQuery?: string; initialContactId?: number } = {},
) {
  const [query, setQuery] = useState("");
  const [dealType, setDealType] = useState<string>("all");
  const [stageFilter, setStageFilter] = useState<string>("");
  const [showNewContact, setShowNewContact] = useState(false);

  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(new Set());
  const [expandedContactId, setExpandedContactId] = useState<number | null>(null);

  const { data: accounts = [], isLoading } = useContactsByAccount(dealType);

  const toggleAccount = useCallback((acct: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(acct)) next.delete(acct);
      else next.add(acct);
      return next;
    });
  }, []);
  const toggleContact = useCallback((id: number) => {
    setExpandedContactId((prev) => (prev === id ? null : id));
  }, []);

  // ── Find-any-contact search (preserved) ──────────────────────────────────────
  const [globalSearch, setGlobalSearch] = useState(initialQuery ?? "");
  const [previewContact, setPreviewContact] = useState<ContactSearchResult | null>(null);
  const [showDropdown, setShowDropdown] = useState(Boolean(initialQuery));
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addedToJobsIds, setAddedToJobsIds] = useState<Set<number>>(new Set());
  const [bannerAddedToJobs, setBannerAddedToJobs] = useState(false);

  const { data: globalSearchResults } = useContactSearch(globalSearch);
  const searchResults = globalSearchResults ?? [];
  const { mutate: addContactToJobs } = useAddContactToJobs();

  // contact_id → account name, for jump-to-row on selection / deep-link.
  const contactAccountIndex = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accounts) for (const c of a.contacts) m.set(c.contact_id, a.account);
    return m;
  }, [accounts]);

  // Open a contact: if they're already a prospect, expand their account + row
  // inline; otherwise show the preview panel (Add-to-Jobs CTA flow).
  const openContact = useCallback(
    (result: ContactSearchResult) => {
      const acct = contactAccountIndex.get(result.contact_id);
      if (acct) {
        setExpandedAccounts((prev) => new Set(prev).add(acct));
        setExpandedContactId(result.contact_id);
        setPreviewContact(null);
        requestAnimationFrame(() => {
          document.getElementById(`prospect-${result.contact_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      } else {
        setPreviewContact(result);
        setBannerAddedToJobs(false);
      }
    },
    [contactAccountIndex],
  );

  // Deep-link open: ?contact=<id> from the top-bar search.
  const deepLinkDetail = useContactDetail(initialContactId ?? null);
  const openedDeepLink = useRef(false);
  useEffect(() => {
    if (openedDeepLink.current || !deepLinkDetail.data) return;
    const d = deepLinkDetail.data;
    openedDeepLink.current = true;
    openContact({
      contact_id: d.contact_id,
      full_name: d.full_name,
      email: d.email,
      current_title: d.current_title,
      current_company: d.current_company,
      source: null,
      airtable_id: d.airtable_id,
      contact_stage: d.contact_stage,
      in_sf: false,
      contact_ref: d.airtable_id ? `airtable:${d.airtable_id}` : `pub:${d.contact_id}`,
    });
  }, [deepLinkDetail.data, openContact]);

  // ── Client-side filter (search text + contact stage) ──────────────────────────
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return accounts
      .map((a) => {
        const contacts = a.contacts.filter((c) => {
          if (stageFilter && c.contact_stage !== stageFilter) return false;
          if (!q) return true;
          return (
            (c.full_name ?? "").toLowerCase().includes(q) ||
            (c.email ?? "").toLowerCase().includes(q) ||
            (c.current_title ?? "").toLowerCase().includes(q) ||
            a.account.toLowerCase().includes(q)
          );
        });
        return { ...a, contacts, contact_count: contacts.length };
      })
      .filter((a) => a.contacts.length > 0);
  }, [accounts, q, stageFilter]);

  const totalProspects = useMemo(() => filtered.reduce((n, a) => n + a.contact_count, 0), [filtered]);

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
                    onClick={() => { openContact(result); setGlobalSearch(""); setShowDropdown(false); }}
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

      {/* ── Preview of a contact not yet in the pipeline (Add-to-Jobs CTA) ───── */}
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

      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={12} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            placeholder="Search prospects, companies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-60 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
          />
        </div>
        <select value={dealType} onChange={(e) => setDealType(e.target.value)} title="Filter by deal type at the account" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {DEAL_TYPE_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} title="Filter by prospect stage" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {STAGE_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${filtered.length} account${filtered.length === 1 ? "" : "s"} · ${totalProspects} prospect${totalProspects === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setExpandedAccounts(new Set(filtered.map((a) => a.account)))} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Expand all</button>
          <button type="button" onClick={() => { setExpandedAccounts(new Set()); setExpandedContactId(null); }} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Collapse all</button>
          <button type="button" onClick={() => setShowNewContact(true)} className="inline-flex h-7 items-center gap-1.5 rounded border border-ink bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90"><Plus size={13} /> New Contact</button>
        </div>
      </div>

      {/* ── Account-grouped table ─────────────────────────────────────────── */}
      <div className="overflow-auto rounded-lg border border-border-strong bg-surface">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[36px] py-1.5 pl-3" />
              <th className="px-3 py-1.5 text-left font-semibold" colSpan={2}>Account / Prospect</th>
              <th className="px-3 py-1.5 text-left font-semibold">Current deal</th>
              <th className="px-3 py-1.5 text-left font-semibold" colSpan={2}>Stage / Count</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading prospects…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  No prospects match your filters.{" "}
                  <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setStageFilter(""); setDealType("all"); }}>Clear filters</button>
                </td>
              </tr>
            ) : (
              filtered.map((a) => (
                <AccountRow
                  key={a.account}
                  account={a}
                  expanded={expandedAccounts.has(a.account)}
                  onToggle={() => toggleAccount(a.account)}
                  expandedContactId={expandedContactId}
                  onToggleContact={toggleContact}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
