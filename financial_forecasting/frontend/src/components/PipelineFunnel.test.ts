import { classifyTransition, WON_STAGES, LOST_STAGES } from './pipelineFunnelTransitions';

// Pipeline stage transition classifier — exercises the logic that was
// previously misbucketing wins as setbacks because terminal stages aren't
// in ACTIVE_FUNNEL_STAGES.

describe('classifyTransition', () => {
  describe('wins', () => {
    it('classifies Collecting → Closed / Completed as won', () => {
      expect(classifyTransition('Collecting / In Effect', 'Closed / Completed')).toBe('won');
    });

    it('classifies Qualifying → Closed / Completed as won (skipping stages)', () => {
      expect(classifyTransition('Qualifying', 'Closed / Completed')).toBe('won');
    });

    it('classifies Lead Gen → Closed / Completed as won (instant close)', () => {
      expect(classifyTransition('Lead Gen', 'Closed / Completed')).toBe('won');
    });
  });

  describe('losses', () => {
    it('classifies Contract Creation → Closed Lost as lost', () => {
      expect(classifyTransition('Contract Creation', 'Closed Lost')).toBe('lost');
    });

    it('classifies Qualifying → Withdrawn as lost', () => {
      expect(classifyTransition('Qualifying', 'Withdrawn')).toBe('lost');
    });

    it('classifies Proposal Negotiation → Closed / Did not Fulfill as lost', () => {
      expect(classifyTransition('Proposal Negotiation', 'Closed / Did not Fulfill')).toBe('lost');
    });
  });

  describe('forward (within active funnel)', () => {
    it('classifies Qualifying → Proposal Negotiation as forward', () => {
      expect(classifyTransition('Qualifying', 'Proposal Negotiation')).toBe('forward');
    });

    it('classifies Lead Gen → Collecting / In Effect as forward (skipping stages)', () => {
      expect(classifyTransition('Lead Gen', 'Collecting / In Effect')).toBe('forward');
    });
  });

  describe('backward (within active funnel)', () => {
    it('classifies Contract Creation → Qualifying as backward', () => {
      expect(classifyTransition('Contract Creation', 'Qualifying')).toBe('backward');
    });

    it('classifies Collecting / In Effect → Proposal Negotiation as backward', () => {
      expect(classifyTransition('Collecting / In Effect', 'Proposal Negotiation')).toBe('backward');
    });
  });

  describe('terminal-state registry', () => {
    it('treats Closed / Completed as the only win stage', () => {
      expect(WON_STAGES.has('Closed / Completed')).toBe(true);
      expect(WON_STAGES.has('Closed Lost')).toBe(false);
      expect(WON_STAGES.has('Withdrawn')).toBe(false);
    });

    it('includes Closed Lost, Withdrawn, and Closed / Did not Fulfill as loss stages', () => {
      expect(LOST_STAGES.has('Closed Lost')).toBe(true);
      expect(LOST_STAGES.has('Withdrawn')).toBe(true);
      expect(LOST_STAGES.has('Closed / Did not Fulfill')).toBe(true);
      expect(LOST_STAGES.has('Closed / Completed')).toBe(false);
    });
  });

  // Regression guard: a stage that Pursuit adds to Salesforce later but
  // forgets to add to ACTIVE_FUNNEL_STAGES / WON_STAGES / LOST_STAGES
  // used to silently render as a "setback" in the funnel. The fallback
  // still returns 'backward' (for UI stability), but we now log a dev
  // warning so the omission gets noticed. These cases pin the behavior.
  describe('unknown stages (future-added / legacy)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('classifies unknown-from → known-active as forward (treats pre-funnel origin as 0)', () => {
      expect(classifyTransition('LegacyPreFunnelStage', 'Qualifying')).toBe('forward');
    });

    it('classifies known-active → unknown-target as backward AND warns in dev', () => {
      expect(classifyTransition('Qualifying', 'Paused_NewStage')).toBe('backward');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown target stage "Paused_NewStage"'),
      );
    });

    it('classifies both-unknown as backward AND warns in dev', () => {
      expect(classifyTransition('LegacyA', 'LegacyB')).toBe('backward');
      expect(warnSpy).toHaveBeenCalled();
    });

    it('does not warn when target is a known terminal (won)', () => {
      classifyTransition('Qualifying', 'Closed / Completed');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn when target is a known terminal (lost)', () => {
      classifyTransition('Qualifying', 'Closed Lost');
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
