import { useMemo } from "react";
import { Link } from "react-router-dom";

import { RowExpandPanel, ROW_EXPAND_HEIGHT } from "@/components/RowExpandPanel";
import { StageChip } from "@/components/ui/StageChip";
import { fmtDate, fmtMoney } from "@/lib/format";
import { stageStatus, isWon } from "@/lib/stages";
import { useFellowsForAccount } from "@/services/affiliations";
import { useOpportunities } from "@/services/opportunities";

export const JOBS_ACCOUNT_PANEL_HEIGHT = ROW_EXPAND_HEIGHT;

/**
 * Per-account tabbed expand panel for the Jobs page. Two tabs:
 *   - Fellows: contact records affiliated with this account as a Fellow,
 *              with headshot + role + start date + status
 *   - PBC wins: won opportunities on this account whose RecordType.Name = PBC
 */
export function JobsAccountExpandPanel({ accountId }: { accountId: string }) {
  return (
    <RowExpandPanel
      tabs={[
        {
          id: "fellows",
          label: "Fellows",
          render: () => <FellowsTab accountId={accountId} />,
        },
        {
          id: "pbc",
          label: "PBC wins",
          render: () => <PBCTab accountId={accountId} />,
        },
      ]}
    />
  );
}

function FellowsTab({ accountId }: { accountId: string }) {
  const { data, isLoading } = useFellowsForAccount(accountId);

  if (isLoading) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        Loading fellows…
      </div>
    );
  }
  if (!data?.available) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        Affiliation object isn't configured in this Salesforce org yet — fellow
        placements can't be surfaced.
      </div>
    );
  }
  if (data.data.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No Fellow affiliations on this account.
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-3">
        {data.data.length} fellow{data.data.length === 1 ? "" : "s"}
      </div>
      <div className="overflow-hidden rounded border border-border-strong bg-surface">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold">Fellow</th>
              <th className="px-3 py-1.5 text-left font-semibold">Role</th>
              <th className="w-[120px] px-3 py-1.5 text-left font-semibold">Start date</th>
              <th className="w-[110px] px-3 py-1.5 text-left font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((f) => (
              <tr key={f.affiliation_id ?? f.contact_id ?? f.name ?? Math.random()} className="border-t border-border-strong">
                <td className="px-3 py-1.5">
                  {f.contact_id ? (
                    <Link
                      to={`/contacts/${f.contact_id}`}
                      className="block truncate font-medium text-ink hover:underline"
                      title={f.name ?? f.contact_id}
                    >
                      {f.name ?? "(unnamed)"}
                    </Link>
                  ) : (
                    <span className="block truncate font-medium text-ink">
                      {f.name ?? "(unnamed)"}
                    </span>
                  )}
                  {f.title ? (
                    <span className="block truncate text-[10.5px] text-ink-3">
                      {f.title}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-1.5 text-ink-2">{f.role ?? "—"}</td>
                <td className="mono px-3 py-1.5 text-[11.5px] text-ink-2">
                  {fmtDate(f.start_date)}
                </td>
                <td className="px-3 py-1.5 text-ink-2">{f.status ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PBCTab({ accountId }: { accountId: string }) {
  const { data: opps = [], isLoading } = useOpportunities();

  const pbcWons = useMemo(
    () =>
      opps.filter(
        (o) =>
          o.AccountId === accountId &&
          o.RecordType?.Name === "PBC" &&
          isWon(o),
      ),
    [opps, accountId],
  );

  if (isLoading) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        Loading opportunities…
      </div>
    );
  }
  if (pbcWons.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[12px] text-ink-3">
        No PBC wins on this account.
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-[11px] uppercase tracking-wider text-ink-3">
        {pbcWons.length} PBC win{pbcWons.length === 1 ? "" : "s"}
      </div>
      <div className="overflow-hidden rounded border border-border-strong bg-surface">
        <table className="w-full text-[12px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold">Opportunity</th>
              <th className="px-3 py-1.5 text-left font-semibold">Stage</th>
              <th className="w-[110px] px-3 py-1.5 text-left font-semibold">Close</th>
              <th className="w-[110px] px-3 py-1.5 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {pbcWons.map((o) => (
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
    </div>
  );
}
