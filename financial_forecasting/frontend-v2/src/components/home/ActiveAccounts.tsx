import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Building2, ChevronDown } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import { useLayoutPrefs } from "@/lib/useLayoutPrefs";
import { cn } from "@/lib/utils";
import { useAccounts } from "@/services/accounts";
import { useOpportunities } from "@/services/opportunities";
import type { SfAccount } from "@/types/salesforce";

const STORAGE_KEY = "bedrock:home:jp:accounts";

interface AccountsPrefs {
  scope: "mine" | "all";
  limit: number;
}

const DEFAULTS: AccountsPrefs = { scope: "mine", limit: 10 };
const LIMIT_OPTIONS = [5, 10, 20, 50] as const;

export interface ActiveAccountsProps {
  currentUserId: string | null;
  onAccountClick?: (account: SfAccount) => void;
  className?: string;
}

interface AccountRow {
  account: SfAccount | null;
  accountId: string;
  accountName: string;
  openOppCount: number;
  weightedPipeline: number;
  totalAmount: number;
  nearestCloseDate: string | null;
  lastActivityDate: string | null;
}

/**
 * Account-grouped view of my open pipeline.
 *
 * Joins `useOpportunities` (the source of "open work I care about")
 * with `useAccounts` (for the SfAccount shape that AccountDrawer wants
 * + the `LastActivityDate` field that's missing on SfOpportunity).
 * Groups opps by AccountId, ranks by weighted pipeline, surfaces the
 * top N. Click → caller opens AccountDrawer.
 *
 * Adds account-level perspective alongside the opportunity-deliverable
 * surfaces (PriorityTable, TaskInbox) without competing with them.
 */
export function ActiveAccounts({
  currentUserId,
  onAccountClick,
  className,
}: ActiveAccountsProps) {
  const oppsQ = useOpportunities();
  const accountsQ = useAccounts();

  const { prefs, setPrefs } = useLayoutPrefs<AccountsPrefs>(
    STORAGE_KEY,
    DEFAULTS,
  );

  const accountById = useMemo(() => {
    const m = new Map<string, SfAccount>();
    for (const a of accountsQ.data ?? []) m.set(a.Id, a);
    return m;
  }, [accountsQ.data]);

  const rows = useMemo<AccountRow[]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets = new Map<string, AccountRow>();

    for (const o of oppsQ.data ?? []) {
      if (o.IsClosed) continue;
      if (!o.AccountId) continue;
      if (
        prefs.scope === "mine" &&
        currentUserId &&
        o.OwnerId !== currentUserId
      ) {
        continue;
      }
      const id = o.AccountId;
      const prob =
        (o.Manager_Probability_Override__c ?? o.Probability ?? 0) / 100;
      const weighted = (o.Amount ?? 0) * prob;
      const closeDate = o.CloseDate ?? null;

      const existing = buckets.get(id);
      if (existing) {
        existing.openOppCount += 1;
        existing.totalAmount += o.Amount ?? 0;
        existing.weightedPipeline += weighted;
        if (
          closeDate &&
          (!existing.nearestCloseDate || closeDate < existing.nearestCloseDate)
        ) {
          existing.nearestCloseDate = closeDate;
        }
      } else {
        const account = accountById.get(id) ?? null;
        buckets.set(id, {
          account,
          accountId: id,
          accountName: account?.Name ?? o.Account?.Name ?? "—",
          openOppCount: 1,
          totalAmount: o.Amount ?? 0,
          weightedPipeline: weighted,
          nearestCloseDate: closeDate,
          lastActivityDate:
            account?.LastActivityDate ?? account?.Last_Activity_Date__c ?? null,
        });
      }
    }
    const all = [...buckets.values()].sort(
      (a, b) => b.weightedPipeline - a.weightedPipeline,
    );
    return all.slice(0, prefs.limit);
  }, [oppsQ.data, accountById, currentUserId, prefs.scope, prefs.limit]);

  const loading = oppsQ.isLoading || accountsQ.isLoading;
  const totalAccountsAvailable = useMemo(() => {
    const ids = new Set<string>();
    for (const o of oppsQ.data ?? []) {
      if (o.IsClosed) continue;
      if (!o.AccountId) continue;
      if (
        prefs.scope === "mine" &&
        currentUserId &&
        o.OwnerId !== currentUserId
      ) {
        continue;
      }
      ids.add(o.AccountId);
    }
    return ids.size;
  }, [oppsQ.data, currentUserId, prefs.scope]);

  return (
    <section
      className={cn(
        "flex flex-col rounded-lg border border-border-strong bg-surface",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Building2 size={15} className="text-accent" /> Active accounts
        </div>
        <Tag>
          {rows.length} of {totalAccountsAvailable}
        </Tag>
        <div className="flex-1" />
        <ScopeToggle
          scope={prefs.scope}
          onChange={(s) => setPrefs({ scope: s })}
        />
        <LimitSelect
          limit={prefs.limit}
          onChange={(n) => setPrefs({ limit: n })}
        />
      </header>

      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-left text-[10.5px] uppercase tracking-wider text-ink-3">
              <th className="border-b border-border-strong px-3 py-1.5 font-semibold">
                Account
              </th>
              <th className="border-b border-border-strong px-3 py-1.5 text-right font-semibold">
                Open
              </th>
              <th className="border-b border-border-strong px-3 py-1.5 text-right font-semibold">
                Weighted
              </th>
              <th className="border-b border-border-strong px-3 py-1.5 text-right font-semibold">
                Total
              </th>
              <th className="border-b border-border-strong px-3 py-1.5 font-semibold">
                Nearest close
              </th>
              <th className="border-b border-border-strong px-3 py-1.5 font-semibold">
                Last activity
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => <SkeletonRow key={i} />)
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-6 py-10 text-center text-[12.5px] text-ink-3"
                >
                  {prefs.scope === "mine"
                    ? "No open opportunities owned by you yet."
                    : "No open opportunities found."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <AccountRowView
                  key={r.accountId}
                  row={r}
                  onClick={() => {
                    if (r.account) onAccountClick?.(r.account);
                  }}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AccountRowView({
  row,
  onClick,
}: {
  row: AccountRow;
  onClick: () => void;
}) {
  const clickable = !!row.account;
  return (
    <tr
      className={cn(
        "border-b border-border-strong last:border-b-0",
        clickable && "cursor-pointer hover:bg-surface-2",
      )}
      onClick={clickable ? onClick : undefined}
    >
      <td className="px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <AccountAvatar name={row.accountName} logoUrl={null} size={18} />
          <span className="truncate font-medium text-ink" title={row.accountName}>
            {row.accountName}
          </span>
          {!row.account ? (
            <span
              title="Account record not loaded (open opportunities reference an account ID with no SF row yet)"
              className="text-[10.5px] italic text-ink-4"
            >
              · pending sync
            </span>
          ) : null}
        </div>
      </td>
      <td className="mono px-3 py-1.5 text-right tabular-nums text-ink">
        <Link
          to={`/pipeline?scope=open&account=${encodeURIComponent(row.accountId)}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-block rounded px-1.5 py-px hover:bg-accent-soft hover:text-accent-ink"
          title={`Open ${row.openOppCount} opportunit${row.openOppCount === 1 ? "y" : "ies"} on this account in Pipeline`}
        >
          {row.openOppCount}
        </Link>
      </td>
      <td className="mono px-3 py-1.5 text-right font-semibold tabular-nums text-ink">
        {fmtMoneyFull(row.weightedPipeline)}
      </td>
      <td className="mono px-3 py-1.5 text-right tabular-nums text-ink-2">
        {fmtMoneyFull(row.totalAmount)}
      </td>
      <td className="mono px-3 py-1.5 text-[11.5px] tabular-nums text-ink-3">
        {fmtDate(row.nearestCloseDate)}
      </td>
      <td className="mono px-3 py-1.5 text-[11.5px] tabular-nums text-ink-3">
        {fmtDate(row.lastActivityDate)}
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr aria-busy>
      {Array.from({ length: 6 }).map((_, i) => (
        <td key={i} className="border-b border-border-strong px-3 py-1.5">
          <div className="h-4 animate-pulse rounded bg-surface-2" />
        </td>
      ))}
    </tr>
  );
}

function ScopeToggle({
  scope,
  onChange,
}: {
  scope: AccountsPrefs["scope"];
  onChange: (s: AccountsPrefs["scope"]) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Account scope"
      className="inline-flex h-7 overflow-hidden rounded border border-border-strong"
    >
      {(["mine", "all"] as const).map((s, i) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          aria-pressed={scope === s}
          className={cn(
            "h-7 px-2 text-[11.5px] font-medium",
            i > 0 && "border-l border-border-strong",
            scope === s
              ? "bg-accent-soft text-accent-ink"
              : "bg-surface text-ink-2 hover:bg-surface-2",
          )}
        >
          {s === "mine" ? "Mine" : "All"}
        </button>
      ))}
    </div>
  );
}

function LimitSelect({
  limit,
  onChange,
}: {
  limit: number;
  onChange: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-1 rounded border border-border-strong bg-surface px-2 text-[11.5px] font-medium text-ink hover:bg-surface-2"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        Top {limit} <ChevronDown size={11} />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 z-10 mt-1 w-24 overflow-hidden rounded border border-border-strong bg-surface shadow-md"
        >
          {LIMIT_OPTIONS.map((n) => (
            <li key={n}>
              <button
                type="button"
                onClick={() => {
                  onChange(n);
                  setOpen(false);
                }}
                className={cn(
                  "block w-full px-3 py-1 text-left text-[11.5px] hover:bg-surface-2",
                  n === limit && "bg-accent-soft text-accent-ink",
                )}
              >
                Top {n}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
