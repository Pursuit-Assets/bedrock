/**
 * Pure helpers for classifying stage transitions on the Pipeline Funnel.
 * Kept in its own module (no MUI, no axios, no hooks) so it can be unit-tested
 * without pulling the entire component tree.
 */

export type TransitionKind = 'forward' | 'backward' | 'won' | 'lost';

// Active (non-terminal) pipeline stages, in order. Duplicated from PipelineFunnel
// so this helper can be imported in isolation. Keep in sync with ACTIVE_FUNNEL_STAGES.
export const ACTIVE_FUNNEL_STAGES = [
  'Lead Gen',
  'New Lead',
  'Qualifying',
  'Design / Proposal Creation',
  'Proposal Negotiation',
  'Contract Creation',
  'Negotiating Contract',
  'Collecting / In Effect',
] as const;

export const STAGE_IDX = new Map<string, number>(
  ACTIVE_FUNNEL_STAGES.map((s, i) => [s, i]),
);

// Terminal stages — not part of ACTIVE_FUNNEL_STAGES. A transition INTO a
// terminal stage is a win or loss, not a backward move within the funnel.
export const WON_STAGES = new Set<string>(['Closed / Completed']);
export const LOST_STAGES = new Set<string>([
  'Closed Lost',
  'Withdrawn',
  'Closed / Did not Fulfill',
]);

export function classifyTransition(from: string, to: string): TransitionKind {
  if (WON_STAGES.has(to)) return 'won';
  if (LOST_STAGES.has(to)) return 'lost';
  const fi = STAGE_IDX.get(from) ?? -1;
  const ti = STAGE_IDX.get(to) ?? -1;
  return ti > fi ? 'forward' : 'backward';
}
