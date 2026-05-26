import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { SfPayment } from "@/services/payments";
import type { SfOpportunity } from "@/types/salesforce";

interface PendingScheduleGate {
  opp: SfOpportunity;
  /** The probability the user is trying to set, captured so the
   *  caller can re-issue the write once the schedule is in place. */
  nextProbability: number;
}

/**
 * Gate the playbook rule: probability cannot move from 0 → >0 unless
 * a payment schedule exists on the opportunity. Used by the inline
 * probability editors on Pipeline / Portfolio / Payments.
 *
 *   const probGate = useProbabilityScheduleGate();
 *   await probGate.request(opp, parsed);
 *   // ...then run your existing patch
 *
 * Behavior:
 * - If prev > 0 or next <= 0: resolves immediately (no gate).
 * - Otherwise, fetches payments for the opp. If ≥1 exists: resolves
 *   immediately. If none: opens the PaymentScheduleBuilder mounted by
 *   the caller and returns a Promise that resolves on save, rejects on
 *   dismiss — same shape as useStageChangeGate so an InlineSelect's
 *   optimistic display rolls back on cancel.
 */
export function useProbabilityScheduleGate() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingScheduleGate | null>(null);
  const resolverRef = useRef<{
    resolve: () => void;
    reject: (err: Error) => void;
  } | null>(null);

  const request = useCallback(
    async (opp: SfOpportunity, nextProbability: number | null): Promise<void> => {
      const prev = opp.Manager_Probability_Override__c ?? opp.Probability ?? 0;
      // No gate when leaving probability at 0 or when it was already
      // raised on a prior edit. The 0 → >0 transition is the trigger.
      if (nextProbability == null || nextProbability <= 0 || prev > 0) return;

      // Fetch (or read from cache) the payment list for this opp. The
      // backend endpoint is the same one PaymentScheduleBuilder polls
      // after save, so the cache stays consistent.
      const payments = await qc.fetchQuery<SfPayment[]>({
        queryKey: ["opp-payments", opp.Id],
        queryFn: async () => {
          const { data } = await api.get<SfPayment[]>(
            `/api/salesforce/opportunities/${encodeURIComponent(opp.Id)}/payments`,
          );
          return data ?? [];
        },
        staleTime: 60_000,
      });
      if (payments.length > 0) return;

      // No schedule → open the builder and wait for the outcome.
      return new Promise<void>((resolve, reject) => {
        resolverRef.current = { resolve, reject };
        setPending({ opp, nextProbability });
      });
    },
    [qc],
  );

  const complete = useCallback(() => {
    resolverRef.current?.resolve();
    resolverRef.current = null;
    setPending(null);
  }, []);

  const dismiss = useCallback(() => {
    resolverRef.current?.reject(new Error("Payment schedule required for probability > 0"));
    resolverRef.current = null;
    setPending(null);
  }, []);

  return { pending, request, dismiss, complete };
}
