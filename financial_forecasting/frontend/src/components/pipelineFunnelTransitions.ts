/**
 * Pure helpers for classifying stage transitions on the Pipeline Funnel.
 * Kept in its own module (no MUI, no axios, no hooks) so it can be unit-tested
 * without pulling the entire component tree.
 */
import {
  WON_STAGES as CANONICAL_WON_STAGES,
  LOST_STAGES as CANONICAL_LOST_STAGES,
} from '../types/salesforce';

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

// Terminal stages — derived from the canonical sets in types/salesforce.ts so
// there's one source of truth. A transition INTO a terminal stage is a win
// or loss, not a backward move within the funnel.
export const WON_STAGES = new Set<string>(CANONICAL_WON_STAGES);
export const LOST_STAGES = new Set<string>(CANONICAL_LOST_STAGES);

export function classifyTransition(from: string, to: string): TransitionKind {
  if (WON_STAGES.has(to)) return 'won';
  if (LOST_STAGES.has(to)) return 'lost';
  const fi = STAGE_IDX.get(from) ?? -1;
  const ti = STAGE_IDX.get(to) ?? -1;
  // A stage unknown to every set (not active, not won, not lost) silently
  // falls into 'backward' below. That's benign for legitimate moves within
  // the funnel, but it also masks a newly-added Salesforce stage that
  // wasn't added to any canonical set here. Surface it in dev so someone
  // notices; production stays silent (no user-visible breakage).
  if (ti < 0) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        `[pipelineFunnelTransitions] Unknown target stage "${to}". ` +
        `Not in ACTIVE_FUNNEL_STAGES, WON_STAGES, or LOST_STAGES — falling through to "backward". ` +
        `If this is a new stage, update types/salesforce.ts and the sets in this file.`,
      );
    }
  }
  return ti > fi ? 'forward' : 'backward';
}
