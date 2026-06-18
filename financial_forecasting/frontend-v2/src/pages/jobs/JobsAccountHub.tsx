/**
 * Jobs · Accounts — the account-level hub.
 *
 * The account (company) is the organizing unit. Full configurable table like the
 * rest of the app: search, per-column filters, group-by, sortable headers,
 * column chooser, and saved views (personal + global). Fluid layout — columns
 * share 100% width and truncate, so there is NO horizontal scroll. Expanding a
 * row reveals everything at that account via tabs.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Briefcase, ChevronDown, ChevronRight, ExternalLink, Users } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { withReferrer } from "@/components/detail";
import { AccountExpandTabs } from "@/components/jobs/accountTabs";
import { DEAL_TYPE_LABELS, OwnerSelect, jobsAccountPath } from "@/components/jobs/jobsEntity";
import { ColumnChooser } from "@/components/ui/ColumnChooser";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { accountStatusVariant } from "@/lib/accountStatus";
import { cn } from "@/lib/utils";
import { useColumnVisibility } from "@/lib/columnVisibility";
import { useSessionState } from "@/lib/useSessionState";
import { useSort, sortBy, type SortState } from "@/lib/sort";
import {
  AddFilterButton, FilterChip, describeRule, ruleApplies,
  type FieldMeta, type FilterRule,
} from "@/pages/cleanup/Filters";
import {
  useJobsAccounts, useJobsStaff, useUpdateJobsAccount,
  type JobsAccount, type JobsAccountStatus, type JobsStaff,
} from "@/services/jobs";

// ── helpers ──────────────────────────────────────────────────────────────────
function relativeDays(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
const dealTypesOf = (a: JobsAccount) =>
  [...new Set(a.opportunities.map((o) => o.deal_type).filter(Boolean))] as string[];

// ── columns ──────────────────────────────────────────────────────────────────
type ColKey = "account" | "status" | "owner" | "opps" | "contacts" | "deal_types" | "last_activity";
const COLUMN_ORDER: ColKey[] = ["account", "status", "owner", "opps", "contacts", "deal_types", "last_activity"];
const DEFAULT_VISIBLE: ColKey[] = ["account", "status", "owner", "opps", "contacts", "last_activity"];
const COL_LABELS: Record<ColKey, string> = {
  account: "Account", status: "Status", owner: "Owner", opps: "Opps",
  contacts: "Contacts", deal_types: "Deal types", last_activity: "Last activity",
};
// Relative weights → percentage widths (table-fixed, fluid, never overflows).
const COL_WEIGHT: Record<ColKey, number> = {
  account: 34, status: 14, owner: 16, opps: 8, contacts: 9, deal_types: 14, last_activity: 12,
};
const SORTABLE = new Set<ColKey>(["account", "status", "owner", "opps", "contacts", "last_activity"]);

function extract(a: JobsAccount, key: ColKey): string | number {
  switch (key) {
    case "account":       return a.account.toLowerCase();
    case "status":        return a.account_status;
    case "owner":         return a.owner_email ?? "";
    case "opps":          return a.opp_count;
    case "contacts":      return a.prospect_count;
    case "deal_types":    return dealTypesOf(a).join(",");
    case "last_activity": return a.last_activity ?? "";
  }
}

// ── filters + grouping ───────────────────────────────────────────────────────
type Field = "account" | "status" | "owner" | "has_opps" | "has_contacts";
const FILTERABLE: Record<Field, FieldMeta<JobsAccount>> = {
  account:      { label: "Account",  type: "text",   getValue: (a) => a.account },
  status:       { label: "Status",   type: "select", getValue: (a) => a.account_status },
  owner:        { label: "Owner",    type: "select", getValue: (a) => a.owner_email ?? "" },
  has_opps:     { label: "Has opportunities", type: "select", getValue: (a) => (a.opp_count > 0 ? "yes" : "no") },
  has_contacts: { label: "Has contacts",      type: "select", getValue: (a) => (a.prospect_count > 0 ? "yes" : "no") },
};
const GROUP_OPTIONS = [
  { value: "", label: "No grouping" },
  { value: "status", label: "Group by Status" },
  { value: "owner", label: "Group by Owner" },
  { value: "has_opps", label: "Group by Has opportunities" },
];
const STATUSES: JobsAccountStatus[] = ["Pursuing", "Stewarding", "Re-activating", "Prospect", "Dormant"];
const YESNO = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

const DEAL_TYPE_FILTER: { value: string; label: string }[] = [
  { value: "all", label: "All deal types" },
  ...(["ft", "pt_contract", "capstone", "volunteer", "workshop", "pilot"] as const).map((v) => ({ value: v, label: DEAL_TYPE_LABELS[v] })),
];

interface JobsAccountsView {
  query?: string; rules?: FilterRule<Field>[]; visibleCols?: ColKey[];
  groupBy?: string; sort?: SortState<ColKey>; dealType?: string;
}

const EMPTY: string[] = [];

// ── row ──────────────────────────────────────────────────────────────────────
function AccountRow({
  account, expanded, onToggle, visibleCols, staff, onSaveOwner,
}: {
  account: JobsAccount; expanded: boolean; onToggle: () => void; visibleCols: ColKey[];
  staff: JobsStaff[]; onSaveOwner: (account: string, email: string) => Promise<void>;
}) {
  const cells: Record<ColKey, React.ReactNode> = {
    account: (
      <span className="flex min-w-0 items-center gap-2">
        {expanded ? <ChevronDown size={13} className="shrink-0 text-ink-3" /> : <ChevronRight size={13} className="shrink-0 text-ink-3" />}
        <AccountAvatar name={account.account} logoUrl={null} size={20} />
        <span className="truncate text-[13px] font-semibold text-ink">{account.account}</span>
        <Link to={jobsAccountPath(account.account_key)} state={withReferrer({ pathname: "/jobs", label: "Jobs" })} onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-4 hover:text-accent" title="Open account detail"><ExternalLink size={12} /></Link>
      </span>
    ),
    status: <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag>,
    owner: <OwnerSelect owner={account.owner_email} staff={staff} onSave={(email) => onSaveOwner(account.account, email)} />,
    opps: account.opp_count > 0 ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><Briefcase size={11} className="text-ink-4" />{account.opp_count}</span> : <span className="text-ink-4">—</span>,
    contacts: account.prospect_count > 0 ? <span className="inline-flex items-center gap-1 text-[12px] text-ink-2"><Users size={11} className="text-ink-4" />{account.prospect_count}</span> : <span className="text-ink-4">—</span>,
    deal_types: (() => { const d = dealTypesOf(account); return d.length ? <span className="truncate text-[11.5px] text-ink-3">{d.map((t) => DEAL_TYPE_LABELS[t as keyof typeof DEAL_TYPE_LABELS] ?? t).join(", ")}</span> : <span className="text-ink-4">—</span>; })(),
    last_activity: <span className="whitespace-nowrap text-[11.5px] text-ink-4">{relativeDays(account.last_activity)}</span>,
  };
  return (
    <Fragment>
      <tr className="cursor-pointer border-t border-border-strong bg-surface hover:bg-surface-2/50" onClick={onToggle}>
        {visibleCols.map((key) => (
          <td key={key} className="overflow-hidden px-3 py-2 align-middle" onClick={key === "owner" ? (e) => e.stopPropagation() : undefined}>
            {cells[key]}
          </td>
        ))}
      </tr>
      {expanded && (
        <tr className="bg-surface-2/30"><td colSpan={visibleCols.length} className="p-0"><AccountExpandTabs account={account} /></td></tr>
      )}
    </Fragment>
  );
}

export function JobsAccountHub({ initialQuery }: { initialQuery?: string } = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [rules, setRules] = useState<FilterRule<Field>[]>([]);
  const [dealType, setDealType] = useState("all");
  const [groupBy, setGroupBy] = useSessionState<string>("jobs-accounts:groupBy", "");
  const [collapsedGroups, setCollapsedGroups] = useSessionState<string[]>("jobs-accounts:groupCollapsed", EMPTY);
  // Persisted so returning from a contact/opportunity detail page restores the
  // same account rows expanded.
  const [expandedList, setExpandedList] = useSessionState<string[]>("jobs-accounts:expanded", EMPTY);
  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  const setExpanded = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => setExpandedList((prev) => [...updater(new Set(prev))]),
    [setExpandedList],
  );

  const { sort, toggle, setSort } = useSort<ColKey>({ key: "status", direction: "asc" });
  const { visible: visibleCols, toggle: toggleCol, replaceAll: replaceVisibleCols } =
    useColumnVisibility<ColKey>("bedrock-v2:vis:jobs-accounts", COLUMN_ORDER, DEFAULT_VISIBLE);

  const { data: accounts = [], isLoading } = useJobsAccounts(dealType);
  const { data: staff = [] } = useJobsStaff();
  const updateAccount = useUpdateJobsAccount();
  const saveOwner = useCallback(
    (account: string, email: string) => updateAccount.mutateAsync({ account, owner_email: email }).then(() => undefined),
    [updateAccount],
  );

  const ownerOptions = useMemo(() => {
    const emails = [...new Set(accounts.map((a) => a.owner_email).filter(Boolean) as string[])];
    return emails.map((e) => ({ value: e, label: staff.find((s) => s.email === e)?.name ?? e.split("@")[0] }));
  }, [accounts, staff]);
  const selectOptions: Partial<Record<Field, { value: string; label: string }[]>> = useMemo(() => ({
    status: STATUSES.map((s) => ({ value: s, label: s })),
    owner: ownerOptions,
    has_opps: YESNO, has_contacts: YESNO,
  }), [ownerOptions]);

  const collapsedSet = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);
  const toggleGroup = useCallback((k: string) => setCollapsedGroups((p) => p.includes(k) ? p.filter((x) => x !== k) : [...p, k]), [setCollapsedGroups]);
  const toggleRow = useCallback((acct: string) => setExpanded((p) => { const n = new Set(p); n.has(acct) ? n.delete(acct) : n.add(acct); return n; }), [setExpanded]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const f = accounts.filter((a) => {
      for (const r of rules) if (!ruleApplies(a, r, FILTERABLE)) return false;
      if (!q) return true;
      return a.account.toLowerCase().includes(q)
        || a.prospects.some((p) => (p.full_name ?? "").toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q))
        || a.opportunities.some((o) => (o.title ?? "").toLowerCase().includes(q));
    });
    return sort.key == null ? f : sortBy(f, sort, (a, k) => extract(a, k));
  }, [accounts, q, rules, sort]);

  const groupLabel = useCallback((k: string) => {
    if (k === "") return "—";
    if (groupBy === "owner") return staff.find((s) => s.email === k)?.name ?? k;
    if (groupBy === "has_opps") return k === "yes" ? "Has opportunities" : "No opportunities";
    return k;
  }, [groupBy, staff]);

  type DisplayRow = { kind: "row"; a: JobsAccount } | { kind: "header"; key: string; label: string; count: number; collapsed: boolean };
  const grouped: DisplayRow[] | null = useMemo(() => {
    if (!groupBy) return null;
    const field = FILTERABLE[groupBy as Field]; if (!field) return null;
    const buckets = new Map<string, JobsAccount[]>();
    for (const a of filtered) { const k = String(field.getValue(a) ?? ""); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(a); }
    const out: DisplayRow[] = [];
    for (const k of [...buckets.keys()].sort((x, y) => groupLabel(x).localeCompare(groupLabel(y)))) {
      const list = buckets.get(k)!; const collapsed = collapsedSet.has(k);
      out.push({ kind: "header", key: k, label: groupLabel(k), count: list.length, collapsed });
      if (!collapsed) for (const a of list) out.push({ kind: "row", a });
    }
    return out;
  }, [filtered, groupBy, collapsedSet, groupLabel]);

  const totals = useMemo(() => filtered.reduce((acc, a) => ({ opps: acc.opps + a.opp_count, contacts: acc.contacts + a.prospect_count }), { opps: 0, contacts: 0 }), [filtered]);
  const visibleWeight = visibleCols.reduce((s, k) => s + COL_WEIGHT[k], 0);
  // Status distribution (across the deal-type-filtered set) for the quick-filter chips.
  const statusCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of accounts) m[a.account_status] = (m[a.account_status] ?? 0) + 1;
    return m;
  }, [accounts]);

  const renderRow = (a: JobsAccount) => (
    <AccountRow key={a.account} account={a} expanded={expanded.has(a.account)} onToggle={() => toggleRow(a.account)} visibleCols={visibleCols} staff={staff} onSaveOwner={saveOwner} />
  );

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <Toolbar>
        <input placeholder="Search accounts, contacts, opportunities…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 w-64 rounded border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink" />
        <AddFilterButton<Field> filterable={FILTERABLE as Record<Field, FieldMeta<unknown>>} selectOptions={selectOptions} onAdd={(r) => setRules((p) => [...p, r])} buttonLabel="Filter" />
        <select value={dealType} onChange={(e) => setDealType(e.target.value)} title="Filter to accounts with a deal of this type" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {DEAL_TYPE_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={groupBy} onChange={(e) => { setGroupBy(e.target.value); setCollapsedGroups([]); }} title="Group rows by a field" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">{isLoading ? "…" : `${filtered.length} acct · ${totals.opps} opp · ${totals.contacts} contact`}</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setExpandedList(filtered.map((a) => a.account))} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Expand all</button>
          <button type="button" onClick={() => setExpandedList([])} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Collapse</button>
          <ColumnChooser allColumns={COLUMN_ORDER} labels={COL_LABELS} visible={visibleCols} required={["account"]} onToggle={toggleCol} />
          <SavedViewsPicker<JobsAccountsView>
            scopeKey="jobs-accounts"
            currentFilters={{ query, rules, visibleCols, groupBy, sort, dealType }}
            onLoad={(v) => {
              setQuery(v.query ?? ""); setRules(v.rules ?? []); setGroupBy(v.groupBy ?? ""); setCollapsedGroups([]);
              setDealType(v.dealType ?? "all");
              if (v.visibleCols?.length) replaceVisibleCols(v.visibleCols);
              if (v.sort) setSort(v.sort);
            }}
          />
        </div>
      </Toolbar>

      {/* Status distribution — click to filter (drives a status rule), click active to clear */}
      {!isLoading && accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {STATUSES.map((st) => {
            const n = statusCounts[st] ?? 0;
            const active = rules.some((r) => r.field === "status" && r.op === "equals" && r.values.includes(st));
            const setStatusOnly = () =>
              setRules((prev) => {
                const others = prev.filter((r) => r.field !== "status");
                return active ? others : [...others, { id: `status-${st}`, field: "status" as Field, op: "equals" as const, values: [st] }];
              });
            return (
              <button
                key={st}
                type="button"
                onClick={setStatusOnly}
                className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium transition-colors",
                  active ? "border-accent ring-1 ring-accent/40" : "border-border-strong hover:border-accent/50")}
                title={`${n} ${st} account${n === 1 ? "" : "s"}`}
              >
                <Tag variant={accountStatusVariant(st)}>{st}</Tag>
                <span className="font-mono text-ink-4">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {rules.map((r) => (
            <FilterChip key={r.id} label={describeRule(r, FILTERABLE, (f, v) => f === "owner" ? (staff.find((s) => s.email === v)?.name ?? v) : v)} onRemove={() => setRules((p) => p.filter((x) => x.id !== r.id))} />
          ))}
          <button type="button" onClick={() => setRules([])} className="ml-1 text-[11.5px] font-medium text-ink-3 underline-offset-4 hover:text-ink-2 hover:underline">Clear all</button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
        <table className="w-full table-fixed border-collapse">
          <colgroup>{visibleCols.map((k) => <col key={k} style={{ width: `${(COL_WEIGHT[k] / visibleWeight) * 100}%` }} />)}</colgroup>
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              {visibleCols.map((key) => (
                <th key={key} className="px-3 py-1.5 text-left font-semibold">
                  {SORTABLE.has(key) ? <SortableHeader label={COL_LABELS[key]} sortKey={key} sort={sort} onToggle={toggle} /> : COL_LABELS[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading accounts…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={visibleCols.length} className="px-6 py-10 text-center text-[13px] text-ink-3">No accounts match.{" "}
                <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setRules([]); setDealType("all"); }}>Clear filters</button></td></tr>
            ) : grouped ? (
              grouped.map((item) => item.kind === "header" ? (
                <tr key={`g-${item.key}`} className="cursor-pointer border-y border-border-strong bg-surface-2/70 hover:bg-surface-2" onClick={() => toggleGroup(item.key)}>
                  <td colSpan={visibleCols.length} className="px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-ink-2">
                    <span className="inline-block w-3 text-ink-3">{item.collapsed ? "▸" : "▾"}</span>{item.label}<span className="ml-2 normal-case tracking-normal text-ink-3">{item.count}</span>
                  </td>
                </tr>
              ) : renderRow(item.a))
            ) : (
              filtered.map(renderRow)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
