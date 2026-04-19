/**
 * Cross-system consistency tests: stage enums, group completeness,
 * and frontend↔backend alignment.
 *
 * These verify the invariant documented in salesforce.ts:
 * "Stage values MUST match the custom picklist in the Salesforce org
 *  and the OpportunityStage enum in financial_forecasting/models.py."
 */
import {
  OPPORTUNITY_STAGES,
  OPEN_STAGES,
  COLLECTING_STAGES,
  CLOSED_STAGES,
  WON_STAGES,
  LOST_STAGES,
  PAYMENT_RECEIVED_STAGES,
} from './salesforce';

// ---------------------------------------------------------------------------
// Backend stage values (from models.py OpportunityStage enum)
// ---------------------------------------------------------------------------
const BACKEND_STAGES = [
  '--None--',
  'Lead Gen',
  'New Lead',
  'Qualifying',
  'Design / Proposal Creation',
  'Proposal Negotiation',
  'Contract Creation',
  'Negotiating Contract',
  'Collecting / In Effect',
  'Closed / Did not Fulfill',
  'Closed / Completed',
  'Closed Lost',
  'Withdrawn',
] as const;

// ---------------------------------------------------------------------------
// Frontend ↔ Backend alignment
// ---------------------------------------------------------------------------
describe('frontend↔backend stage alignment', () => {
  it('has the same stages as the backend OpportunityStage enum', () => {
    expect([...OPPORTUNITY_STAGES]).toEqual([...BACKEND_STAGES]);
  });

  it('has exactly 13 stages', () => {
    expect(OPPORTUNITY_STAGES).toHaveLength(13);
  });
});

// ---------------------------------------------------------------------------
// Stage group completeness
// ---------------------------------------------------------------------------
describe('stage groups', () => {
  const allGrouped = [...OPEN_STAGES, ...COLLECTING_STAGES, ...CLOSED_STAGES];

  it('every non-None stage belongs to exactly one group', () => {
    const stagesMinusNone = OPPORTUNITY_STAGES.filter((s) => s !== '--None--');
    expect(allGrouped.sort()).toEqual([...stagesMinusNone].sort());
  });

  it('OPEN_STAGES has 7 stages', () => {
    expect(OPEN_STAGES).toHaveLength(7);
  });

  it('COLLECTING_STAGES has 1 stage', () => {
    expect(COLLECTING_STAGES).toHaveLength(1);
  });

  it('CLOSED_STAGES has 4 stages', () => {
    expect(CLOSED_STAGES).toHaveLength(4);
  });

  it('groups are disjoint (no stage in two groups)', () => {
    const seen = new Set<string>();
    for (const stage of allGrouped) {
      expect(seen.has(stage)).toBe(false);
      seen.add(stage);
    }
  });
});

// ---------------------------------------------------------------------------
// Win / loss / payment bucket memberships
//
// WON_STAGES and LOST_STAGES intentionally admit stage strings outside the
// 13-stage OpportunityStage enum — notably 'Closed Won' (Donorbox philanthropy,
// ~575 live records). See types/salesforce.ts for the canonical sets.
// ---------------------------------------------------------------------------
describe('win / loss / payment bucket memberships', () => {
  it('WON_STAGES includes Collecting / In Effect, Closed / Completed, and Closed Won', () => {
    expect(WON_STAGES.has('Collecting / In Effect')).toBe(true);
    expect(WON_STAGES.has('Closed / Completed')).toBe(true);
    expect(WON_STAGES.has('Closed Won')).toBe(true);
  });

  it('WON_STAGES excludes losses, open stages, and unknown strings', () => {
    expect(WON_STAGES.has('Closed Lost')).toBe(false);
    expect(WON_STAGES.has('Withdrawn')).toBe(false);
    expect(WON_STAGES.has('Closed / Did not Fulfill')).toBe(false);
    expect(WON_STAGES.has('Qualifying')).toBe(false);
    expect(WON_STAGES.size).toBe(3);
  });

  it('LOST_STAGES includes Closed Lost, Withdrawn, Closed / Did not Fulfill', () => {
    expect(LOST_STAGES.has('Closed Lost')).toBe(true);
    expect(LOST_STAGES.has('Withdrawn')).toBe(true);
    expect(LOST_STAGES.has('Closed / Did not Fulfill')).toBe(true);
  });

  it('LOST_STAGES excludes wins and open stages', () => {
    expect(LOST_STAGES.has('Closed / Completed')).toBe(false);
    expect(LOST_STAGES.has('Closed Won')).toBe(false);
    expect(LOST_STAGES.has('Qualifying')).toBe(false);
    expect(LOST_STAGES.size).toBe(3);
  });

  it('PAYMENT_RECEIVED_STAGES is {Closed / Completed, Closed Won}', () => {
    expect(PAYMENT_RECEIVED_STAGES.has('Closed / Completed')).toBe(true);
    expect(PAYMENT_RECEIVED_STAGES.has('Closed Won')).toBe(true);
    expect(PAYMENT_RECEIVED_STAGES.has('Collecting / In Effect')).toBe(false);
    expect(PAYMENT_RECEIVED_STAGES.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bucket invariants (tested here so a future bucket-set edit can't silently
// break the set-algebra relationships the rest of the app depends on).
// ---------------------------------------------------------------------------
describe('bucket invariants', () => {
  it('PAYMENT_RECEIVED_STAGES ⊂ WON_STAGES', () => {
    PAYMENT_RECEIVED_STAGES.forEach((stage) => {
      expect(WON_STAGES.has(stage)).toBe(true);
    });
  });

  it('COLLECTING_STAGES ⊂ WON_STAGES', () => {
    COLLECTING_STAGES.forEach((stage) => {
      expect(WON_STAGES.has(stage)).toBe(true);
    });
  });

  it('PAYMENT_RECEIVED_STAGES ∩ COLLECTING_STAGES = ∅', () => {
    const collecting = COLLECTING_STAGES as readonly string[];
    PAYMENT_RECEIVED_STAGES.forEach((stage) => {
      expect(collecting.includes(stage)).toBe(false);
    });
  });

  it('WON_STAGES ∩ LOST_STAGES = ∅', () => {
    WON_STAGES.forEach((stage) => {
      expect(LOST_STAGES.has(stage)).toBe(false);
    });
  });

  it('WON_STAGES ∩ OPEN_STAGES = ∅', () => {
    const open = OPEN_STAGES as readonly string[];
    WON_STAGES.forEach((stage) => {
      expect(open.includes(stage)).toBe(false);
    });
  });

  it('LOST_STAGES ∩ OPEN_STAGES = ∅', () => {
    const open = OPEN_STAGES as readonly string[];
    LOST_STAGES.forEach((stage) => {
      expect(open.includes(stage)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Pipeline ordering invariant
// ---------------------------------------------------------------------------
describe('pipeline stage ordering', () => {
  it('OPEN_STAGES appear before COLLECTING and CLOSED in the enum', () => {
    const indices = (stages: readonly string[]) =>
      stages.map((s) => OPPORTUNITY_STAGES.indexOf(s as any));

    const openIndices = indices(OPEN_STAGES);
    const collectingIndices = indices(COLLECTING_STAGES);
    const closedIndices = indices(CLOSED_STAGES);

    // All open stages should precede collecting
    expect(Math.max(...openIndices)).toBeLessThan(Math.min(...collectingIndices));
    // Collecting should precede closed
    expect(Math.max(...collectingIndices)).toBeLessThan(Math.min(...closedIndices));
  });
});
