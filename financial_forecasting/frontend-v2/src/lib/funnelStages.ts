import { AWARD_ELIGIBLE_STAGES } from "@/lib/stages";

export type TransitionKind = "forward" | "backward" | "won" | "lost";

/**
 * Active (non-terminal) pipeline stages, in funnel order. "Lead Gen" and
 * "Contract Creation" were removed 2026-05-04 per JR — Lead Gen wasn't
 * carrying useful signal vs. New Lead, and Contract Creation duplicated
 * Negotiating Contract for our flow.
 */
export const ACTIVE_FUNNEL_STAGES = [
  "New Lead",
  "Qualifying",
  "Design / Proposal Creation",
  "Proposal Negotiation",
  "Negotiating Contract",
  "Collecting / In Effect",
] as const;

export const STAGE_IDX = new Map<string, number>(
  ACTIVE_FUNNEL_STAGES.map((s, i) => [s, i] as const),
);

/** Won = any stage that produces a bedrock.award row (matches isWon in
 *  lib/stages.ts). */
export const WON_STAGES: ReadonlySet<string> = AWARD_ELIGIBLE_STAGES;

/** Lost = closed but not won. Same pattern as the deployed funnel; the
 *  set is enumerated rather than computed so the classifier doesn't
 *  need access to the SfOpportunity row.  */
export const LOST_STAGES: ReadonlySet<string> = new Set([
  "Closed Lost",
  "Closed / Did not Fulfill",
  "Closed / Contract or Agreement But No Fellows Hired",
  "Withdrawn",
  "Closed / Unknown",
  "Closed Unknown",
  "Close Unknown",
]);

/**
 * Classify a stage transition `from → to`. Wins/losses are detected via
 * the terminal-stage sets above; movements between active stages are
 * forward (later index) or backward (earlier index, including unknown
 * targets — which are silently treated as backward to avoid silently
 * dropping legitimate moves to a stage we haven't catalogued yet).
 */
export function classifyTransition(from: string, to: string): TransitionKind {
  if (WON_STAGES.has(to)) return "won";
  if (LOST_STAGES.has(to)) return "lost";
  const fi = STAGE_IDX.get(from) ?? -1;
  const ti = STAGE_IDX.get(to) ?? -1;
  return ti > fi ? "forward" : "backward";
}

/**
 * Hex colors per active stage — pulled from the deployed funnel for
 * visual continuity. Bars are colored with these so users get the
 * same gradient cue moving down the funnel.
 */
export const STAGE_HEX: Record<string, string> = {
  "Lead Gen": "#9aa0a6",
  "New Lead": "#6c757d",
  Qualifying: "#5e72e4",
  "Design / Proposal Creation": "#3f51b5",
  "Proposal Negotiation": "#1976d2",
  "Contract Creation": "#0288d1",
  "Negotiating Contract": "#00838f",
  "Collecting / In Effect": "#2e7d32",
};

export function getStageHexColor(stage: string): string {
  return STAGE_HEX[stage] ?? "#5e72e4";
}
