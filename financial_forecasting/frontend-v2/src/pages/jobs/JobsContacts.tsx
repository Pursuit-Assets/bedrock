/**
 * Jobs · Prospects.
 *
 * Account-grouped prospect view modelled on the portfolio Accounts page:
 * each account is a chevron-to-expand row that opens a tabbed
 * {@link ProspectAccountExpandPanel} (Contacts / Tasks / Comments / Activity).
 * A global contact search lets you find any contact across SF / LinkedIn /
 * the Jobs pipeline and add them in; the per-account search box filters the
 * grouped table by account name or nested contact name/email.
 */
import { Fragment, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  UserSearch,
  X,
} from "lucide-react";

import { ProspectAccountExpandPanel, ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { sortBy, useSort } from "@/lib/sort";
import { cn } from "@/lib/utils";
import {
  useAddContactToJobs,
  useContactSearch,
  useCreateContact,
  type ContactCreateBody,
  type ContactSearchResult,
} from "@/services/jobs";
import { useAccountsByAccount, type AccountGroup } from "@/services/jobsAccounts";

// ── Constants ────────────────────────────────────────────────────────────────

const CONTACT_STAGE_OPTIONS = [
  { value: "",                 label: "All" },
  { value: "active",           label: "Active" },
  { value: "initial_outreach", label: "Outreach" },
  { value: "lead",             label: "Lead" },
  { value: "on_hold",          label: "On Hold" },
];

// ── New Contact modal ─────────────────────────────────────────────────────────

type ContactStageValue = "active" | "initial_outreach" | "lead" | "on_hold";

const NEW_CONTACT_STAGE_OPTIONS: { value: ContactStageValue; label: string }[] = [
  { value: "lead",             label: "Lead" },
  { value: "initial_outreach", label: "Initial Outreach" },
  { value: "active",           label: "Active" },
  { value: "on_hold",          label: "On Hold" },
];

interface NewContactForm {
  fullName: string;
  email: string;
  title: string;
  company: string;
  linkedIn: string;
  stage: ContactStageValue;
  notes: string;
}

const DEFAULT_NEW_CONTACT_FORM: NewContactForm = {
  fullName: "",
  email: "",
  title: "",
  company: "",
  linkedIn: "",
  stage: "lead",
  notes: "",
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <h2 className="text-[15px] font-semibold text-ink">New Contact</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 transition-colors hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              required
              value={form.fullName}
              onChange={(e) => set("fullName", e.target.value)}
              placeholder="Jane Smith"
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="jane@acme.com"
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Stage</label>
              <select
                value={form.stage}
                onChange={(e) => set("stage", e.target.value as ContactStageValue)}
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                {NEW_CONTACT_STAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Engineering Manager"
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Company</label>
              <input
                type="text"
                value={form.company}
                onChange={(e) => set("company", e.target.value)}
                placeholder="Acme Corp"
                className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">LinkedIn URL</label>
            <input
              type="url"
              value={form.linkedIn}
              onChange={(e) => set("linkedIn", e.target.value)}
              placeholder="https://linkedin.com/in/janesmith"
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Add any initial notes…"
              className="w-full resize-none rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium text-ink-3 transition-colors hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createContact.isPending || !form.fullName.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {createContact.isPending ? <Spinner /> : <Plus size={13} />}
              {createContact.isPending ? "Creating…" : "Create Contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Account row ────────────────────────────────────────────────────────────────

function AccountRow({
  group,
  expanded,
  onToggle,
}: {
  group: AccountGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const withEmail = group.contacts.filter((c) => !!c.email).length;

  return (
    <Fragment>
      <tr
        className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
        onClick={onToggle}
      >
        <td className="px-3 py-1.5 align-middle">
          {expanded ? (
            <ChevronDown size={12} className="text-ink-3" />
          ) : (
            <ChevronRight size={12} className="text-ink-3" />
          )}
        </td>
        <td className="px-3 py-1.5 align-middle">
          <div className="flex items-center gap-2.5">
            <Building2 size={14} className="flex-shrink-0 text-ink-4" />
            <span className="block min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {group.account || "—"}
            </span>
            <span className="flex-shrink-0 inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-ink">
              {group.contact_count}
            </span>
          </div>
        </td>
        <td className="px-3 py-1.5 text-right align-middle text-[12px] text-ink-2 tabular-nums">
          {group.contact_count}
        </td>
        <td className="px-3 py-1.5 text-right align-middle text-[12px] text-ink-2 tabular-nums">
          {withEmail}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={4} className="p-0">
            <ProspectAccountExpandPanel group={group} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type AccountSortKey = "account" | "count";

export function JobsContacts() {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [openAccount, setOpenAccount] = useState<string | null>(null);
  const [showNewContact, setShowNewContact] = useState(false);
  const { sort, toggle: toggleSort } = useSort<AccountSortKey>();

  // Global contact search state
  const [globalSearch, setGlobalSearch] = useState("");
  const [selectedContact, setSelectedContact] = useState<ContactSearchResult | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addedToJobsIds, setAddedToJobsIds] = useState<Set<number>>(new Set());
  const [bannerAddedToJobs, setBannerAddedToJobs] = useState(false);

  const { data: globalSearchResults } = useContactSearch(globalSearch);
  const searchResults = globalSearchResults ?? [];
  const { mutate: addContactToJobs } = useAddContactToJobs();

  const { data: accountGroups, isLoading } = useAccountsByAccount();

  // Filter + sort account groups client-side. A group survives the search
  // when its account name matches, OR any contact name/email within matches.
  // The stage filter keeps only groups that still have a matching contact and
  // narrows the visible nested contacts to those in that stage.
  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = accountGroups ?? [];

    const filtered: AccountGroup[] = [];
    for (const g of groups) {
      const accountMatch = (g.account ?? "").toLowerCase().includes(q);

      let contacts = g.contacts;
      if (stage) {
        contacts = contacts.filter((c) => c.contact_stage === stage);
      }
      if (q && !accountMatch) {
        contacts = contacts.filter((c) =>
          (c.full_name ?? "").toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q),
        );
      }

      if (stage && contacts.length === 0) continue;
      if (q && !accountMatch && contacts.length === 0) continue;

      filtered.push({ ...g, contacts, contact_count: contacts.length });
    }

    if (sort.key == null) return filtered; // already ordered by count desc
    return sortBy(filtered, sort, (g, key) =>
      key === "account" ? g.account : g.contact_count,
    );
  }, [accountGroups, search, stage, sort]);

  const total = visibleGroups.reduce((sum, g) => sum + g.contact_count, 0);

  return (
    <div className="flex flex-col gap-4">
      {showNewContact && <NewContactModal onClose={() => setShowNewContact(false)} />}

      {/* ── Global "Find any contact" search ─────────────────────────────── */}
      <div className="relative">
        <div className="relative">
          <UserSearch size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={globalSearch}
            onChange={(e) => {
              setGlobalSearch(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            onBlur={() => {
              blurTimerRef.current = setTimeout(() => setShowDropdown(false), 150);
            }}
            placeholder="Find any contact across SF, LinkedIn, or Jobs pipeline…"
            className="w-full rounded-xl border-2 border-border-strong bg-surface py-2.5 pl-10 pr-4 text-[14px] transition-colors placeholder:text-ink-4 focus:border-accent focus:outline-none"
          />
          {globalSearch && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setGlobalSearch(""); setShowDropdown(false); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-4 transition-colors hover:text-ink"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {showDropdown && globalSearch.trim().length >= 1 && searchResults.length > 0 && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-border-strong bg-surface shadow-lg">
            {searchResults.slice(0, 10).map((result) => {
              const isJobs = !!result.airtable_id;
              const isSF = result.in_sf;
              const isLinkedIn = result.source === "linkedin_import";
              return (
                <div
                  key={result.contact_id}
                  className="flex w-full items-center gap-3 border-b border-border-strong px-4 py-2.5 transition-colors last:border-0 hover:bg-surface-2"
                >
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSelectedContact(result);
                      setBannerAddedToJobs(false);
                      setGlobalSearch("");
                      setShowDropdown(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">
                      {initials(result.full_name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-ink">{result.full_name || "—"}</div>
                      {(result.current_title || result.current_company) && (
                        <div className="truncate text-[11px] text-ink-3">
                          {[result.current_title, result.current_company].filter(Boolean).join(" @ ")}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0">
                      {isJobs ? (
                        <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-0.5 font-medium leading-none text-accent-ink" style={{ fontSize: 10 }}>Jobs</span>
                      ) : isSF ? (
                        <span className="inline-flex items-center rounded-full bg-sky-50 px-1.5 py-0.5 font-medium leading-none text-sky-600" style={{ fontSize: 10 }}>SF</span>
                      ) : isLinkedIn ? (
                        <span className="inline-flex items-center rounded-full bg-indigo-50 px-1.5 py-0.5 font-medium leading-none text-indigo-600" style={{ fontSize: 10 }}>LinkedIn</span>
                      ) : null}
                    </div>
                  </button>
                  {!isJobs && (
                    <div className="ml-2 flex-shrink-0">
                      {addedToJobsIds.has(result.contact_id) ? (
                        <span className="text-[11px] font-medium text-accent">✓ Added</span>
                      ) : (
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => {
                            e.stopPropagation();
                            addContactToJobs(
                              { id: result.contact_id, add: true },
                              {
                                onSuccess: () =>
                                  setAddedToJobsIds((prev) => new Set(prev).add(result.contact_id)),
                              },
                            );
                          }}
                          className="rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:border-accent hover:text-accent"
                        >
                          + Add to Jobs
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Selected contact panel ──────────────────────────────────────── */}
      {selectedContact && (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-border-strong bg-surface-2 px-4 py-3">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">
              {initials(selectedContact.full_name)}
            </div>
            <div className="min-w-0 flex-1">
              <span className="mr-2 text-[14px] font-semibold text-ink">{selectedContact.full_name || "—"}</span>
              {(selectedContact.current_title || selectedContact.current_company) && (
                <span className="mr-2 text-[12px] text-ink-3">
                  {[selectedContact.current_title, selectedContact.current_company].filter(Boolean).join(" @ ")}
                </span>
              )}
              {selectedContact.airtable_id ? (
                <span className="inline-flex items-center rounded-full bg-accent-soft px-1.5 py-0.5 font-medium leading-none text-accent-ink" style={{ fontSize: 10 }}>Jobs</span>
              ) : selectedContact.in_sf ? (
                <span className="inline-flex items-center rounded-full bg-sky-50 px-1.5 py-0.5 font-medium leading-none text-sky-600" style={{ fontSize: 10 }}>SF</span>
              ) : selectedContact.source === "linkedin_import" ? (
                <span className="inline-flex items-center rounded-full bg-indigo-50 px-1.5 py-0.5 font-medium leading-none text-indigo-600" style={{ fontSize: 10 }}>LinkedIn</span>
              ) : null}
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              {!selectedContact.airtable_id && !selectedContact.in_sf && (
                bannerAddedToJobs ? (
                  <span className="text-[12px] font-medium text-accent">✓ In Jobs Pipeline</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      addContactToJobs(
                        { id: selectedContact.contact_id, add: true },
                        { onSuccess: () => setBannerAddedToJobs(true) },
                      );
                    }}
                    className="flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-[12px] font-medium text-ink-3 transition-colors hover:border-accent hover:text-accent"
                  >
                    + Add to Jobs Pipeline
                  </button>
                )
              )}
              <button
                type="button"
                onClick={() => setSelectedContact(null)}
                className="flex items-center gap-1 text-[12px] font-medium text-ink-3 transition-colors hover:text-ink"
              >
                <X size={13} />
                Deselect
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border-strong bg-surface">
            <ContactDetail contactId={selectedContact.contact_id} />
          </div>

          <hr className="my-0 border-border-strong" />
        </>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[200px] max-w-[360px] flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search account or contact name / email…"
            className="w-full rounded-lg border border-border-strong bg-surface py-2 pl-8 pr-3 text-[13px] focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowNewContact(true)}
          className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-2 text-[12px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
        >
          <Plus size={12} />
          New Contact
        </button>

        <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 p-1">
          {CONTACT_STAGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStage(opt.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors",
                stage === opt.value ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[12px] text-ink-3">
          {isLoading ? "Loading…" : `${visibleGroups.length} accounts · ${total} contacts`}
        </span>
      </div>

      {/* Results */}
      {isLoading ? (
        <div className="divide-y divide-border-strong rounded-lg border border-border-strong bg-surface">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex animate-pulse items-center gap-3 px-4 py-3">
              <div className="h-4 w-4 rounded bg-surface-2" />
              <div className="h-7 w-7 rounded-full bg-surface-2" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-40 rounded bg-surface-2" />
                <div className="h-2.5 w-64 rounded bg-surface-2" />
              </div>
            </div>
          ))}
        </div>
      ) : visibleGroups.length === 0 ? (
        <div className="rounded-lg border border-border-strong bg-surface px-6 py-12 text-center text-[13px] text-ink-3">
          No accounts match your filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-[28px] px-3 py-1.5"></th>
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Account" sortKey="account" sort={sort} onToggle={toggleSort} />
                </th>
                <th className="w-[110px] px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Contacts" sortKey="count" sort={sort} onToggle={toggleSort} align="right" />
                </th>
                <th className="w-[110px] px-3 py-1.5 text-right font-semibold">
                  With email
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleGroups.map((g) => (
                <AccountRow
                  key={g.account}
                  group={g}
                  expanded={openAccount === g.account}
                  onToggle={() =>
                    setOpenAccount((prev) => (prev === g.account ? null : g.account))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
