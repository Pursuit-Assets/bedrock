import { useCallback, useState } from "react";

import { getStageGate, type StageGateSpec } from "@/lib/stageGates";
import { useUpdateOpportunityStage } from "@/services/opportunities";
import type { SfOpportunity } from "@/types/salesforce";

interface PendingGate {
  opp: SfOpportunity;
  toStage: string;
  spec: StageGateSpec;
}

/**
 * Wraps a stage-change request with the playbook's gate checklist.
 *
 *   const { request, pending, dismiss } = useStageChangeGate();
 *   // In your inline-edit save: request(opp, newStage)
 *   // In the render tree: {pending && <StageGateDialog spec={pending.spec} ... />}
 *
 * When `getStageGate(from, to)` returns null, this hook just fires
 * the underlying `useUpdateOpportunityStage` mutation directly —
 * unrestricted transitions don't pay the dialog overhead.
 *
 * The dialog itself owns field updates + the stage change call
 * (StageGateDialog imports useUpdateOpportunityStage internally).
 * This hook is just the open / close state machine.
 */
export function useStageChangeGate() {
  const [pending, setPending] = useState<PendingGate | null>(null);
  const updateStage = useUpdateOpportunityStage();

  const request = useCallback(
    async (opp: SfOpportunity, newStage: string) => {
      const fromStage = opp.StageName ?? "";
      const spec = getStageGate(fromStage, newStage);
      if (!spec) {
        // No gate — fire the mutation directly. Existing optimistic
        // update + awards handshake apply.
        await updateStage.mutateAsync({ id: opp.Id, newStage });
        return;
      }
      setPending({ opp, toStage: newStage, spec });
    },
    [updateStage],
  );

  const dismiss = useCallback(() => setPending(null), []);

  return { pending, request, dismiss };
}
