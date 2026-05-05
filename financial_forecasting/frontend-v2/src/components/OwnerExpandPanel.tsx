import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoney } from "@/lib/format";
import { isOpen, isWon, stageStatus } from "@/lib/stages";
import { STAGE_IDX } from "@/lib/funnelStages";
import { useAccounts } from "@/services/accounts";
import { useAwards, type AwardStatus } from "@/services/awards";
import {
  useOpportunities,
  useUserTasks,
} from "@/services/opportunities";
export const OWNER_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

/**
 * Per-owner tabbed expand panel for the Dashboard's Individual Goals
 * table. Same RowExpandPanel pattern used elsewhere; tabs are lazy-
 * mounted so switching is what triggers each tab's queries.
 *
 * Tasks and Activity are owner-scoped via dedicated backend filters
 * (Task.OwnerId and bedrock.activity.owner_id respectively); the
 * other tabs filter from the already-cached list queries shared with
 * the Accounts / Pipeline / Awards pages.
 */
export function OwnerExpandPanel({ ownerId }: { ownerId: string }) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "tasks",
          label: "Tasks",
          render: () => <OwnerTasks ownerId={ownerId} />,
        },
        {
          id: "accounts",
          label: "Accounts",
          render: () => <OwnerAccounts ownerId={ownerId} />,
        },
        {
          id: "opps",
          label: "Opportunities",
          render: () => <OwnerOpps ownerId={ownerId} />,
        },
        {
          id: "awards",
          label: "Awards",
          render: () => <OwnerAwards ownerId={ownerId} />,
        },
        {
          id: "activity",
          label: "Activity",
          render: () => (
            <ActivityTab
              filters={{ ownerId }}
              emptyMessage="No activity attributed to this owner yet."
            />
          ),
        },
      ]}
    />
  );
}

// ── Tasks ────────────────────────────────────────────────────────────────

function OwnerTasks({ ownerId }: { ownerId: string }) {
  const { data: tasks = [], isLoading } = useUserTasks(ownerId);
  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      emptyMessage="No open tasks for this owner."
      contextResolver={(t) => t.WhatName ?? null}
    />
  );
}

// ── Accounts ─────────────────────────────────────────────────────────────

function OwnerAccounts({ ownerId }: { ownerId: string }) {
  const { data: accounts = [], isLoading } = useAccounts();
  const { data: opps = [] } = useOpportunities();

  const rows = useMemo(() => {
    const owned = accounts.filter((a) => a.OwnerId === ownerId);
    // Compute open pipeline + amount won per account so this table has
    // the same shape as the Accounts page totals.
    const accountIds = new Set(owned.map((a) => a.Id));
    const totals = new Map<string, { open: number; won: number }>();
    for (const o of opps) {
      if (!o.AccountId || !accountIds.has(o.AccountId)) continue;
      const cur = totals.get(o.AccountId) ?? { open: 0, won: 0 };
      if (isOpen(o)) cur.open += o.Amount ?? 0;
      else if (isWon(o)) cur.won += o.Amount ?? 0;
      totals.set(o.AccountId, cur);
    }
    return owned.map((a) => ({
      id: a.Id,
      name: a.Name,
      type: a.Type ?? null,
      open: totals.get(a.Id)?.open ?? 0,
      won: totals.get(a.Id)?.won ?? 0,
    })).sort((x, y) => y.open - x.open);
  }, [accounts, opps, ownerId]);

  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  const totalWon = rows.reduce((s, r) => s + r.won, 0);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>{isLoading ? "…" : `${rows.length} account${rows.length === 1 ? "" : "s"}`}</span>
        {rows.length > 0 ? (
          <span className="mono">
            {fmtMoney(totalOpen)} open · {fmtMoney(totalWon)} won
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No accounts owned by this user.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong bg-surface">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Type</th>
                <th className="px-3 py-1.5 text-right font-semibold">Open pipeline</th>
                <th className="px-3 py-1.5 text-right font-semibold">Amount won</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/accounts/${r.id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={r.name}
                    >
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5 text-ink-2">
                    {r.type ?? <span className="text-ink-4">—</span>}
                  </td>
                  <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                    {r.open > 0 ? fmtMoney(r.open) : "—"}
                  </td>
                  <td className="mono px-3 py-1.5 text-right tabular-nums text-ink-2">
                    {r.won > 0 ? fmtMoney(r.won) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Opportunities ────────────────────────────────────────────────────────

function OwnerOpps({ ownerId }: { ownerId: string }) {
  const { data: opps = [], isLoading } = useOpportunities();
  const owned = useMemo(
    () => opps.filter((o) => o.OwnerId === ownerId),
    [opps, ownerId],
  );

  const totals = useMemo(() => {
    let open = 0;
    let won = 0;
    for (const o of owned) {
      const amt = o.Amount ?? 0;
      if (isOpen(o)) open += amt;
      else if (isWon(o)) won += amt;
    }
    return { open, won };
  }, [owned]);

  // Later funnel stages first (most advanced = most actionable), then by
  // close date ascending within each stage.
  const sorted = useMemo(
    () =>
      owned.slice().sort((a, b) => {
        const aOpen = isOpen(a) ? 0 : 1;
        const bOpen = isOpen(b) ? 0 : 1;
        if (aOpen !== bOpen) return aOpen - bOpen;
        // Within open opps: later stage first (higher STAGE_IDX = further along)
        const aIdx = STAGE_IDX.get(a.StageName ?? "") ?? -1;
        const bIdx = STAGE_IDX.get(b.StageName ?? "") ?? -1;
        if (aIdx !== bIdx) return bIdx - aIdx;
        const aDate = a.CloseDate ? new Date(a.CloseDate).getTime() : 0;
        const bDate = b.CloseDate ? new Date(b.CloseDate).getTime() : 0;
        return aDate - bDate;
      }),
    [owned],
  );

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading ? "…" : owned.length} opportunit{owned.length === 1 ? "y" : "ies"}
        </span>
        {owned.length > 0 ? (
          <span className="mono">
            {fmtMoney(totals.open)} open · {fmtMoney(totals.won)} won
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : owned.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No opportunities owned by this user.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong bg-surface">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Stage</th>
                <th className="px-3 py-1.5 text-left font-semibold">Close</th>
                <th className="px-3 py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((o) => (
                <tr key={o.Id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/opportunities/${o.Id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={o.Name}
                    >
                      {o.Name}
                    </Link>
                    {o.Account?.Name ? (
                      <span className="block truncate text-[10.5px] text-ink-3">
                        {o.Account.Name}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5">
                    <StageChip stage={o.StageName} status={stageStatus(o)} />
                  </td>
                  <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                    {fmtDate(o.CloseDate)}
                  </td>
                  <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                    {o.Amount ? fmtMoney(o.Amount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Awards ──────────────────────────────────────────────────────────────

function statusVariant(s: AwardStatus): "green" | "amber" | "default" | "red" {
  if (s === "Active") return "green";
  if (s === "Closing") return "amber";
  if (s === "Did Not Fulfill") return "red";
  return "default";
}

const AWARD_STATUS_ORDER: Record<AwardStatus, number> = {
  Active: 0,
  Closing: 1,
  Closed: 2,
  "Did Not Fulfill": 3,
};

function OwnerAwards({ ownerId }: { ownerId: string }) {
  const { data: opps = [] } = useOpportunities();
  const { data: awards = [], isLoading } = useAwards();
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const ownedOppIds = new Set(
      opps.filter((o) => o.OwnerId === ownerId).map((o) => o.Id),
    );
    const oppById = new Map(opps.map((o) => [o.Id, o] as const));
    return awards
      .filter((a) => ownedOppIds.has(a.opportunity_id))
      .map((a) => ({ award: a, opp: oppById.get(a.opportunity_id) ?? null }))
      .sort(
        (x, y) =>
          (AWARD_STATUS_ORDER[x.award.award_status] ?? 99) -
          (AWARD_STATUS_ORDER[y.award.award_status] ?? 99),
      );
  }, [awards, opps, ownerId]);

  const activeRows = useMemo(
    () => rows.filter((r) => r.award.award_status === "Active"),
    [rows],
  );
  const displayed = showAll ? rows : activeRows;
  const hiddenCount = rows.length - activeRows.length;

  const totals = useMemo(() => {
    let total = 0;
    let paid = 0;
    for (const { opp } of rows) {
      total += opp?.Amount ?? 0;
      paid += opp?.npe01__Payments_Made__c ?? 0;
    }
    return { total, paid };
  }, [rows]);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading
            ? "…"
            : showAll
              ? `${rows.length} award${rows.length === 1 ? "" : "s"}`
              : `${activeRows.length} active award${activeRows.length === 1 ? "" : "s"}`}
          {!showAll && hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              +{hiddenCount} more
            </button>
          ) : showAll && hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              active only
            </button>
          ) : null}
        </span>
        {rows.length > 0 ? (
          <span className="mono">
            {fmtMoney(totals.total)} total · {fmtMoney(totals.paid)} paid
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No awards owned by this user.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong bg-surface">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-3 py-1.5 text-left font-semibold">Name</th>
                <th className="px-3 py-1.5 text-left font-semibold">Status</th>
                <th className="px-3 py-1.5 text-left font-semibold">Awarded</th>
                <th className="px-3 py-1.5 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {displayed.map(({ award, opp }) => (
                <tr key={award.id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/awards/${award.id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={opp?.Name ?? award.opportunity_id}
                    >
                      {opp?.Name ?? award.opportunity_id}
                    </Link>
                  </td>
                  <td className="px-3 py-1.5">
                    <Tag variant={statusVariant(award.award_status)}>
                      {award.award_status}
                    </Tag>
                  </td>
                  <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                    {fmtDate(award.award_date)}
                  </td>
                  <td className="mono px-3 py-1.5 text-right font-medium tabular-nums">
                    {opp?.Amount ? fmtMoney(opp.Amount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
