/**
 * Jobs · Accounts — the account-level hub.
 *
 * The account (company) is the organizing unit: every company with an
 * opportunity OR a jobs contact is one row, carrying a derived status (same
 * vocabulary as the portfolio Accounts tab) and an inline-editable owner.
 * Expanding a row reveals everything at that account via tabs (Opportunities ·
 * Contacts · Activity · Tasks · Comments · Builders · Roles). The account name
 * links through to the account detail page.
 */
import { Fragment, useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Briefcase, ChevronDown, ChevronRight, ExternalLink, Users } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { withReferrer } from "@/components/detail";
import { AccountExpandTabs } from "@/components/jobs/accountTabs";
import { OwnerSelect, jobsAccountPath } from "@/components/jobs/jobsEntity";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import {
  useJobsAccounts,
  useJobsStaff,
  useUpdateJobsAccount,
  type JobsAccount,
  type JobsAccountStatus,
  type JobsStaff,
} from "@/services/jobs";

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

const STATUS_FILTER: { value: string; label: string }[] = [
  { value: "",              label: "All statuses" },
  { value: "Pursuing",      label: "Pursuing" },
  { value: "Stewarding",    label: "Stewarding" },
  { value: "Re-activating", label: "Re-activating" },
  { value: "Prospect",      label: "Prospect" },
  { value: "Dormant",       label: "Dormant" },
];

const DEAL_TYPE_FILTER: { value: string; label: string }[] = [
  { value: "all",         label: "All deal types" },
  { value: "ft",          label: "Full-time" },
  { value: "pt_contract", label: "Contract" },
  { value: "capstone",    label: "Capstone" },
  { value: "volunteer",   label: "Volunteer" },
  { value: "workshop",    label: "Workshop" },
  { value: "pilot",       label: "Pilot" },
];

function AccountRow({
  account, expanded, onToggle, staff, onSaveOwner,
}: {
  account: JobsAccount;
  expanded: boolean;
  onToggle: () => void;
  staff: JobsStaff[];
  onSaveOwner: (account: string, email: string) => Promise<void>;
}) {
  return (
    <Fragment>
      <tr className="cursor-pointer border-t border-border-strong bg-surface hover:bg-surface-2/50" onClick={onToggle}>
        <td className="py-2 pl-3 pr-1 align-middle">
          {expanded ? <ChevronDown size={13} className="text-ink-3" /> : <ChevronRight size={13} className="text-ink-3" />}
        </td>
        <td className="px-2 py-2 align-middle">
          <span className="flex min-w-0 items-center gap-2.5">
            <AccountAvatar name={account.account} logoUrl={null} size={20} />
            <span className="truncate text-[13.5px] font-semibold text-ink">{account.account}</span>
            <Link
              to={jobsAccountPath(account.account_key)}
              state={withReferrer({ pathname: "/jobs", label: "Jobs" })}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0 text-ink-4 hover:text-accent"
              title="Open account detail"
            >
              <ExternalLink size={12} />
            </Link>
          </span>
        </td>
        <td className="px-2 py-2 align-middle">
          <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag>
        </td>
        <td className="px-2 py-2 align-middle">
          <OwnerSelect owner={account.owner_email} staff={staff} onSave={(email) => onSaveOwner(account.account, email)} />
        </td>
        <td className="px-2 py-2 align-middle text-[12px] text-ink-2">
          {account.opp_count > 0 ? <span className="inline-flex items-center gap-1"><Briefcase size={11} className="text-ink-4" />{account.opp_count}</span> : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-2 py-2 align-middle text-[12px] text-ink-2">
          {account.prospect_count > 0 ? <span className="inline-flex items-center gap-1"><Users size={11} className="text-ink-4" />{account.prospect_count}</span> : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-3 py-2 align-middle text-[11.5px] text-ink-4">{relativeDays(account.last_activity)}</td>
      </tr>
      {expanded && (
        <tr className="bg-surface-2/30">
          <td colSpan={7} className="p-0"><AccountExpandTabs account={account} /></td>
        </tr>
      )}
    </Fragment>
  );
}

export function JobsAccountHub({ initialQuery }: { initialQuery?: string } = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [status, setStatus] = useState<string>("");
  const [dealType, setDealType] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: accounts = [], isLoading } = useJobsAccounts(dealType);
  const { data: staff = [] } = useJobsStaff();
  const updateAccount = useUpdateJobsAccount();
  const saveOwner = useCallback(
    (account: string, email: string) => updateAccount.mutateAsync({ account, owner_email: email }).then(() => undefined),
    [updateAccount],
  );

  const toggle = useCallback((acct: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(acct)) next.delete(acct);
      else next.add(acct);
      return next;
    });
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return accounts.filter((a) => {
      if (status && a.account_status !== (status as JobsAccountStatus)) return false;
      if (!q) return true;
      if (a.account.toLowerCase().includes(q)) return true;
      return (
        a.prospects.some((p) => (p.full_name ?? "").toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q)) ||
        a.opportunities.some((o) => (o.title ?? "").toLowerCase().includes(q))
      );
    });
  }, [accounts, q, status]);

  const totals = useMemo(() => filtered.reduce(
    (acc, a) => ({ opps: acc.opps + a.opp_count, prospects: acc.prospects + a.prospect_count }),
    { opps: 0, prospects: 0 },
  ), [filtered]);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder="Search accounts, contacts, opportunities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 w-72 rounded border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} title="Filter by account status" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {STATUS_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={dealType} onChange={(e) => setDealType(e.target.value)} title="Filter to accounts with a deal of this type" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {DEAL_TYPE_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${filtered.length} account${filtered.length === 1 ? "" : "s"} · ${totals.opps} opp${totals.opps === 1 ? "" : "s"} · ${totals.prospects} contact${totals.prospects === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setExpanded(new Set(filtered.map((a) => a.account)))} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Expand all</button>
          <button type="button" onClick={() => setExpanded(new Set())} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Collapse all</button>
        </div>
      </div>

      <div className="overflow-auto rounded-lg border border-border-strong bg-surface">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[34px] py-1.5 pl-3" />
              <th className="px-2 py-1.5 text-left font-semibold">Account</th>
              <th className="w-[120px] px-2 py-1.5 text-left font-semibold">Status</th>
              <th className="w-[150px] px-2 py-1.5 text-left font-semibold">Owner</th>
              <th className="w-[80px] px-2 py-1.5 text-left font-semibold">Opps</th>
              <th className="w-[90px] px-2 py-1.5 text-left font-semibold">Contacts</th>
              <th className="w-[100px] px-3 py-1.5 text-left font-semibold">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading accounts…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  No accounts match your filters.{" "}
                  <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setStatus(""); setDealType("all"); }}>Clear filters</button>
                </td>
              </tr>
            ) : (
              filtered.map((a) => (
                <AccountRow key={a.account} account={a} expanded={expanded.has(a.account)} onToggle={() => toggle(a.account)} staff={staff} onSaveOwner={saveOwner} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
