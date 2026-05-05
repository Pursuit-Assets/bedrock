import { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";

import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  useDeleteOwnerGoal,
  useOwnerGoals,
  useUpsertOwnerGoal,
} from "@/services/ownerGoals";
import { useActiveUsers } from "@/services/users";

export function TargetsTab({ canEdit }: { canEdit: boolean }) {
  const currentYear = new Date().getUTCFullYear();
  const [fy, setFy] = useState(currentYear);

  const { data: goals = [], isLoading } = useOwnerGoals(fy);
  const { data: activeUsers = [] } = useActiveUsers();
  const upsert = useUpsertOwnerGoal();
  const remove = useDeleteOwnerGoal();

  const goalByUserId = useMemo(() => {
    const m = new Map<string, (typeof goals)[number]>();
    for (const g of goals) m.set(g.sf_user_id, g);
    return m;
  }, [goals]);

  // Rows = SF active users; existing goal is joined in. We show every
  // active SF user so the targets table doubles as an at-a-glance roster
  // of who has and doesn't have a goal set this FY.
  const rows = useMemo(
    () =>
      activeUsers
        .map((u) => ({
          sf_user_id: u.Id,
          name: u.Name,
          email: u.Email ?? null,
          goal: goalByUserId.get(u.Id) ?? null,
        }))
        .sort((a, b) => {
          // Has-goal first (they're the "active" rows), then alphabetical.
          if (!!a.goal !== !!b.goal) return a.goal ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [activeUsers, goalByUserId],
  );

  const fyOptions = [currentYear - 1, currentYear, currentYear + 1];
  const totalTargets = rows.reduce(
    (s, r) => s + (r.goal?.goal_amount ?? 0),
    0,
  );
  const setCount = rows.filter((r) => r.goal != null).length;

  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong bg-surface-2 px-5 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-ink">FY revenue targets</div>
          <div className="mt-0.5 text-[12px] text-ink-3">
            Per-owner goals · drives the Wall of Progress on the dashboard
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-3">
          <span className="mono text-[12px] tabular-nums text-ink-3">
            {setCount}/{rows.length} set · {fmtMoney(totalTargets)} total
          </span>
          <div className="inline-flex overflow-hidden rounded border border-border-strong bg-surface">
            {fyOptions.map((opt, i) => (
              <button
                key={opt}
                type="button"
                onClick={() => setFy(opt)}
                className={cn(
                  "h-7 px-3 text-[12.5px] font-medium text-ink-2 transition-colors",
                  i > 0 && "border-l border-border-strong",
                  fy === opt && "bg-surface-2 text-ink",
                )}
              >
                FY{String(opt).slice(-2)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!canEdit ? (
        <div className="px-5 py-3 text-[12.5px] text-ink-3">
          Read-only — `manage_owner_goals` permission required to edit targets.
        </div>
      ) : null}

      {isLoading ? (
        <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
          Loading targets…
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
          No active Salesforce users found.
        </div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-4 py-1.5 text-left font-semibold">Owner</th>
              <th className="px-4 py-1.5 text-right font-semibold">Goal</th>
              <th className="px-4 py-1.5 text-left font-semibold">Notes</th>
              <th className="w-[80px] px-4 py-1.5 text-right font-semibold">
                {canEdit ? "Actions" : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TargetRow
                key={r.sf_user_id}
                row={r}
                fy={fy}
                canEdit={canEdit}
                onSave={(amount, notes) =>
                  upsert.mutateAsync({
                    sf_user_id: r.sf_user_id,
                    fiscal_year: fy,
                    goal_amount: amount,
                    notes,
                  })
                }
                onDelete={() =>
                  remove.mutateAsync({
                    sf_user_id: r.sf_user_id,
                    fiscal_year: fy,
                  })
                }
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface TargetRowProps {
  row: {
    sf_user_id: string;
    name: string;
    email: string | null;
    goal: { goal_amount: number; notes: string } | null;
  };
  fy: number;
  canEdit: boolean;
  onSave: (amount: number, notes: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}

function TargetRow({ row, canEdit, onSave, onDelete }: TargetRowProps) {
  const [editing, setEditing] = useState(false);
  const [amountStr, setAmountStr] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const startEdit = () => {
    setAmountStr(row.goal ? String(row.goal.goal_amount) : "");
    setNotes(row.goal?.notes ?? "");
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setAmountStr("");
    setNotes("");
  };

  const save = async () => {
    const cleaned = amountStr.replace(/[^0-9.]/g, "");
    const amount = Number(cleaned);
    if (!Number.isFinite(amount) || amount < 0) return;
    setBusy(true);
    try {
      await onSave(amount, notes);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!row.goal) return;
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-t border-border-strong align-top">
      <td className="px-4 py-2">
        <div className="font-medium text-ink">{row.name}</div>
        {row.email ? (
          <div className="text-[11px] text-ink-3">{row.email}</div>
        ) : null}
      </td>
      <td className="mono px-4 py-2 text-right tabular-nums">
        {editing ? (
          <input
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            autoFocus
            disabled={busy}
            className="w-[120px] rounded border border-border-strong bg-surface px-2 py-1 text-right text-[12.5px] tabular-nums text-ink outline-none focus:border-accent"
          />
        ) : row.goal ? (
          <span className="font-semibold">{fmtMoney(row.goal.goal_amount)}</span>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </td>
      <td className="px-4 py-2">
        {editing ? (
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes…"
            disabled={busy}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        ) : row.goal?.notes ? (
          <span className="text-ink-2">{row.goal.notes}</span>
        ) : (
          <span className="text-ink-4">—</span>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {!canEdit ? null : editing ? (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="h-7 rounded border border-ink bg-ink px-2 text-[11.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="grid h-7 w-7 place-items-center rounded border border-border-strong bg-surface text-ink-3 hover:bg-surface-2"
              aria-label="Cancel"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="flex justify-end gap-1">
            <button
              type="button"
              onClick={startEdit}
              className="h-7 rounded border border-border-strong bg-surface px-2 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2"
            >
              {row.goal ? "Edit" : (
                <span className="inline-flex items-center gap-1">
                  <Plus size={11} /> Set
                </span>
              )}
            </button>
            {row.goal ? (
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                title="Remove target"
                className="grid h-7 w-7 place-items-center rounded border border-border-strong bg-surface text-ink-3 hover:bg-surface-2 hover:text-red"
              >
                <Trash2 size={12} />
              </button>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}
