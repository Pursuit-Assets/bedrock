import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { OpportunityFilesPicker } from "@/components/OpportunityFilesPicker";
import { useUpdateOpportunity, useUpdateOpportunityStage } from "@/services/opportunities";
import { useOpportunityPayments } from "@/services/payments";
import { fmtMoney } from "@/lib/format";
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

  // Close on Esc.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose, submitting]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !submitting && onClose()}>
      <div
        className="flex max-h-[90vh] w-full max-w-[680px] flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-border-strong px-5 py-3">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              {opp.StageName} → {toStage}
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold text-ink">{spec.title}</h2>
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
              <div className="rounded border border-border-strong bg-surface-2/40 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Payment schedule</span>
                  <span className={cn(
                    "text-[11px]",
                    paymentScheduleSatisfied ? "text-green" : "text-amber",
                  )}>
                    {paymentScheduleSatisfied
                      ? `✓ ${payments.length} payment${payments.length === 1 ? "" : "s"} totaling ${fmtMoney(paymentTotal)}`
                      : payments.length === 0
                        ? "No payments scheduled yet"
                        : `${fmtMoney(paymentTotal)} of ${fmtMoney(amountNum)} scheduled`}
                  </span>
                </div>
                <p className="mt-1 text-[11.5px] text-ink-3">
                  Use the Payments page or this opportunity's row-expand panel to add/edit individual payments,
                  then return here.
                </p>
              </div>
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
      </div>
    </div>
  );
}
