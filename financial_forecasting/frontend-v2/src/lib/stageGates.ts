/**
 * Stage-gate rules — playbook checklists that must be completed
 * before certain stage transitions are allowed.
 *
 * Each gate is a pure function of (fromStage, toStage). The
 * StageGateDialog reads the returned spec and renders the matching
 * checklist. If `getStageGate` returns null, the transition is
 * unrestricted and the standard mutation fires directly.
 */
import { STAGE_RANK } from "@/lib/stages";

/** Which checklist items the gate requires. */
export interface StageGateSpec {
  id:
    | "ask-in-progress-exit"
    | "proposal-to-contracting"
    | "contracting-to-collecting"
    | "withdrawn"
    | "closed-lost";
  title: string;
  description: string;
  /** Confirm + edit Close Date. */
  confirmCloseDate?: boolean;
  /** Confirm + edit Amount. */
  confirmAmount?: boolean;
  /** Confirm + edit Probability (writes both Probability and the
   *  Manager_Probability_Override__c custom field). */
  confirmProbability?: boolean;
  /** Show the payment-schedule builder. */
  confirmPaymentSchedule?: boolean;
  /** File picker tied to a filename hint (e.g. "proposal" /
   *  "contract"). The user must have at least one matching file
   *  attached to the opp before the gate's primary button enables. */
  fileAttachment?: {
    label: string;
    hint: string;
  };
  /** Free-text close reason → npsp__Closed_Lost_Reason__c. */
  closeReason?: boolean;
}

const PURSUIT_CHECKLIST_BODY: Pick<
  StageGateSpec,
  "confirmCloseDate" | "confirmAmount" | "confirmProbability" | "confirmPaymentSchedule" | "fileAttachment"
> = {
  confirmCloseDate: true,
  confirmAmount: true,
  confirmProbability: true,
  confirmPaymentSchedule: true,
  fileAttachment: { label: "Proposal", hint: "proposal" },
};

export function getStageGate(fromStage: string | null | undefined, toStage: string): StageGateSpec | null {
  if (!fromStage) return null;

  const fromRank = STAGE_RANK[fromStage] ?? -1;

  // Withdrawn / Closed Lost — close-reason required from any stage.
  if (toStage === "Withdrawn") {
    return {
      id: "withdrawn",
      title: "Mark opportunity as withdrawn",
      description: "Briefly note why this opportunity is being withdrawn. This goes into the SF \"Closed Lost Reason\" field so it's searchable for trend analysis.",
      closeReason: true,
    };
  }
  if (toStage === "Closed Lost") {
    return {
      id: "closed-lost",
      title: "Mark opportunity as closed lost",
      description: "Capture the loss reason for trend analysis. This goes into the SF \"Closed Lost Reason\" field.",
      closeReason: true,
    };
  }

  // Contracting → Collecting / In Effect — contract attachment.
  if (fromStage === "Contracting" && toStage === "Collecting / In Effect") {
    return {
      id: "contracting-to-collecting",
      title: "Confirm signed contract before moving to Collecting / In Effect",
      description: "Attach the executed contract so it's discoverable from the opportunity record. The payment schedule should already be in place from the earlier gate — surfaced here so you can verify it before delivery starts.",
      fileAttachment: { label: "Signed contract", hint: "contract" },
      // Backend's _validate_stage_change_logic enforces a payment
      // schedule exists with matching total before this transition.
      // Surfacing it here lets the user verify in one place instead
      // of failing the gate, fixing the schedule, then retrying.
      confirmPaymentSchedule: true,
    };
  }

  // Proposal Submitted → Contracting — full pursuit checklist.
  if (fromStage === "Proposal Submitted" && toStage === "Contracting") {
    return {
      id: "proposal-to-contracting",
      title: "Confirm proposal details before moving to Contracting",
      description: "Verify close date, amount, probability, and payment schedule reflect what's being contracted. Attach the latest proposal for the file record.",
      ...PURSUIT_CHECKLIST_BODY,
    };
  }

  // Ask in Progress → anything later in the funnel — full pursuit checklist.
  if (fromStage === "Ask in Progress" && fromRank < (STAGE_RANK[toStage] ?? -1)) {
    return {
      id: "ask-in-progress-exit",
      title: "Confirm proposal details before advancing past Ask in Progress",
      description: "An ask is becoming a real deal. Verify the close date, amount, probability, and payment schedule are accurate, and attach the proposal.",
      ...PURSUIT_CHECKLIST_BODY,
    };
  }

  return null;
}
