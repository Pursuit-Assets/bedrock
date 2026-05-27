/**
 * Payment-schedule builder modal for Opportunity detail.
 *
 * Two input modes:
 *   - "even" (default): N payments evenly split, starting on a date
 *     and stepping by a chosen frequency (monthly/quarterly/etc.).
 *     Common case — generates the rows for the user.
 *   - "custom": full grid of {amount, date} rows the user can edit
 *     directly. Used when payments aren't evenly spaced or sized.
 *
 * Backend constraint: sum(amounts) must equal Opportunity.Amount or
 * the POST is rejected. We surface the running total + diff inline
 * so the user can fix before submitting; the Apply button is disabled
 * when the totals don't match.
 *
 * Defaults to `delete_existing=true` — replacing the schedule is the
 * intuitive interpretation of "Create payment schedule" on an opp
 * that already has one. Toggle off to append instead.
 */
import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import {
  useCreatePaymentSchedule,
  useCreateSinglePayment,
  useDeletePayment,
  useUpdatePayment,
  type PaymentScheduleItem,
} from "@/services/payments";
import { fmtMoneyFull } from "@/lib/format";
import { cn } from "@/lib/utils";

type Frequency = "monthly" | "quarterly" | "semiannual" | "annual";

const FREQ_LABELS: Record<Frequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semiannual: "Semi-annually",
  annual: "Annually",
};

const FREQ_MONTHS: Record<Frequency, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

export interface ExistingPayment {
  Id: string;
  npe01__Payment_Amount__c?: number | null;
  npe01__Scheduled_Date__c?: string | null;
  npe01__Paid__c?: boolean | null;
  npe01__Payment_Date__c?: string | null;
}

export interface PaymentScheduleBuilderProps {
  opportunityId: string;
  /** Required for total-validation — the schedule must sum to this. */
  oppAmount: number | null;
  /** Existing payments from SF — pre-populates custom mode for review/edit. */
  existingPayments?: ExistingPayment[];
  /** Pre-fill the first scheduled date (e.g. opp.PaymentDate__c). */
  initialFirstDate?: string | null;
  /** Optional banner message shown at the top of the modal. */
  prompt?: string | null;
  /** Called after a schedule is successfully saved, before onClose. */
  onSaved?: () => void;
  onClose: () => void;
  /** When true, skip the modal wrapper (backdrop + card) and render
   *  the body + actions as a fragment so the caller can drop the
   *  editor straight into another dialog's body. The Cancel button
   *  reads "Back" instead of "Cancel" in this mode. */
  inline?: boolean;
}

export function PaymentScheduleBuilder({
  opportunityId,
  oppAmount,
  existingPayments = [],
  initialFirstDate,
  prompt,
  onSaved,
  onClose,
  inline = false,
}: PaymentScheduleBuilderProps) {
  const create = useCreatePaymentSchedule(opportunityId);
  const createSingle = useCreateSinglePayment(opportunityId);
  const updateOne = useUpdatePayment(opportunityId);
  const deleteOne = useDeletePayment(opportunityId);

  const hasExisting = existingPayments.length > 0;

  // When existing payments are present, start in custom mode pre-filled with them.
  const [mode, setMode] = useState<"even" | "custom">(hasExisting ? "custom" : "even");
  const [count, setCount] = useState<number>(4);
  const [frequency, setFrequency] = useState<Frequency>("quarterly");
  const [firstDate, setFirstDate] = useState<string>(
    initialFirstDate ?? todayIso(),
  );
  const deleteExisting = true;

  // Pre-populate custom rows from existing payments on first render.
  const [customRows, setCustomRows] = useState<PaymentScheduleItem[]>(() =>
    hasExisting
      ? existingPayments.map((p) => ({
          amount: p.npe01__Payment_Amount__c ?? 0,
          scheduled_date: p.npe01__Scheduled_Date__c ?? todayIso(),
        }))
      : [],
  );

  // Track which rows are already-paid (read-only).
  const paidIds = new Set(
    existingPayments.filter((p) => p.npe01__Paid__c).map((p) => p.Id),
  );
  // Map custom row index → SF payment Id (for locking paid rows).
  const existingIds = existingPayments.map((p) => p.Id);

  const [error, setError] = useState<string | null>(null);

  // Generated even-split rows. Recomputes whenever the inputs change.
  const evenRows = useMemo<PaymentScheduleItem[]>(() => {
    if (!oppAmount || oppAmount <= 0 || count <= 0) return [];
    return generateEvenSchedule(oppAmount, count, firstDate, frequency);
  }, [oppAmount, count, firstDate, frequency]);

  // Whichever mode is active is what we'll submit.
  const activeRows = mode === "even" ? evenRows : customRows;

  // When switching to custom mode with no rows yet (and no existing payments),
  // seed from the even-split so the user can tweak rather than start blank.
  useEffect(() => {
    if (mode === "custom" && customRows.length === 0 && evenRows.length > 0 && !hasExisting) {
      setCustomRows(evenRows);
    }
  }, [mode, evenRows, customRows.length, hasExisting]);

  const total = activeRows.reduce((s, r) => s + r.amount, 0);
  const diff = oppAmount != null ? round2(total - oppAmount) : 0;
  const balanced = oppAmount != null && Math.abs(diff) < 0.01;

  // Diff-save: when editing an existing schedule (hasExisting + custom
  // mode), dispatch per-row PUT / POST / DELETE so SF payment Ids
  // survive unmodified rows. Linked Sage invoices, audit history, and
  // any downstream system that pins to a payment Id stay intact.
  // Falls back to the bulk delete-all+recreate path for the new-schedule
  // case (no existing rows) and for the "even split" mode (which by
  // design regenerates the whole schedule).
  const isDiffSavePath = hasExisting && mode === "custom";

  const submit = async () => {
    if (!oppAmount) {
      setError("Set the opportunity Amount before creating a schedule.");
      return;
    }
    if (activeRows.length === 0) {
      setError("Add at least one payment.");
      return;
    }
    if (!balanced) {
      setError(
        `Payment total (${fmtMoneyFull(total, true)}) must equal opportunity amount (${fmtMoneyFull(oppAmount, true)}).`,
      );
      return;
    }
    setError(null);
    // Optimistic close: dismiss + toast immediately. Errors surface
    // through the toast and the next refetch reconciles cache.
    const toastId = `payment-schedule-${opportunityId}-${Date.now()}`;
    toast.loading("Saving payment schedule…", { id: toastId });
    onClose();
    try {
      if (isDiffSavePath) {
        // Group rows by (has existing SF id) and dispatch the right call.
        // Indices into customRows align 1:1 with existingPayments for
        // pre-populated rows; rows added via "Add payment" have no
        // matching entry — those are creates.
        const updates: { id: string; date: string; amount: number }[] = [];
        const creates: PaymentScheduleItem[] = [];
        for (let i = 0; i < customRows.length; i++) {
          const row = customRows[i];
          const sfId = existingIds[i];
          if (sfId) {
            // Existing row. Skip the PUT if nothing changed; saves an
            // API call per cycle.
            const orig = existingPayments[i];
            const dateChanged = row.scheduled_date !== (orig.npe01__Scheduled_Date__c ?? "");
            const amountChanged = Math.abs((orig.npe01__Payment_Amount__c ?? 0) - row.amount) >= 0.01;
            if (dateChanged || amountChanged) {
              updates.push({ id: sfId, date: row.scheduled_date, amount: row.amount });
            }
          } else {
            creates.push(row);
          }
        }
        // Existing rows the user removed (in customRows their index
        // would be missing). Existing indexes 0..N-1 are 1:1 with
        // customRows[0..N-1] until rows are removed; removed rows
        // collapse the index, so we need a different detection.
        const presentSfIds = new Set(
          customRows
            .map((_r, i) => existingIds[i])
            .filter((id): id is string => !!id),
        );
        const deletes = existingPayments
          .filter((p) => !presentSfIds.has(p.Id) && !p.npe01__Paid__c)
          .map((p) => p.Id);

        // Run deletes first (so a leaving row's amount frees the cap
        // before updates land). Then updates (parallel — safe). Then
        // creates SEQUENTIALLY — parallel inserts trigger the NPSP
        // [Payment] Payment Received Flow on the parent opp and race
        // for its lock (UNABLE_TO_LOCK_ROW).
        if (deletes.length > 0) {
          await Promise.all(deletes.map((id) => deleteOne.mutateAsync(id)));
        }
        if (updates.length > 0) {
          await Promise.all(
            updates.map((u) =>
              updateOne.mutateAsync({
                id: u.id,
                patch: {
                  npe01__Payment_Amount__c: u.amount,
                  npe01__Scheduled_Date__c: u.date,
                },
              }),
            ),
          );
        }
        for (const c of creates) {
          await createSingle.mutateAsync(c);
        }
      } else {
        await create.mutateAsync({
          payments: activeRows,
          delete_existing: deleteExisting,
        });
      }
      onSaved?.();
      toast.success("Payment schedule saved", { id: toastId });
    } catch (e) {
      const err = e as {
        response?: { data?: { detail?: string | { message?: string; error?: string } } };
        message?: string;
      };
      const detail = err.response?.data?.detail;
      const msg =
        typeof detail === "string"
          ? detail
          : detail?.message ?? detail?.error ?? err.message ?? "Failed to save schedule";
      toast.error(`Couldn't save schedule: ${msg}`, { id: toastId, duration: 8000 });
    }
  };

  const body = (
    <div className="flex-1 overflow-y-auto px-5 py-4">
          {prompt ? (
            <div className="mb-3 rounded border border-accent/30 bg-accent/5 px-3 py-2 text-[12.5px] text-ink-2">
              {prompt}
            </div>
          ) : null}
          {hasExisting ? (
            <div className="mb-3 flex items-center gap-2 rounded border border-border-strong bg-surface-2 px-3 py-2 text-[12px] text-ink-3">
              <span>
                Showing {existingPayments.length} existing payment{existingPayments.length === 1 ? "" : "s"}.
                {paidIds.size > 0 && ` ${paidIds.size} already paid (locked).`}
                {" "}Edit amounts or dates, add rows, then save to replace the schedule.
              </span>
            </div>
          ) : null}

          {/* Mode toggle */}
          <div className="mb-3 inline-flex items-center rounded-md border border-border-strong bg-surface p-0.5">
            <button
              type="button"
              onClick={() => setMode("even")}
              className={cn(
                "rounded px-2.5 py-1 text-[12px] font-medium",
                mode === "even" ? "bg-ink text-surface" : "text-ink-3 hover:text-ink",
              )}
            >
              Even split
            </button>
            <button
              type="button"
              onClick={() => setMode("custom")}
              className={cn(
                "rounded px-2.5 py-1 text-[12px] font-medium",
                mode === "custom" ? "bg-ink text-surface" : "text-ink-3 hover:text-ink",
              )}
            >
              Custom
            </button>
          </div>

          {mode === "even" ? (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Number of payments">
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={count}
                  onChange={(e) =>
                    setCount(Math.max(1, Math.min(120, Number(e.target.value) || 1)))
                  }
                  className={inputCls}
                />
              </Field>
              <Field label="First payment">
                <input
                  type="date"
                  value={firstDate}
                  onChange={(e) => setFirstDate(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <Field label="Frequency">
                <select
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as Frequency)}
                  className={inputCls}
                >
                  {(Object.keys(FREQ_LABELS) as Frequency[]).map((f) => (
                    <option key={f} value={f}>
                      {FREQ_LABELS[f]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}

          {/* Schedule preview / editor */}
          <div className="mt-3 max-h-[260px] overflow-y-auto rounded border border-border-strong">
            {activeRows.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12.5px] text-ink-3">
                Set the opportunity Amount and configure the schedule above.
              </div>
            ) : (
              <table className="w-full table-fixed border-collapse">
                {/* Explicit column widths so the date input + amount
                    input don't push the headers and totals off-axis
                    in custom mode. */}
                <colgroup>
                  <col className="w-[44px]" />
                  <col />
                  <col className="w-[120px]" />
                  {mode === "custom" ? <col className="w-[40px]" /> : null}
                </colgroup>
                {/* Sticky header so it stays visible when the body
                    scrolls past ~6 rows. */}
                <thead className="sticky top-0 bg-surface-2">
                  <tr>
                    <th className="border-b border-border-strong px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                      #
                    </th>
                    <th className="border-b border-border-strong px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                      Scheduled
                    </th>
                    <th className="border-b border-border-strong px-3 py-1.5 text-right text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                      Amount
                    </th>
                    {mode === "custom" ? (
                      <th className="border-b border-border-strong px-2 py-1.5" aria-label="Remove" />
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((r, i) => {
                    const sfId = existingIds[i];
                    const isPaid = sfId ? paidIds.has(sfId) : false;
                    return (
                      <tr
                        key={i}
                        className={cn(
                          "border-b border-border-strong last:border-b-0",
                          isPaid && "opacity-50",
                        )}
                      >
                        <td className="px-3 py-1.5 text-[12px] text-ink-3">
                          {i + 1}
                          {isPaid && (
                            <span className="ml-1.5 rounded bg-green/15 px-1 py-0.5 text-[10px] font-medium text-green">
                              paid
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5">
                          {mode === "even" || isPaid ? (
                            <span className="mono text-[12.5px] text-ink-2 tabular-nums">
                              {r.scheduled_date}
                            </span>
                          ) : (
                            <input
                              type="date"
                              value={r.scheduled_date}
                              onChange={(e) =>
                                updateCustomRow(setCustomRows, i, { scheduled_date: e.target.value })
                              }
                              className="w-full bg-transparent text-[12.5px] text-ink outline-none"
                            />
                          )}
                        </td>
                        <td className="mono px-3 py-1.5 text-right text-[12.5px] tabular-nums">
                          {mode === "even" || isPaid ? (
                            fmtMoneyFull(r.amount, true)
                          ) : (
                            <input
                              type="number"
                              step="0.01"
                              value={r.amount}
                              onChange={(e) =>
                                updateCustomRow(setCustomRows, i, {
                                  amount: Number(e.target.value) || 0,
                                })
                              }
                              className="w-full bg-transparent text-right text-[12.5px] tabular-nums outline-none"
                            />
                          )}
                        </td>
                        {mode === "custom" ? (
                          <td className="px-2 py-1.5">
                            {!isPaid && (
                              <button
                                type="button"
                                onClick={() =>
                                  setCustomRows((rows) => rows.filter((_, idx) => idx !== i))
                                }
                                className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-red"
                                aria-label="Remove"
                              >
                                <Trash2 size={11} />
                              </button>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {mode === "custom" ? (
            <button
              type="button"
              onClick={() =>
                setCustomRows((rows) => [
                  ...rows,
                  { amount: 0, scheduled_date: rows.at(-1)?.scheduled_date ?? todayIso() },
                ])
              }
              className="mt-2 inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2"
            >
              <Plus size={11} /> Add payment
            </button>
          ) : null}

          {/* Total summary */}
          <div className="mt-3 flex items-center justify-between rounded border border-border-strong bg-surface-2 px-3 py-2 text-[12.5px]">
            <span className="text-ink-3">
              {activeRows.length} payment{activeRows.length === 1 ? "" : "s"} ·
              <span className={cn("ml-1 mono tabular-nums", balanced ? "text-ink" : "text-red")}>
                {fmtMoneyFull(total, true)}
              </span>
              <span className="ml-1 text-ink-3"> of {oppAmount != null ? fmtMoneyFull(oppAmount, true) : "—"}</span>
            </span>
            {!balanced && oppAmount != null ? (
              <span className="text-[11.5px] text-red">
                {diff > 0 ? `Over by ${fmtMoneyFull(diff, true)}` : `Short by ${fmtMoneyFull(Math.abs(diff), true)}`}
              </span>
            ) : balanced ? (
              <span className="text-[11.5px] text-green">Balanced</span>
            ) : null}
          </div>

          {error ? (
            <div className="mt-2 rounded border border-red/40 bg-red/5 px-3 py-2 text-[12px] text-red">
              {error}
            </div>
          ) : null}
    </div>
  );

  const actions = (
    <footer className="flex items-center justify-end gap-2 border-t border-border-strong bg-surface-2/40 px-5 py-3">
      <button
        type="button"
        onClick={onClose}
        className="rounded border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-2"
      >
        {inline ? "Back" : "Cancel"}
      </button>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!balanced || activeRows.length === 0 || create.isPending}
        className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {create.isPending
          ? "Saving…"
          : hasExisting
            ? `Save ${activeRows.length} payment${activeRows.length === 1 ? "" : "s"}`
            : `Create ${activeRows.length} payment${activeRows.length === 1 ? "" : "s"}`}
      </button>
    </footer>
  );

  // Inline mode: skip backdrop + card. Caller drops {body}{actions}
  // straight into its own dialog body, so clicks bubble naturally
  // and there's no nested-modal click-through trap.
  if (inline) {
    return (
      <>
        {body}
        {actions}
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-border-strong px-5 py-3">
          <h2 className="text-[15px] font-semibold text-ink">
            {hasExisting ? "Review payment schedule" : "Create payment schedule"}
          </h2>
          <button
            onClick={onClose}
            className="text-ink-3 hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        {body}
        {actions}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function generateEvenSchedule(
  total: number,
  count: number,
  startIso: string,
  frequency: Frequency,
): PaymentScheduleItem[] {
  const monthStep = FREQ_MONTHS[frequency];
  const start = new Date(startIso + "T00:00:00");
  if (Number.isNaN(start.getTime())) return [];
  // Per-payment: round to cents; put the rounding remainder on the first
  // payment so the total still equals `total` exactly (avoids the
  // backend rejecting the schedule for a sub-cent mismatch).
  const each = Math.floor((total / count) * 100) / 100;
  const remainder = round2(total - each * count);
  const rows: PaymentScheduleItem[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + i * monthStep);
    rows.push({
      amount: i === 0 ? round2(each + remainder) : each,
      scheduled_date: d.toISOString().slice(0, 10),
    });
  }
  return rows;
}

function updateCustomRow(
  setter: React.Dispatch<React.SetStateAction<PaymentScheduleItem[]>>,
  index: number,
  patch: Partial<PaymentScheduleItem>,
): void {
  setter((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}

const inputCls =
  "h-7 rounded border border-border-strong bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent";
