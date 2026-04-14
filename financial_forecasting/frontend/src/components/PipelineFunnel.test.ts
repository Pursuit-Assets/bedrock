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
});
