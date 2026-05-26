import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { OpportunityFilesPicker } from "@/components/OpportunityFilesPicker";
import { PaymentScheduleBuilder } from "@/components/PaymentScheduleBuilder";
import { useUpdateOpportunity, useUpdateOpportunityStage } from "@/services/opportunities";
import {
  useCreateSinglePayment,
  useDeletePayment,
  useOpportunityPayments,
  useUpdatePayment,
  type SfPayment,
} from "@/services/payments";
import { fmtMoney, fmtMoneyFull } from "@/lib/format";
import type { StageGateSpec } from "@/lib/stageGates";
import { cn } from "@/lib/utils";
import type { SfOpportunity } from "@/types/salesforce";

/**
 * Stage-gate modal — fires before a forbidden stage transition,
 * forces the user to complete a checklist, then runs the field
 * updates + the stage change as a single flow.
 *
 * Field updates use existing hooks (useUpdateOpportunity for the
 * non-stage fields, useUpdateOpportunityStage for the stage change
 * itself so the awards-auto-create handler still fires).
 *
 * On cancel: no SF writes. On confirm: each field is patched in
 * sequence (fail fast on the first error), then the stage change.
 */
export function StageGateDialog({
  spec,
  opp,
  toStage,
  onClose,
  onCompleted,
}: {
  spec: StageGateSpec;
  opp: SfOpportunity;
  toStage: string;
  onClose: () => void;
  onCompleted?: () => void;
}) {
  const updateOpp = useUpdateOpportunity();
  const updateStage = useUpdateOpportunityStage();
  const paymentsQ = useOpportunityPayments(opp.Id);

  // Field state — seeded from the current opp values.
  const [closeDate, setCloseDate] = useState<string>(opp.CloseDate ?? "");
  const [amountStr, setAmountStr] = useState<string>(opp.Amount != null ? String(opp.Amount) : "");
  const [probabilityStr, setProbabilityStr] = useState<string>(
    opp.Manager_Probability_Override__c != null
      ? String(opp.Manager_Probability_Override__c)
      : opp.Probability != null
        ? String(opp.Probability)
        : "",
  );
  const [closeReason, setCloseReason] = useState<string>("");
  const [fileSatisfied, setFileSatisfied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [scheduleBuilderOpen, setScheduleBuilderOpen] = useState(false);

  // Payment schedule "satisfied" — at least one payment whose total
  // matches the opp amount (mirrors the backend check in
  // _validate_stage_change_logic). We just surface the current state;
  // editing the schedule itself happens via the existing
  // PaymentScheduleBuilder, opened in-place below.
  const payments = paymentsQ.data ?? [];
  const paymentTotal = payments.reduce((s, p) => s + (p.npe01__Payment_Amount__c ?? 0), 0);
  const amountNum = Number(amountStr);
  const paymentScheduleSatisfied =
    payments.length > 0 && Number.isFinite(amountNum) && Math.abs(paymentTotal - amountNum) < 0.01;

  // Close on Esc. Skip while the nested PaymentScheduleBuilder is open
  // — that modal owns Esc until it closes, otherwise one keypress
  // collapses both layers and loses the user's in-progress schedule.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting && !scheduleBuilderOpen) onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose, submitting, scheduleBuilderOpen]);

  // Validation — what's required for the primary button to enable.
  const errors: string[] = [];
  if (spec.confirmCloseDate && !closeDate) errors.push("Close date is required");
  if (spec.confirmAmount && (!amountStr || !Number.isFinite(amountNum) || amountNum <= 0))
    errors.push("Amount must be > 0");
  if (spec.confirmProbability) {
    const p = Number(probabilityStr);
    if (!Number.isFinite(p) || p < 0 || p > 100) errors.push("Probability must be 0–100");
  }
  if (spec.confirmPaymentSchedule && !paymentScheduleSatisfied) {
    errors.push(
      payments.length === 0
        ? "Payment schedule must exist for this opportunity"
        : `Payment schedule total (${fmtMoney(paymentTotal)}) must match amount (${fmtMoney(amountNum)})`,
    );
  }
  if (spec.fileAttachment && !fileSatisfied) errors.push(`A ${spec.fileAttachment.label.toLowerCase()} must be attached`);
  if (spec.closeReason && !closeReason.trim()) errors.push("Close reason is required");

  const canSubmit = errors.length === 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // 1. Patch any field deltas via the generic Opportunity PUT.
      const patch: Record<string, unknown> = {};
      if (spec.confirmCloseDate && closeDate !== opp.CloseDate) patch.CloseDate = closeDate;
      if (spec.confirmAmount && amountNum !== opp.Amount) patch.Amount = amountNum;
      if (spec.confirmProbability) {
        const p = Number(probabilityStr);
        // Mirror SF's UI: write Probability AND the manager override
        // together so the two fields stay in sync. Same pattern as
        // the inline Mgr Prob edit.
        patch.Manager_Probability_Override__c = p;
        patch.Probability = p;
      }
      if (spec.closeReason) {
        patch.npsp__Closed_Lost_Reason__c = closeReason.trim();
      }
      if (Object.keys(patch).length > 0) {
        await updateOpp.mutateAsync({ id: opp.Id, patch });
      }

      // 2. Run the stage change. Goes through the validate +
      // awards-auto-create path on the backend.
      await updateStage.mutateAsync({ id: opp.Id, newStage: toStage });

      toast.success(`Moved to ${toStage}`);
      onCompleted?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Stage gate failed: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        // Only dismiss if the user clicked the backdrop itself, not
        // bubble events from interactive children. The previous
        // bubble-through here was closing the gate whenever a click
        // landed anywhere in a nested editor.
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-border-strong px-5 py-3">
          <div className="flex min-w-0 items-start gap-2">
            {scheduleBuilderOpen ? (
              <button
                type="button"
                onClick={() => setScheduleBuilderOpen(false)}
                className="mt-0.5 flex-shrink-0 text-ink-3 hover:text-ink-2"
                aria-label="Back to stage gate"
              >
                <ArrowLeft size={16} />
              </button>
            ) : null}
            <div className="min-w-0">
              <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                {opp.StageName} → {toStage}
              </div>
              <h2 className="mt-0.5 text-[15px] font-semibold text-ink">
                {scheduleBuilderOpen ? "Payment schedule" : spec.title}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex-shrink-0 text-ink-3 hover:text-ink-2 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        {scheduleBuilderOpen ? (
          <PaymentScheduleBuilder
            inline
            opportunityId={opp.Id}
            oppAmount={Number.isFinite(amountNum) && amountNum > 0 ? amountNum : opp.Amount ?? null}
            existingPayments={payments}
            initialFirstDate={closeDate || null}
            prompt={
              payments.length === 0
                ? `Define the expected payment schedule for this ${spec.title.toLowerCase()}.`
                : null
            }
            onClose={() => setScheduleBuilderOpen(false)}
            onSaved={() => {
              // useOpportunityPayments invalidation happens inside the
              // builder's hooks; the parent gate's satisfied state
              // recomputes on the next refetch. Toast confirms the save.
              toast.success("Payment schedule saved");
            }}
          />
        ) : (
          <>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-[12.5px] leading-relaxed text-ink-2">{spec.description}</p>

          <div className="flex flex-col gap-4">
            {spec.confirmCloseDate || spec.confirmAmount || spec.confirmProbability ? (
              <div className="grid grid-cols-3 gap-3">
                {spec.confirmCloseDate ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Close date</span>
                    <input
                      type="date"
                      value={closeDate}
                      onChange={(e) => setCloseDate(e.target.value)}
                      className="h-8 rounded border border-border-strong bg-surface px-2 text-[12.5px] outline-none focus:border-accent"
                    />
                  </label>
                ) : null}
                {spec.confirmAmount ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Amount ($)</span>
                    <input
                      type="number"
                      value={amountStr}
                      onChange={(e) => setAmountStr(e.target.value)}
                      placeholder="0"
                      className="h-8 rounded border border-border-strong bg-surface px-2 text-[12.5px] outline-none focus:border-accent"
                    />
                  </label>
                ) : null}
                {spec.confirmProbability ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Probability (%)</span>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={probabilityStr}
                      onChange={(e) => setProbabilityStr(e.target.value)}
                      className="h-8 rounded border border-border-strong bg-surface px-2 text-[12.5px] outline-none focus:border-accent"
                    />
                  </label>
                ) : null}
              </div>
            ) : null}

            {spec.confirmPaymentSchedule ? (
              <InlinePaymentScheduleEditor
                opportunityId={opp.Id}
                oppAmount={Number.isFinite(amountNum) && amountNum > 0 ? amountNum : opp.Amount ?? null}
                payments={payments}
                onRequestFullBuilder={async () => {
                  if (
                    spec.confirmAmount &&
                    Number.isFinite(amountNum) &&
                    amountNum > 0 &&
                    amountNum !== opp.Amount
                  ) {
                    try {
                      await updateOpp.mutateAsync({ id: opp.Id, patch: { Amount: amountNum } });
                    } catch (e) {
                      toast.error(`Couldn't save Amount: ${e instanceof Error ? e.message : String(e)}`);
                      return;
                    }
                  }
                  setScheduleBuilderOpen(true);
                }}
              />
            ) : null}

            {spec.fileAttachment ? (
              <OpportunityFilesPicker
                opportunityId={opp.Id}
                label={spec.fileAttachment.label}
                filenameHint={spec.fileAttachment.hint}
                onSatisfiedChange={setFileSatisfied}
              />
            ) : null}

            {spec.closeReason ? (
              <label className="flex flex-col gap-1">
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Close reason</span>
                <textarea
                  value={closeReason}
                  onChange={(e) => setCloseReason(e.target.value)}
                  placeholder="Brief explanation of why this opportunity is being closed…"
                  rows={4}
                  className="resize-y rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
                />
              </label>
            ) : null}
          </div>

          {errors.length > 0 ? (
            <ul className="mt-4 list-disc rounded border border-amber/30 bg-amber-soft px-5 py-2 text-[11.5px] text-amber-700">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-strong bg-surface-2/40 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="text-[12.5px] text-ink-3 hover:text-ink-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="inline-flex h-8 items-center gap-1.5 rounded bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : null}
            Move to {toStage}
          </button>
        </footer>
          </>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Inline schedule editor — lives directly in the gate body so an RM
// can scan + tweak dates and amounts in one view without opening a
// second dialog. The "Edit in builder" affordance still launches the
// full PaymentScheduleBuilder for even-split presets or bulk creates.
// ──────────────────────────────────────────────────────────────────────

interface InlineRow {
  /** Present when this row came from SF; absent for newly added rows. */
  sfId?: string;
  scheduled_date: string;
  amount: number;
  paid: boolean;
}

function paymentsToRows(payments: SfPayment[]): InlineRow[] {
  return payments.map((p) => ({
    sfId: p.Id,
    scheduled_date: p.npe01__Scheduled_Date__c ?? "",
    amount: p.npe01__Payment_Amount__c ?? 0,
    paid: Boolean(p.npe01__Paid__c),
  }));
}

function InlinePaymentScheduleEditor({
  opportunityId,
  oppAmount,
  payments,
  onRequestFullBuilder,
}: {
  opportunityId: string;
  oppAmount: number | null;
  payments: SfPayment[];
  onRequestFullBuilder: () => void;
}) {
  const updatePayment = useUpdatePayment(opportunityId);
  const deletePayment = useDeletePayment(opportunityId);
  const createSingle = useCreateSinglePayment(opportunityId);

  // Local mirror of the existing payment list. Edits here don't hit
  // SF until the user clicks Save changes — gives them room to drag
  // amounts around in the inline editor before committing.
  const [rows, setRows] = useState<InlineRow[]>(() => paymentsToRows(payments));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed from props when the upstream list refetches (e.g. after a
  // schedule was just created via the full builder).
  useEffect(() => {
    setRows(paymentsToRows(payments));
    setSaveError(null);
  }, [payments]);

  const total = useMemo(
    () => rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0),
    [rows],
  );
  const diff = oppAmount != null ? Math.round((total - oppAmount) * 100) / 100 : 0;
  const balanced = oppAmount != null && Math.abs(diff) < 0.01;

  // Dirty diff vs. SF: row count differs, OR any non-paid row's date
  // / amount has changed from its SF original.
  const dirty = useMemo(() => {
    const originals = paymentsToRows(payments);
    if (originals.length !== rows.length) return true;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const orig = originals.find((o) => o.sfId && o.sfId === r.sfId);
      if (!r.sfId) return true; // new row
      if (!orig) return true; // row's sfId no longer matches anything
      if (orig.scheduled_date !== r.scheduled_date) return true;
      if (Math.abs(orig.amount - r.amount) >= 0.01) return true;
    }
    return false;
  }, [rows, payments]);

  const canSave = dirty && balanced && rows.length > 0 && !saving;

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        scheduled_date: prev.at(-1)?.scheduled_date ?? new Date().toISOString().slice(0, 10),
        amount: 0,
        paid: false,
      },
    ]);
  };

  const removeRow = (i: number) => {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  };

  const updateRow = (i: number, patch: Partial<InlineRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const originalIds = new Set(
        payments.filter((p) => !p.npe01__Paid__c).map((p) => p.Id),
      );
      const presentIds = new Set(
        rows.map((r) => r.sfId).filter((id): id is string => Boolean(id)),
      );

      const toDelete = [...originalIds].filter((id) => !presentIds.has(id));
      const toUpdate: { id: string; date: string; amount: number }[] = [];
      const toCreate: { scheduled_date: string; amount: number }[] = [];

      for (const r of rows) {
        if (r.paid) continue; // Don't touch paid rows.
        if (r.sfId) {
          const orig = payments.find((p) => p.Id === r.sfId);
          if (!orig) continue;
          const dateChanged = (orig.npe01__Scheduled_Date__c ?? "") !== r.scheduled_date;
          const amountChanged = Math.abs((orig.npe01__Payment_Amount__c ?? 0) - r.amount) >= 0.01;
          if (dateChanged || amountChanged) {
            toUpdate.push({ id: r.sfId, date: r.scheduled_date, amount: r.amount });
          }
        } else {
          toCreate.push({ scheduled_date: r.scheduled_date, amount: r.amount });
        }
      }

      if (toDelete.length > 0) {
        await Promise.all(toDelete.map((id) => deletePayment.mutateAsync(id)));
      }
      await Promise.all([
        ...toUpdate.map((u) =>
          updatePayment.mutateAsync({
            id: u.id,
            patch: {
              npe01__Payment_Amount__c: u.amount,
              npe01__Scheduled_Date__c: u.date,
            },
          }),
        ),
        ...toCreate.map((c) => createSingle.mutateAsync(c)),
      ]);
      toast.success("Payment schedule saved");
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
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded border border-border-strong bg-surface-2/40 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          Payment schedule
        </span>
        <span
          className={cn(
            "text-[11px] mono tabular-nums",
            balanced ? "text-green" : "text-amber",
          )}
        >
          {rows.length === 0
            ? "No payments scheduled"
            : balanced
              ? `✓ ${rows.length} payment${rows.length === 1 ? "" : "s"} totaling ${fmtMoneyFull(total, true)}`
              : `${fmtMoneyFull(total, true)} of ${oppAmount != null ? fmtMoneyFull(oppAmount, true) : "—"}`}
        </span>
      </div>

      {rows.length > 0 ? (
        <table className="mt-2 w-full table-fixed border-collapse text-[12.5px]">
          <colgroup>
            <col className="w-[28px]" />
            <col />
            <col className="w-[110px]" />
            <col className="w-[28px]" />
          </colgroup>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.sfId ?? `new-${i}`} className={cn(r.paid && "opacity-50")}>
                <td className="px-1 py-1 text-[11px] text-ink-3">{i + 1}</td>
                <td className="px-1 py-1">
                  {r.paid ? (
                    <span className="mono text-ink-2 tabular-nums">{r.scheduled_date}</span>
                  ) : (
                    <input
                      type="date"
                      value={r.scheduled_date}
                      onChange={(e) => updateRow(i, { scheduled_date: e.target.value })}
                      className="w-full rounded border border-border-strong bg-surface px-1.5 py-0.5 text-[12px] outline-none focus:border-accent"
                    />
                  )}
                </td>
                <td className="px-1 py-1 text-right">
                  {r.paid ? (
                    <span className="mono text-ink-2 tabular-nums">{fmtMoneyFull(r.amount, true)}</span>
                  ) : (
                    <input
                      type="number"
                      step="0.01"
                      value={r.amount}
                      onChange={(e) => updateRow(i, { amount: Number(e.target.value) || 0 })}
                      className="w-full rounded border border-border-strong bg-surface px-1.5 py-0.5 text-right text-[12px] tabular-nums outline-none focus:border-accent"
                    />
                  )}
                </td>
                <td className="px-1 py-1 text-right">
                  {r.paid ? (
                    <span className="text-[9px] uppercase tracking-wider text-green">paid</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="rounded p-0.5 text-ink-3 hover:bg-surface hover:text-red"
                      aria-label="Remove payment"
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {!balanced && oppAmount != null && rows.length > 0 ? (
        <p className="mt-2 text-[11px] text-red">
          {diff > 0
            ? `Over by ${fmtMoneyFull(diff, true)} — adjust an amount or remove a row.`
            : `Short by ${fmtMoneyFull(Math.abs(diff), true)} — adjust an amount or add a row.`}
        </p>
      ) : null}

      {saveError ? (
        <p className="mt-2 rounded border border-red/40 bg-red/5 px-2 py-1 text-[11px] text-red">
          {saveError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {rows.length > 0 ? (
            <button
              type="button"
              onClick={addRow}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
            >
              <Plus size={11} /> Add payment
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRequestFullBuilder}
            disabled={saving || oppAmount == null || oppAmount <= 0}
            className="text-[11px] text-ink-3 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            title={
              oppAmount == null || oppAmount <= 0
                ? "Set the Amount above first — the schedule total must match it"
                : rows.length === 0
                  ? "Open the full builder to create the schedule"
                  : "Open the full builder for even-split / advanced edits"
            }
          >
            {rows.length === 0 ? "Create schedule…" : "Open in full builder…"}
          </button>
        </div>
        {dirty ? (
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="inline-flex h-7 items-center gap-1.5 rounded bg-ink px-2.5 text-[11.5px] font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            Save changes
          </button>
        ) : null}
      </div>
    </div>
  );
}
