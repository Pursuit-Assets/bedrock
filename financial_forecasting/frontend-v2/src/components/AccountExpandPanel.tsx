import { useMemo } from "react";
import { Link } from "react-router-dom";

import { ActivityTab } from "@/components/expand/ActivityTab";
import { TaskListTab } from "@/components/expand/TaskListTab";
import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { fmtDate, fmtMoney } from "@/lib/format";
import { stageStatus } from "@/lib/stages";
import {
  useAccountTasks,
  useCreateAccountTask,
  useOpportunities,
} from "@/services/opportunities";
import { useAwards, type AwardStatus } from "@/services/awards";
import { useActiveUsers } from "@/services/users";
import type { SfTask } from "@/types/salesforce";

export const ACCOUNT_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

/**
 * Tabbed expand panel for a row on the Accounts page. Each tab is
 * lazy-mounted by RowExpandPanel — switching tabs is what triggers
 * the underlying React Query fetches.
 */
export function AccountExpandPanel({ accountId }: { accountId: string }) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "tasks",
          label: "Tasks",
          render: () => <AccountTasks accountId={accountId} />,
        },
        {
          id: "opps",
          label: "Opportunities",
          render: () => <AccountOpps accountId={accountId} />,
        },
        {
          id: "awards",
          label: "Awards",
          render: () => <AccountAwards accountId={accountId} />,
        },
        {
          id: "activity",
          label: "Activity",
          render: () => (
            <ActivityTab
              filters={{ accountId }}
              emptyMessage="No emails, meetings, or notes recorded for this account yet."
            />
          ),
        },
      ]}
    />
  );
}

function AccountTasks({ accountId }: { accountId: string }) {
  const { data: tasks = [], isLoading } = useAccountTasks(accountId);
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );
  const createTask = useCreateAccountTask();

  // Tasks filed directly on the account have WhatId === accountId; ones
  // filed on a child opp have a different WhatId — surface the opp name
  // as a small pill so it's obvious which record owns the task.
  const contextResolver = (t: SfTask) =>
    t.WhatId && t.WhatId !== accountId ? (t.WhatName ?? null) : null;

  return (
    <TaskListTab
      tasks={tasks}
      isLoading={isLoading}
      placeholder="Add an account-level task — press Enter to create"
      emptyMessage="No open tasks for this account."
      ownerOptions={ownerOptions}
      onCreate={async ({ subject, ownerId, activityDate }) => {
        await createTask.mutateAsync({
          accountId,
          body: {
            Subject: subject,
            OwnerId: ownerId ?? undefined,
            ActivityDate: activityDate ?? undefined,
          },
        });
      }}
      contextResolver={contextResolver}
    />
  );
}

function AccountOpps({ accountId }: { accountId: string }) {
  const { data: opps = [], isLoading } = useOpportunities();
  const filtered = useMemo(
    () => opps.filter((o) => o.AccountId === accountId),
    [opps, accountId],
  );

  // Header aggregate mirrors PaymentsTab's "X paid · Y pending":
  // total open pipeline + amount won, scoped to this account.
  const totals = useMemo(() => {
    let open = 0;
    let won = 0;
    for (const o of filtered) {
      const amt = o.Amount ?? 0;
      if (o.IsWon) won += amt;
      else if (!o.IsClosed) open += amt;
    }
    return { open, won };
  }, [filtered]);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading ? "…" : filtered.length} opportunit{filtered.length === 1 ? "y" : "ies"}
        </span>
        {filtered.length > 0 ? (
          <span className="mono">
            {fmtMoney(totals.open)} open · {fmtMoney(totals.won)} won
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No opportunities tied to this account.
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
              {filtered.map((o) => (
                <tr key={o.Id} className="border-t border-border-strong">
                  <td className="px-3 py-1.5">
                    <Link
                      to={`/opportunities/${o.Id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={o.Name}
                    >
                      {o.Name}
                    </Link>
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

function AccountAwards({ accountId }: { accountId: string }) {
  const { data: opps = [] } = useOpportunities();
  const { data: awards = [], isLoading } = useAwards();

  const filtered = useMemo(() => {
    const accountOppIds = new Set(
      opps.filter((o) => o.AccountId === accountId).map((o) => o.Id),
    );
    const oppById = new Map(opps.map((o) => [o.Id, o] as const));
    return awards
      .filter((a) => accountOppIds.has(a.opportunity_id))
      .map((a) => ({ award: a, opp: oppById.get(a.opportunity_id) ?? null }));
  }, [awards, opps, accountId]);

  // Aggregate: total awarded vs total paid, mirroring PaymentsTab.
  const totals = useMemo(() => {
    let total = 0;
    let paid = 0;
    for (const { opp } of filtered) {
      total += opp?.Amount ?? 0;
      paid += opp?.npe01__Payments_Made__c ?? 0;
    }
    return { total, paid };
  }, [filtered]);

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading ? "…" : filtered.length} award{filtered.length === 1 ? "" : "s"}
        </span>
        {filtered.length > 0 ? (
          <span className="mono">
            {fmtMoney(totals.total)} total · {fmtMoney(totals.paid)} paid
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
          No awards tied to this account.
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
              {filtered.map(({ award, opp }) => (
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

function statusVariant(s: AwardStatus): "green" | "amber" | "default" | "red" {
  if (s === "Active") return "green";
  if (s === "Closing") return "amber";
  if (s === "Did Not Fulfill") return "red";
  return "default";
}
