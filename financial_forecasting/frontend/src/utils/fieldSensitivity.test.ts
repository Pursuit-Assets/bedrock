import {
  classifyField,
  validateDateBounds,
} from './fieldSensitivity';

describe('classifyField', () => {
  describe('safe fields', () => {
    it('Opportunity Name is safe', () => {
      expect(classifyField('Opportunity', 'Name').sensitivity).toBe('safe');
    });
    it('Opportunity NextStep is safe', () => {
      expect(classifyField('Opportunity', 'NextStep').sensitivity).toBe('safe');
    });
    it('Account Phone is safe', () => {
      expect(classifyField('Account', 'Phone').sensitivity).toBe('safe');
    });
    it('Contact Email is safe', () => {
      expect(classifyField('Contact', 'Email').sensitivity).toBe('safe');
    });
    it('Milestone status / phase / due_date are safe', () => {
      expect(classifyField('Milestone', 'status').sensitivity).toBe('safe');
      expect(classifyField('Milestone', 'phase').sensitivity).toBe('safe');
      expect(classifyField('Milestone', 'due_date').sensitivity).toBe('safe');
    });
    it('Task Status / Priority / Subject are safe', () => {
      expect(classifyField('Task', 'Status').sensitivity).toBe('safe');
      expect(classifyField('Task', 'Priority').sensitivity).toBe('safe');
      expect(classifyField('Task', 'Subject').sensitivity).toBe('safe');
    });
  });

  describe('sensitive fields', () => {
    it('Opportunity Stage is sensitive', () => {
      const c = classifyField('Opportunity', 'StageName');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toBeTruthy();
    });
    it('Opportunity Amount is sensitive', () => {
      expect(classifyField('Opportunity', 'Amount').sensitivity).toBe('sensitive');
    });
    it('Opportunity Probability is sensitive', () => {
      expect(classifyField('Opportunity', 'Probability').sensitivity).toBe('sensitive');
    });
    it('Opportunity OwnerId is sensitive', () => {
      expect(classifyField('Opportunity', 'OwnerId').sensitivity).toBe('sensitive');
    });
    it('Opportunity AccountId is sensitive', () => {
      expect(classifyField('Opportunity', 'AccountId').sensitivity).toBe('sensitive');
    });
    it('Opportunity PaymentDate__c is sensitive', () => {
      expect(classifyField('Opportunity', 'PaymentDate__c').sensitivity).toBe('sensitive');
    });
    it('Account OwnerId is sensitive', () => {
      expect(classifyField('Account', 'OwnerId').sensitivity).toBe('sensitive');
    });
    it('Account AnnualRevenue is sensitive', () => {
      expect(classifyField('Account', 'AnnualRevenue').sensitivity).toBe('sensitive');
    });
    it('Contact AccountId reassignment is sensitive', () => {
      expect(classifyField('Contact', 'AccountId').sensitivity).toBe('sensitive');
    });
    it('Milestone owner_id is sensitive', () => {
      expect(classifyField('Milestone', 'owner_id').sensitivity).toBe('sensitive');
    });
    it('Task OwnerId is sensitive', () => {
      expect(classifyField('Task', 'OwnerId').sensitivity).toBe('sensitive');
    });
  });

  describe('permission-gated fields', () => {
    it('Project status requires edit_project_status', () => {
      const c = classifyField('Project', 'status');
      expect(c.sensitivity).toBe('permission-gated');
      expect(c.permission).toBe('edit_project_status');
      expect(c.lockReason).toBeTruthy();
    });
    it('Target amount requires manage_targets', () => {
      const c = classifyField('Target', 'amount');
      expect(c.sensitivity).toBe('permission-gated');
      expect(c.permission).toBe('manage_targets');
    });
    it('Target period requires manage_targets', () => {
      const c = classifyField('Target', 'period');
      expect(c.sensitivity).toBe('permission-gated');
      expect(c.permission).toBe('manage_targets');
    });
  });

  describe('unknown fields fail safe to sensitive', () => {
    it('returns sensitive for unknown object type', () => {
      const c = classifyField('UnknownObject', 'Name');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toContain('not classified');
    });
    it('returns sensitive for unknown field on known object', () => {
      const c = classifyField('Opportunity', 'SomeFieldNobodyClassified__c');
      expect(c.sensitivity).toBe('sensitive');
      expect(c.lockReason).toContain('not classified');
    });
  });
});

describe('validateDateBounds', () => {
  it('returns null for a date well within bounds', () => {
    expect(validateDateBounds('2026-06-15')).toBeNull();
    expect(validateDateBounds('1999-01-01')).toBeNull();
  });

  it('rejects dates before 1970', () => {
    expect(validateDateBounds('1969-12-31')).toMatch(/1970/);
    expect(validateDateBounds('1900-06-01')).toMatch(/1970/);
  });

  it('rejects dates more than 10 years out', () => {
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 11);
    const result = validateDateBounds(farFuture);
    expect(result).toMatch(/10 years/);
  });

  it('returns null for a date exactly at the 10-year horizon', () => {
    const tenYears = new Date();
    tenYears.setFullYear(tenYears.getFullYear() + 10);
    tenYears.setDate(tenYears.getDate() - 1); // 1 day under
    expect(validateDateBounds(tenYears)).toBeNull();
  });

  it('rejects invalid date strings', () => {
    expect(validateDateBounds('not a date')).toMatch(/invalid/i);
  });

  it('accepts a Date object directly', () => {
    expect(validateDateBounds(new Date(2026, 5, 15))).toBeNull();
  });
});
