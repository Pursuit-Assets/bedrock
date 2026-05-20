/**
 * Cleanup → Contacts tab.
 *
 * Bulk-edit support: change owner OR delete (irreversible). Uses the
 * same SELECTION_CAP / runBulk pattern as the accounts tab.
 *
 * Filters (chip-style, AND'ed):
 *   - text search across name/email/title/account/owner
 *   - owner picker (multi-select)
 *
 * Permission: `edit_contacts` gates the bulk action bar. Per-row
 * ownership enforcement is server-side.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { ExportCsvButton } from "@/components/ui/ExportCsvButton";
import { Toolbar } from "@/components/ui/Toolbar";
import type { CsvColumn } from "@/lib/csv";
import { fmtDate, initials } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { cn } from "@/lib/utils";
import {
  useContacts,
  useDeleteContact,
  useUpdateContact,
} from "@/services/contacts";
import { usePerm } from "@/services/permissions";
import { useActiveUsers, useUsers } from "@/services/users";
import type { SfContact } from "@/types/salesforce";

import {
  BulkDialog,
  type BulkMode,
  type BulkProgress,
  SELECTION_CAP,
  runBulk,
} from "./CleanupShared";
import {
  AddFilterButton,
  FilterChip,
  type FieldMeta,
  type FilterRule,
  describeRule,
  ruleApplies,
} from "./Filters";

// ── Filter model ─────────────────────────────────────────────────────────

const CONTACT_FILTERABLE = {
  name: { label: "Name", type: "text", getValue: (c: SfContact) => contactName(c) },
  account: { label: "Account", type: "text", getValue: (c: SfContact) => c.Account?.Name ?? "" },
  title: { label: "Title", type: "text", getValue: (c: SfContact) => c.Title ?? "" },
  department: { label: "Department", type: "select", getValue: (c: SfContact) => c.Department ?? "" },
  email: { label: "Email", type: "text", getValue: (c: SfContact) => c.Email ?? "" },
  owner: { label: "Owner", type: "select", getValue: (c: SfContact) => c.OwnerId ?? "" },
  recordType: { label: "Record Type", type: "select", getValue: (c: SfContact) => c.RecordType?.Name ?? "" },
  leadSource: { label: "Lead source", type: "select", getValue: (c: SfContact) => c.LeadSource ?? "" },
  philanthropic: { label: "Philanthropic", type: "select", getValue: (c: SfContact) => (c.Philanthropic_Contact__c ? "Yes" : "No") },
  boardStatus: { label: "Board status", type: "select", getValue: (c: SfContact) => c.Board_Status__c ?? "" },
  daysSinceActivity: { label: "Days since activity", type: "number", getValue: (c: SfContact) => c.Days_Since_Last_Activity__c ?? null },
  lastActivity: { label: "Last activity", type: "date", getValue: (c: SfContact) => c.Last_Activity_Date__c ?? c.LastActivityDate ?? null },
  createdDate: { label: "Created", type: "date", getValue: (c: SfContact) => c.CreatedDate ?? null },
} satisfies Record<string, FieldMeta<SfContact>>;

type ContactField = keyof typeof CONTACT_FILTERABLE;

const ROW_HEIGHT = 44;
const CHECKBOX_W = 36;

/** Stable referrer state — see CleanupPage for rationale. */
const CLEANUP_REFERRER = {
  from: { pathname: "/cleanup", label: "Cleanup" },
} as const;

type ColKey = "name" | "account" | "title" | "email" | "owner" | "lastActivity";

const COL_LABELS: Record<ColKey, string> = {
  name: "Contact",
  account: "Account",
  title: "Title",
  email: "Email",
  owner: "Owner",
  lastActivity: "Last activity",
};

const COL_WIDTHS: Record<ColKey, number> = {
  name: 240,
  account: 220,
  title: 180,
  email: 240,
  owner: 160,
  lastActivity: 130,
};

const COLUMN_ORDER: ColKey[] = ["name", "account", "title", "email", "owner", "lastActivity"];

/** CSV columns — wider than the visible table so the export is
 *  self-sufficient for downstream analysis. ISO dates, raw values
 *  (no display formatting). */
const CONTACT_CSV_COLUMNS: CsvColumn<SfContact>[] = [
  { label: "SF Id", getValue: (c) => c.Id },
  { label: "Name", getValue: (c) => contactName(c) },
  { label: "First Name", getValue: (c) => c.FirstName },
  { label: "Last Name", getValue: (c) => c.LastName },
  { label: "Title", getValue: (c) => c.Title },
  { label: "Department", getValue: (c) => c.Department },
  { label: "Email", getValue: (c) => c.Email },
  { label: "Phone", getValue: (c) => c.Phone },
  { label: "Mobile", getValue: (c) => c.MobilePhone },
  { label: "Account", getValue: (c) => c.Account?.Name },
  { label: "Account Id", getValue: (c) => c.AccountId },
  { label: "Owner", getValue: (c) => c.Owner?.Name },
  { label: "Owner Id", getValue: (c) => c.OwnerId },
  { label: "Lead Source", getValue: (c) => c.LeadSource },
  { label: "Record Type", getValue: (c) => c.RecordType?.Name },
  { label: "Philanthropic", getValue: (c) => (c.Philanthropic_Contact__c ? "Yes" : "") },
  { label: "Board Status", getValue: (c) => c.Board_Status__c },
  { label: "LinkedIn", getValue: (c) => c.LinkedIn_URL__c },
  { label: "Mailing City", getValue: (c) => c.MailingCity },
  { label: "Mailing State", getValue: (c) => c.MailingState },
  { label: "Last Activity", getValue: (c) => isoDate(c.Last_Activity_Date__c ?? c.LastActivityDate) },
  { label: "Days Since Activity", getValue: (c) => c.Days_Since_Last_Activity__c ?? "" },
  { label: "Created", getValue: (c) => isoDate(c.CreatedDate) },
];

function isoDate(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function contactName(c: SfContact): string {
  if (c.Name) return c.Name;
  const composed = [c.FirstName, c.LastName].filter(Boolean).join(" ").trim();
  return composed || "(no name)";
}

function extract(c: SfContact, key: ColKey): unknown {
  switch (key) {
    case "name": return contactName(c);
    case "account": return c.Account?.Name ?? "";
    case "title": return c.Title ?? "";
    case "email": return c.Email ?? "";
    case "owner": return c.Owner?.Name ?? "";
    case "lastActivity":
      return c.Last_Activity_Date__c ?? c.LastActivityDate ?? "";
  }
}

export function CleanupContactsTab() {
  const canEdit = usePerm("edit_contacts");
  const { data: contactsData, isLoading } = useContacts();
  const usersQ = useActiveUsers();
  const allUsersQ = useUsers();
  const updateContact = useUpdateContact();
  const deleteContact = useDeleteContact();

  const contacts = useMemo(() => contactsData ?? [], [contactsData]);

  // Local toolbar state — declared early so `facets` can constrain the
  // owner picker to rows visible in the table.
  const [q, setQ] = useState("");
  const [rules, setRules] = useState<FilterRule<ContactField>[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Contacts that pass the toolbar-level search (chip `rules` excluded
  // so the picker stays usable when an owner rule is active).
  const contactsInView = useMemo(() => {
    if (!q) return contacts;
    const needle = q.toLowerCase();
    return contacts.filter((c) => {
      const hay = [
        contactName(c), c.Email, c.Phone, c.MobilePhone, c.Title,
        c.Department, c.Owner?.Name,
      ].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(needle);
    });
  }, [contacts, q]);

  // Owner picker = every active SF user + inactive users with rows in
  // the current view.
  const facets = useMemo(() => {
    const all = allUsersQ.data ?? [];
    const activeById = new Map(
      all.filter((u) => u.IsActive).map((u) => [u.Id, u]),
    );
    const inactiveById = new Map(
      all.filter((u) => !u.IsActive).map((u) => [u.Id, u]),
    );

    const ownersInView = new Set<string>();
    const ownerNameFromData = new Map<string, string>();
    const departments = new Set<string>();
    const recordTypes = new Set<string>();
    const leadSources = new Set<string>();
    const boardStatuses = new Set<string>();
    for (const c of contactsInView) {
      if (c.OwnerId) {
        ownersInView.add(c.OwnerId);
        if (c.Owner?.Name && !ownerNameFromData.has(c.OwnerId)) {
          ownerNameFromData.set(c.OwnerId, c.Owner.Name);
        }
      }
      if (c.Department) departments.add(c.Department);
      if (c.RecordType?.Name) recordTypes.add(c.RecordType.Name);
      if (c.LeadSource) leadSources.add(c.LeadSource);
      if (c.Board_Status__c) boardStatuses.add(c.Board_Status__c);
    }

    type OwnerOption = { value: string; label: string };
    const owners: OwnerOption[] = [];
    for (const u of activeById.values()) {
      owners.push({ value: u.Id, label: u.Name });
    }
    for (const id of ownersInView) {
      if (activeById.has(id)) continue;
      const inactive = inactiveById.get(id);
      const name = inactive?.Name ?? ownerNameFromData.get(id) ?? id;
      owners.push({ value: id, label: `${name} (inactive)` });
    }
    owners.sort((a, b) => a.label.localeCompare(b.label));

    const sortedOpts = (s: Set<string>) =>
      Array.from(s).sort().map((v) => ({ value: v, label: v }));
    return {
      owner: owners,
      department: sortedOpts(departments),
      recordType: sortedOpts(recordTypes),
      leadSource: sortedOpts(leadSources),
      boardStatus: sortedOpts(boardStatuses),
      philanthropic: [
        { value: "Yes", label: "Yes" },
        { value: "No", label: "No" },
      ],
    };
  }, [contactsInView, allUsersQ.data]);

  const ownerBulkOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const ownerLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of usersQ.data ?? []) m.set(u.Id, u.Name);
    for (const c of contacts) {
      if (c.OwnerId && !m.has(c.OwnerId) && c.Owner?.Name) {
        m.set(c.OwnerId, c.Owner.Name);
      }
    }
    return (id: string) => m.get(id) ?? id;
  }, [usersQ.data, contacts]);

  const filtered = useMemo(() => {
    return contacts.filter((c) => {
      if (q) {
        const needle = q.toLowerCase();
        const hay = [
          contactName(c),
          c.Email,
          c.Title,
          c.Account?.Name,
          c.Owner?.Name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      for (const r of rules) {
        if (!ruleApplies(c, r, CONTACT_FILTERABLE)) return false;
      }
      return true;
    });
  }, [contacts, q, rules]);

  const { sort, toggle: toggleSort } = useSort<ColKey>({ key: "name", direction: "asc" });
  const sorted = useMemo(() => sortBy(filtered, sort, extract), [filtered, sort]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const visible = new Set(filtered.map((c) => c.Id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  const allVisibleSelected =
    sorted.length > 0 && sorted.every((c) => selectedIds.has(c.Id));
  const someVisibleSelected =
    sorted.some((c) => selectedIds.has(c.Id)) && !allVisibleSelected;

  const toggleAll = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const c of sorted) next.delete(c.Id);
        return next;
      }
      const next = new Set(prev);
      for (const c of sorted) {
        if (next.size >= SELECTION_CAP) break;
        next.add(c.Id);
      }
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < SELECTION_CAP) next.add(id);
      return next;
    });
  };

  // ── Bulk apply ─────────────────────────────────────────────────────────

  const [bulkMode, setBulkMode] = useState<BulkMode | null>(null);
  const [bulkValue, setBulkValue] = useState<string>("");
  const [progress, setProgress] = useState<BulkProgress | null>(null);

  const selectedContacts = useMemo(
    () => sorted.filter((c) => selectedIds.has(c.Id)),
    [sorted, selectedIds],
  );

  const startBulk = (mode: BulkMode) => {
    setBulkMode(mode);
    setBulkValue("");
    setProgress(null);
  };

  /** Single-item mutation shared by initial run + retry-failed. */
  const applyOne = async (it: { id: string; name: string }) => {
    if (bulkMode === "owner") {
      const ownerName =
        ownerBulkOptions.find((o) => o.value === bulkValue)?.label ?? "";
      await updateContact.mutateAsync({
        id: it.id,
        patch: { OwnerId: bulkValue },
        displayPatch: { Owner: { Name: ownerName } } as Record<string, unknown>,
      });
    } else {
      await deleteContact.mutateAsync(it.id);
    }
  };

  const runApply = async () => {
    if (!bulkMode) return;
    if (bulkMode === "owner" && !bulkValue) return;
    const items = selectedContacts.map((c) => ({
      id: c.Id,
      name: contactName(c),
    }));
    await runBulk(items, applyOne, setProgress);
  };

  const retryFailed = async () => {
    if (!progress || progress.failures.length === 0) return;
    const items = progress.failures.map((f) => ({ id: f.id, name: f.name }));
    await runBulk(items, applyOne, setProgress);
  };

  const closeBulk = () => {
    setBulkMode(null);
    setBulkValue("");
    setProgress(null);
    if (progress && progress.failures.length === 0 && progress.done === progress.total) {
      setSelectedIds(new Set());
    }
  };

  const tableMinWidth =
    COLUMN_ORDER.reduce((sum, k) => sum + COL_WIDTHS[k], 0) + CHECKBOX_W;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom = totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-7 pt-3 pb-6">
      <div className="mb-3 text-[12px] text-ink-3">
        {isLoading
          ? "Loading…"
          : `${sorted.length.toLocaleString()} of ${contacts.length.toLocaleString()} contacts${selectedIds.size > 0 ? ` · ${selectedIds.size.toLocaleString()} selected` : ""}`}
      </div>

      <Toolbar>
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            placeholder="Search name, email, title, account"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-80 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>
        <AddFilterButton<ContactField>
          filterable={CONTACT_FILTERABLE as Record<ContactField, FieldMeta<unknown>>}
          selectOptions={{
            owner: facets.owner,
            department: facets.department,
            recordType: facets.recordType,
            leadSource: facets.leadSource,
            boardStatus: facets.boardStatus,
            philanthropic: facets.philanthropic,
          }}
          onAdd={(r) => setRules((prev) => [...prev, r])}
        />
        <div className="ml-auto">
          <ExportCsvButton
            baseFilename="cleanup-contacts"
            rows={sorted}
            columns={CONTACT_CSV_COLUMNS}
          />
        </div>
      </Toolbar>

      {rules.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {rules.map((r) => (
            <FilterChip
              key={r.id}
              label={describeRule(r, CONTACT_FILTERABLE, (field, v) =>
                field === "owner" ? ownerLabel(v) : v,
              )}
              onRemove={() => setRules((prev) => prev.filter((x) => x.id !== r.id))}
            />
          ))}
          <button
            type="button"
            onClick={() => setRules([])}
            className="text-[11.5px] text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {selectedIds.size > 0 && canEdit ? (
        <div className="mt-3 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-[12.5px]">
          <span className="font-medium text-ink">
            {selectedIds.size.toLocaleString()} selected
            {selectedIds.size >= SELECTION_CAP ? ` (cap: ${SELECTION_CAP})` : ""}
          </span>
          <span className="text-ink-3">·</span>
          <button
            type="button"
            onClick={() => startBulk("owner")}
            className="rounded bg-ink px-2.5 py-1 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Change owner…
          </button>
          <button
            type="button"
            onClick={() => startBulk("delete")}
            className="rounded bg-red px-2.5 py-1 text-[12px] font-medium text-surface hover:opacity-90"
          >
            Delete…
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-[12px] text-ink-3 hover:text-ink-2"
          >
            Clear selection
          </button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        className="mt-3 flex-1 overflow-x-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{ tableLayout: "fixed", width: "100%", minWidth: tableMinWidth }}
        >
          <colgroup>
            <col style={{ width: CHECKBOX_W }} />
            {COLUMN_ORDER.map((k) => (
              <col key={k} style={{ width: COL_WIDTHS[k] }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="border-b border-border-strong bg-surface px-3 py-2 text-left">
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  className="h-3.5 w-3.5 cursor-pointer accent-accent"
                  aria-label="Select all visible"
                />
              </th>
              {COLUMN_ORDER.map((k) => (
                <th
                  key={k}
                  className="border-b border-border-strong bg-surface px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(k)}
                    className="hover:text-ink"
                  >
                    {COL_LABELS[k]}
                    {sort.key === k ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 ? (
              <tr aria-hidden style={{ height: paddingTop }}>
                <td colSpan={COLUMN_ORDER.length + 1} />
              </tr>
            ) : null}
            {virtualItems.map((vi) => {
              const c = sorted[vi.index];
              if (!c) return null;
              return (
                <ContactRow
                  key={c.Id}
                  c={c}
                  checked={selectedIds.has(c.Id)}
                  onToggle={() => toggleOne(c.Id)}
                />
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden style={{ height: paddingBottom }}>
                <td colSpan={COLUMN_ORDER.length + 1} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {bulkMode ? (
        <BulkDialog
          entity="contact"
          mode={bulkMode}
          ownerValue={bulkValue}
          onOwnerValueChange={setBulkValue}
          ownerOptions={ownerBulkOptions}
          selected={selectedContacts.map((c) => ({ id: c.Id, name: contactName(c) }))}
          progress={progress}
          onRun={runApply}
          onRetryFailed={retryFailed}
          onClose={closeBulk}
        />
      ) : null}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────

const ContactRow = memo(function ContactRow({
  c,
  checked,
  onToggle,
}: {
  c: SfContact;
  checked: boolean;
  onToggle: () => void;
}) {
  const name = contactName(c);
  const lastActivity = c.Last_Activity_Date__c ?? c.LastActivityDate ?? null;
  return (
    <tr
      className={cn(
        "group/row border-b border-border-strong hover:bg-surface-2",
        checked && "bg-accent/5",
      )}
      style={{ height: ROW_HEIGHT }}
      onClick={onToggle}
    >
      <td className="px-3 py-1" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-3.5 w-3.5 cursor-pointer accent-accent"
        />
      </td>
      <td className="px-3 py-1 text-[13px]">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid h-[18px] w-[18px] flex-shrink-0 place-items-center rounded bg-surface-2 text-[9px] font-semibold text-ink-2">
            {initials(name)}
          </div>
          <Link
            to={`/contacts/${c.Id}`}
            state={CLEANUP_REFERRER}
            className="min-w-0 flex-1 truncate font-medium hover:underline"
            title={name}
            onClick={(e) => e.stopPropagation()}
          >
            {name}
          </Link>
        </div>
      </td>
      <td className="px-3 py-1">
        {c.AccountId && c.Account?.Name ? (
          <Link
            to={`/accounts/${c.AccountId}`}
            state={CLEANUP_REFERRER}
            className="truncate text-[12.5px] text-ink-2 hover:underline"
            onClick={(e) => e.stopPropagation()}
            title={c.Account.Name}
          >
            {c.Account.Name}
          </Link>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </td>
      <td className="px-3 py-1">
        <span className="truncate text-[12.5px] text-ink-2">{c.Title ?? "—"}</span>
      </td>
      <td className="px-3 py-1">
        {c.Email ? (
          <a
            href={`mailto:${c.Email}`}
            className="truncate text-[12px] text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {c.Email}
          </a>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </td>
      <td className="px-3 py-1">
        <span className="truncate text-[12.5px] text-ink-2">{c.Owner?.Name ?? "—"}</span>
      </td>
      <td className="px-3 py-1 text-[13px] tabular-nums text-ink-2">{fmtDate(lastActivity)}</td>
    </tr>
  );
});

