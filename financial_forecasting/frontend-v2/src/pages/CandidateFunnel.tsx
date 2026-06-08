/**
 * Candidate Funnel page — companies + people Pursuit has touched in
 * Gmail/Calendar but not yet tracked. RMs triage each row with 4
 * outcomes: track (in registry), promote to SF, tag to existing SF
 * record, or reject.
 *
 * Backend: routes/candidates.py.
 * Plan:    tasks/candidate-funnel-plan.md.
 *
 * Track-in-registry currently only flips status (public.companies /
 * public.contacts writeback is plan Step 4 — pending factory team
 * coordination on provenance + dedup contract).
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import {
  AccountCandidateDrawer,
  ContactCandidateDrawer,
} from "@/components/CandidateDetailDrawer";
import { PageHeader } from "@/components/PageHeader";
import { ButtonGroup, Toolbar } from "@/components/ui/Toolbar";
import {
  type AccountCandidate,
  type ContactCandidate,
  type CandidateStatus,
  useAccountCandidates,
  useContactCandidates,
} from "@/services/candidates";

type Tab = "accounts" | "contacts";

const STATUS_FILTERS: { value: CandidateStatus | "all" | "new+tracking"; label: string }[] = [
  { value: "new+tracking", label: "Open" },
  { value: "promoted",     label: "Promoted" },
  { value: "merged",       label: "Tagged" },
  { value: "rejected",     label: "Rejected" },
  { value: "all",          label: "All" },
];

const SF_BUCKET: { value: "all" | "yes" | "no"; label: string }[] = [
  { value: "yes", label: "At known SF Account" },
  { value: "no",  label: "Unknown firm" },
  { value: "all", label: "All" },
];

export function CandidateFunnelPage() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [statusFilter, setStatusFilter] = useState<string>("new+tracking");
  const [sfFilter, setSfFilter] = useState<"all" | "yes" | "no">("yes");
  const [search, setSearch] = useState("");
  const [minSignal, setMinSignal] = useState(3);
  const [activeAccount, setActiveAccount] = useState<AccountCandidate | null>(null);
  const [activeContact, setActiveContact] = useState<ContactCandidate | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title="Candidate Funnel"
        subtitle="Promote, tag, or reject companies and people we've corresponded with but aren't yet tracked. Click any row for smart suggestions."
      />

      <Toolbar>
        <ButtonGroup
          options={[
            { value: "accounts", label: "Companies" },
            { value: "contacts", label: "People" },
          ]}
          value={tab}
          onChange={(v) => setTab(v as Tab)}
        />
        <span className="mx-2 h-5 w-px bg-border-strong" />
        <ButtonGroup
          options={STATUS_FILTERS.map((s) => ({ value: s.value, label: s.label }))}
          value={statusFilter}
          onChange={setStatusFilter}
        />
        <span className="mx-2 h-5 w-px bg-border-strong" />
        <ButtonGroup
          options={SF_BUCKET}
          value={sfFilter}
          onChange={(v) => setSfFilter(v as "all" | "yes" | "no")}
        />
        <span className="mx-2 h-5 w-px bg-border-strong" />
        <label className="flex items-center gap-1.5 text-xs text-text-muted">
          Min signal
          <input
            type="number"
            min={0}
            value={minSignal}
            onChange={(e) => setMinSignal(Math.max(0, Number(e.target.value) || 0))}
            className="w-14 rounded border border-border-strong bg-surface px-1.5 py-0.5 text-sm"
          />
        </label>
        <div className="ml-auto flex items-center gap-1.5 rounded border border-border-strong bg-surface px-2 py-1">
          <Search className="h-3.5 w-3.5 text-text-muted" />
          <input
            placeholder={tab === "accounts" ? "Search domain or name" : "Search email or name"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent text-sm outline-none placeholder:text-text-muted w-56"
          />
        </div>
      </Toolbar>

      {tab === "accounts" ? (
        <AccountsTable
          statusFilter={statusFilter}
          sfFilter={sfFilter}
          search={search}
          minSignal={minSignal}
          onOpen={setActiveAccount}
        />
      ) : (
        <ContactsTable
          statusFilter={statusFilter}
          sfFilter={sfFilter}
          search={search}
          minSignal={minSignal}
          onOpen={setActiveContact}
        />
      )}

      <AccountCandidateDrawer
        candidate={activeAccount}
        onClose={() => setActiveAccount(null)}
      />
      <ContactCandidateDrawer
        candidate={activeContact}
        onClose={() => setActiveContact(null)}
      />
    </div>
  );
}

function resolveStatusFilter(v: string): CandidateStatus[] | undefined {
  if (v === "all") return undefined;
  if (v === "new+tracking") return ["new", "tracking"];
  return [v as CandidateStatus];
}

function resolveHasSf(v: "all" | "yes" | "no"): boolean | undefined {
  if (v === "yes") return true;
  if (v === "no") return false;
  return undefined;
}

// ── Accounts tab ─────────────────────────────────────────────────────

function AccountsTable({
  statusFilter, sfFilter, search, minSignal, onOpen,
}: {
  statusFilter: string;
  sfFilter: "all" | "yes" | "no";
  search: string;
  minSignal: number;
  onOpen: (row: AccountCandidate) => void;
}) {
  const filters = useMemo(() => ({
    status: resolveStatusFilter(statusFilter),
    hasSfAccount: resolveHasSf(sfFilter),
    search: search || undefined,
    minSignal,
    sort: "signal_count_desc" as const,
    limit: 100,
  }), [statusFilter, sfFilter, search, minSignal]);

  const q = useAccountCandidates(filters);
  const items = q.data?.items ?? [];

  if (q.isLoading) return <div className="px-3 py-6 text-text-muted">Loading…</div>;
  if (q.isError)   return <div className="px-3 py-6 text-error">Failed to load candidates.</div>;
  if (!items.length) return <div className="rounded-b-lg border border-t-0 border-border-strong bg-surface px-3 py-6 text-text-muted">No candidates match the filters.</div>;

  return (
    <div className="overflow-hidden rounded-b-lg border border-t-0 border-border-strong bg-surface">
      <div className="border-b border-border-subtle px-3 py-2 text-xs text-text-muted">
        Showing {items.length} of {q.data?.total ?? items.length} · click any row for smart suggestions
      </div>
      <ul className="divide-y divide-border-subtle">
        {items.map((row) => <AccountRow key={row.id} row={row} onOpen={onOpen} />)}
      </ul>
    </div>
  );
}

function AccountRow({ row, onOpen }: { row: AccountCandidate; onOpen: (r: AccountCandidate) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-surface-muted/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium">{row.display_name ?? row.primary_domain}</span>
            {row.display_name && (
              <span className="truncate text-text-muted text-xs">{row.primary_domain}</span>
            )}
            <StatusPill status={row.status} />
          </div>
          <div className="text-xs text-text-muted">
            {row.signal_count} signals · {row.unique_people} people · last {fmtDate(row.last_seen_at)}
            {row.sf_account_id && (
              <> · <span className="text-success">SF: {row.sf_account_id}</span></>
            )}
            {row.public_company_id != null && (
              <> · <span className="text-info">in registry</span></>
            )}
          </div>
        </div>
        <span className="shrink-0 text-text-muted text-xs">Review →</span>
      </button>
    </li>
  );
}

// ── Contacts tab ─────────────────────────────────────────────────────

function ContactsTable({
  statusFilter, sfFilter, search, minSignal, onOpen,
}: {
  statusFilter: string;
  sfFilter: "all" | "yes" | "no";
  search: string;
  minSignal: number;
  onOpen: (row: ContactCandidate) => void;
}) {
  const filters = useMemo(() => ({
    status: resolveStatusFilter(statusFilter),
    hasSfAccount: resolveHasSf(sfFilter),
    search: search || undefined,
    minSignal,
    sort: "signal_count_desc" as const,
    limit: 100,
  }), [statusFilter, sfFilter, search, minSignal]);

  const q = useContactCandidates(filters);
  const items = q.data?.items ?? [];

  if (q.isLoading) return <div className="px-3 py-6 text-text-muted">Loading…</div>;
  if (q.isError)   return <div className="px-3 py-6 text-error">Failed to load candidates.</div>;
  if (!items.length) return <div className="rounded-b-lg border border-t-0 border-border-strong bg-surface px-3 py-6 text-text-muted">No candidates match the filters.</div>;

  return (
    <div className="overflow-hidden rounded-b-lg border border-t-0 border-border-strong bg-surface">
      <div className="border-b border-border-subtle px-3 py-2 text-xs text-text-muted">
        Showing {items.length} of {q.data?.total ?? items.length} · click any row for smart suggestions
      </div>
      <ul className="divide-y divide-border-subtle">
        {items.map((row) => <ContactRow key={row.id} row={row} onOpen={onOpen} />)}
      </ul>
    </div>
  );
}

function ContactRow({ row, onOpen }: { row: ContactCandidate; onOpen: (r: ContactCandidate) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-surface-muted/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-medium">{row.display_name ?? row.email}</span>
            {row.display_name && (
              <span className="truncate text-text-muted text-xs">{row.email}</span>
            )}
            <StatusPill status={row.status} />
          </div>
          <div className="text-xs text-text-muted">
            {row.signal_count} signals · last {fmtDate(row.last_seen_at)}
            {row.sf_account_name ? (
              <> · <span className="text-success">at {row.sf_account_name}</span></>
            ) : row.account_candidate_domain ? (
              <> · firm candidate <span className="text-text-muted">{row.account_candidate_domain}</span></>
            ) : null}
            {row.sf_contact_id && <> · <span className="text-success">SF Contact: {row.sf_contact_id}</span></>}
          </div>
        </div>
        <span className="shrink-0 text-text-muted text-xs">Review →</span>
      </button>
    </li>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: CandidateStatus }) {
  const tone = {
    new:           "bg-surface-muted text-text-muted",
    tracking:      "bg-info/10 text-info",
    in_registry:   "bg-info/10 text-info",
    promoted:      "bg-success/10 text-success",
    merged:        "bg-success/10 text-success",
    rejected:      "bg-error/10 text-error",
  }[status] ?? "bg-surface-muted text-text-muted";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso.slice(0, 10);
  }
}
