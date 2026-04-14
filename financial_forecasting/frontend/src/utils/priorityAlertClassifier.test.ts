import {
  classifyReason,
  groupReasonsByKind,
  ALERT_PRIORITY,
} from './priorityAlertClassifier';

// Tests cover every reason string produced by computeUrgency() in
// priorityScoring.ts. Keep these in sync if you add new reasons there.

describe('classifyReason', () => {
  describe('past close date', () => {
    it('classifies "Overdue by N days" as overdue', () => {
      expect(classifyReason('Overdue by 5 days')).toBe('overdue');
      expect(classifyReason('Overdue by 100 days')).toBe('overdue');
    });
  });

  describe('closing soon', () => {
    it('classifies "Closing in N days" as closing', () => {
      expect(classifyReason('Closing in 7 days')).toBe('closing');
      expect(classifyReason('Closing in 30 days')).toBe('closing');
    });
  });

  describe('stale / quiet', () => {
    it('classifies "Stale — N days since activity" as stale', () => {
      expect(classifyReason('Stale — 45 days since activity')).toBe('stale');
    });

    it('classifies "Quiet >30d" through "Quiet >1yr" as stale', () => {
      expect(classifyReason('Quiet >30d')).toBe('stale');
      expect(classifyReason('Quiet >60d')).toBe('stale');
      expect(classifyReason('Quiet >90d')).toBe('stale');
      expect(classifyReason('Quiet >180d')).toBe('stale');
      expect(classifyReason('Quiet >1yr')).toBe('stale');
    });
  });

  describe('tasks', () => {
    it('classifies "N overdue tasks" as overdueTasks', () => {
      expect(classifyReason('1 overdue task')).toBe('overdueTasks');
      expect(classifyReason('5 overdue tasks')).toBe('overdueTasks');
    });

    it('classifies "No tasks assigned" as noTasks', () => {
      expect(classifyReason('No tasks assigned')).toBe('noTasks');
    });
  });

  describe('meeting', () => {
    it('classifies "Meeting in N day(s): ..." as meeting', () => {
      expect(classifyReason('Meeting in 1 day: Kickoff with ACME')).toBe('meeting');
      expect(classifyReason('Meeting in 3 days: Q4 review')).toBe('meeting');
    });
  });

  describe('renewal', () => {
    it('classifies "Renewal" and "Upsell" as renewal', () => {
      expect(classifyReason('Renewal')).toBe('renewal');
      expect(classifyReason('Upsell')).toBe('renewal');
    });
  });

  describe('unknown', () => {
    it('returns null for unrecognized reason strings (forward compatibility)', () => {
      expect(classifyReason('Some new alert we havent added yet')).toBeNull();
      expect(classifyReason('')).toBeNull();
    });
  });
});

describe('groupReasonsByKind', () => {
  it('dedupes multiple reasons of the same kind under one entry', () => {
    const result = groupReasonsByKind([
      'Stale — 100 days since activity',
      'Quiet >90d',
    ]);
    expect(result).toHaveLength(1);
    expect(result[0][0]).toBe('stale');
    expect(result[0][1]).toEqual([
      'Stale — 100 days since activity',
      'Quiet >90d',
    ]);
  });

  it('orders categories by ALERT_PRIORITY (most severe first)', () => {
    const result = groupReasonsByKind([
      'Renewal',
      'Overdue by 5 days',
      'No tasks assigned',
      '2 overdue tasks',
      'Stale — 60 days since activity',
    ]);
    const kinds = result.map(([k]) => k);
    expect(kinds).toEqual(['overdue', 'overdueTasks', 'stale', 'renewal', 'noTasks']);
    // Priorities should be strictly increasing.
    for (let i = 1; i < kinds.length; i++) {
      expect(ALERT_PRIORITY[kinds[i]]).toBeGreaterThan(ALERT_PRIORITY[kinds[i - 1]]);
    }
  });

  it('skips unknown reasons silently', () => {
    const result = groupReasonsByKind([
      'Overdue by 1 day',
      'Some unknown future reason',
      'Renewal',
    ]);
    expect(result.map(([k]) => k)).toEqual(['overdue', 'renewal']);
  });

  it('returns an empty array when given no reasons', () => {
    expect(groupReasonsByKind([])).toEqual([]);
  });
});
