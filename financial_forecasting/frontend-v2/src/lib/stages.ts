/**
 * Stage helpers — no display mapping (StageChip shows the literal SF
 * StageName). For categorization, "won" is defined as **stages that
 * produce a bedrock.award row**. That's the same predicate used in
 * services/awards_service.py (ELIGIBLE_STAGES_BY_RECORD_TYPE), unioned
 * across all eligible record types so we can run the check in the
 * frontend without a per-row API call.
 *
 * Why not just `IsClosed && IsWon`? Pursuit's SF picklist has stages
 * like "Collecting / In Effect" and "Closed / Did not Fulfill" that
 * **do** produce awards but don't necessarily flip SF's `IsWon` flag
 * (or are even closed yet). The award-eligibility set is the single
 * source of truth for "this opp counts as won."
 */

import type { SfOpportunity } from "@/types/salesforce";

/**
 * Stages that produce a bedrock.award row (from
 * `services/awards_service.py:ELIGIBLE_STAGES_BY_RECORD_TYPE`, unioned).
 * Keep in sync if the backend list changes.
 */
export const AWARD_ELIGIBLE_STAGES: ReadonlySet<string> = new Set([
  // Philanthropy
  "closed-won",
  "Closed Won",
  "Closed / Completed",
  "Closed / Fulfilled",
  "Collecting / In Effect",
  "Collecting",
  "In Effect",
  "Closed / Did not Fulfill",
  // PBC
  "Closed / Full-Time or Successful Conversion",
  "Closed / Temporary Hire",
  "Closed / Contract or Agreement But No Fellows Hired",
  "Closed / Sourcing",
  // Debt / Equity, Other Fee For Service — already covered above
]);

export function isWon(o: Pick<SfOpportunity, "StageName">): boolean {
  return !!o.StageName && AWARD_ELIGIBLE_STAGES.has(o.StageName);
}

/**
 * Stage names that semantically mean "closed but didn't produce an
 * award." We can't rely solely on SF's IsClosed flag because some
 * picklist values (e.g. "Closed / Unknown") have IsClosed=false
 * set on the picklist in SF — so they'd otherwise be classified as
 * Open Pipeline even though the name clearly says otherwise. Include
 * any new flagged-closed-but-IsClosed=false stage here as Pursuit's
 * picklist evolves.
 */
const CLOSED_NOT_WON_STAGE_NAMES: ReadonlySet<string> = new Set([
  // Stages with IsClosed=true on the SF picklist — included for
  // belt-and-suspenders so the predicate stays correct even if the
  // flag flips.
  "Closed Lost",
  "Closed / Did not Fulfill",
  "Closed / Contract or Agreement But No Fellows Hired",
  "Withdrawn",
]);

/**
 * "Closed / Unknown" is the bug-prone offender — SF picklist sets
 * IsClosed=false on it, and the org has used a couple of spacing
 * variants over the years. Match every plausible form so we don't
 * play whack-a-mole as new variants surface.
 *
 * Matches: "Close Unknown", "Closed Unknown", "Closed/Unknown",
 *          "Closed / Unknown", "Close/Unknown", "Close / Unknown".
 * Does NOT match: "Unknown", "Closed Won", etc.
 */
const CLOSE_UNKNOWN_PATTERN = /^close[d]?\s*[/\s]\s*unknown$/i;

function nameImpliesClosed(name: string | null | undefined): boolean {
  if (!name) return false;
  if (CLOSED_NOT_WON_STAGE_NAMES.has(name)) return true;
  if (CLOSE_UNKNOWN_PATTERN.test(name)) return true;
  return false;
}

export function isLost(o: Pick<SfOpportunity, "StageName" | "IsClosed">): boolean {
  if (isWon(o)) return false;
  // Either SF's IsClosed flag is true, OR the stage name itself reads as
  // closed (covers picklist values where IsClosed wasn't set in SF).
  return o.IsClosed === true || nameImpliesClosed(o.StageName);
}

export function isOpen(
  o: Pick<SfOpportunity, "StageName" | "IsClosed">,
): boolean {
  return !isWon(o) && !isLost(o);
}

export type StageStatus = "open" | "won" | "lost";

export function stageStatus(
  o: Pick<SfOpportunity, "StageName" | "IsClosed">,
): StageStatus {
  if (isWon(o)) return "won";
  if (isLost(o)) return "lost";
  return "open";
}

/**
 * Real SF picklist values — used by edit dropdowns. Order tracks the
 * funnel position. **These are the literal SF strings**, not bucket
 * labels. If SF adds a new stage, append it here (or fetch the picklist
 * from the API once we wire that up).
 */
export const SF_STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "New Lead", label: "New Lead" },
  { value: "Identified", label: "Identified" },
  { value: "Lead Gen", label: "Lead Gen" },
  { value: "Qualifying", label: "Qualifying" },
  { value: "Discovery", label: "Discovery" },
  { value: "Cultivation", label: "Cultivation" },
  { value: "Solicitation", label: "Solicitation" },
  { value: "Ask", label: "Ask" },
  { value: "Ask in Progress", label: "Ask in Progress" },
  { value: "Proposal Sent", label: "Proposal Sent" },
  { value: "Proposal Submitted", label: "Proposal Submitted" },
  { value: "Verbal Commitment", label: "Verbal Commitment" },
  { value: "Contract Creation", label: "Contract Creation" },
  { value: "Contracting", label: "Contracting" },
  { value: "Contract Signed", label: "Contract Signed" },
  { value: "Closed Won", label: "Closed Won" },
  { value: "Closed / Completed", label: "Closed / Completed" },
  { value: "Closed / Fulfilled", label: "Closed / Fulfilled" },
  { value: "Closed / Full-Time or Successful Conversion", label: "Closed / Full-Time or Successful Conversion" },
  { value: "Closed / Temporary Hire", label: "Closed / Temporary Hire" },
  { value: "Collecting", label: "Collecting" },
  { value: "Collecting / In Effect", label: "Collecting / In Effect" },
  { value: "In Effect", label: "In Effect" },
  { value: "Closed Lost", label: "Closed Lost" },
  { value: "Closed / Did not Fulfill", label: "Closed / Did not Fulfill" },
  { value: "Closed / Contract or Agreement But No Fellows Hired", label: "Closed / Contract or Agreement But No Fellows Hired" },
  { value: "Withdrawn", label: "Withdrawn" },
];
