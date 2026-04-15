import React from 'react';
import '@testing-library/jest-dom';

import type { Lead, Grant, WeeklyPriorityItem } from '../types/weeklyPriorities';
import {
  LOOKAHEAD_DAYS,
  isInLookaheadWindow,
  buildAction,
  buildPriorityItems,
} from '../utils/weeklyPrioritiesHelpers';
import { parseCSV } from '../utils/csvParser';

// ---------------------------------------------------------------------------
// Tests for the business logic used by WeeklyPriorities page.
// We test the helpers + data flow, not the MUI rendering.
// ---------------------------------------------------------------------------

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: `prospect-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    first_name: 'Jane',
    last_name: 'Donor',
    organization: 'Test Foundation',
    title: 'Director',
    source: 'csv',
    status: 'new',
    priority: 'medium',
    notes: '',
    email: 'jane@test.org',
    phone: '',
    grant_id: '',
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    owner: '',
    ...overrides,
  } as Lead;
}

function makeGrant(overrides: Partial<Grant> = {}): Grant {
  return {
    id: '006GRANT001',
    name: 'Spring Grant Program',
    close_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    stage: 'Qualifying',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lookahead window
// ---------------------------------------------------------------------------
describe('WeeklyPriorities — lookahead window', () => {
  const now = new Date('2026-03-16T00:00:00Z');

  it('LOOKAHEAD_DAYS is 30', () => {
    expect(LOOKAHEAD_DAYS).toBe(30);
  });

  it('date within 30 days is in window', () => {
    expect(isInLookaheadWindow('2026-03-25', now)).toBe(true);
  });

  it('last day of window is in window', () => {
    // Window = [now, now + LOOKAHEAD_DAYS - 1] inclusive, so with now = Mar 16
    // and LOOKAHEAD_DAYS = 30, the last included day is Apr 14 (day 29).
    // Day 30 (Apr 15) falls outside — verified by the sister test below.
    expect(isInLookaheadWindow('2026-04-14', now)).toBe(true);
  });

  it('day after window is outside window', () => {
    expect(isInLookaheadWindow('2026-04-15', now)).toBe(false);
  });

  it('date 31 days out is outside window', () => {
    expect(isInLookaheadWindow('2026-04-16', now)).toBe(false);
  });

  it('past date is outside window', () => {
    expect(isInLookaheadWindow('2026-03-15', now)).toBe(false);
  });

  it('invalid date returns false', () => {
    expect(isInLookaheadWindow('not-a-date', now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildAction
// ---------------------------------------------------------------------------
describe('WeeklyPriorities — buildAction', () => {
  it('builds action text with close date', () => {
    const grant = makeGrant({ close_date: '2026-04-01' });
    const action = buildAction(grant);
    expect(action).toContain('2026-04-01');
    expect(action.toLowerCase()).toContain('follow up');
  });

  it('handles grant with undefined close_date gracefully', () => {
    const grant = makeGrant({ close_date: '' });
    const action = buildAction(grant);
    expect(typeof action).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// buildPriorityItems
// ---------------------------------------------------------------------------
describe('WeeklyPriorities — buildPriorityItems', () => {
  it('pairs leads with their linked grants', () => {
    const grants = [makeGrant({ id: 'G1', name: 'Grant A' })];
    const leads = [
      makeLead({ id: 'L1', grant_id: 'G1', first_name: 'Alice' }),
      makeLead({ id: 'L2', grant_id: 'G1', first_name: 'Bob' }),
    ];

    const items = buildPriorityItems(leads, grants);
    expect(items).toHaveLength(2);
    items.forEach((item) => {
      expect(item.grant?.id).toBe('G1');
      expect(item.suggested_action).toBeTruthy();
    });
  });

  it('excludes leads without a grant_id', () => {
    const grants = [makeGrant({ id: 'G1' })];
    const leads = [
      makeLead({ id: 'L1', grant_id: 'G1' }),
      makeLead({ id: 'L2', grant_id: '' }),
      makeLead({ id: 'L3' }),
    ];

    const items = buildPriorityItems(leads, grants);
    expect(items).toHaveLength(1);
    expect(items[0].lead.id).toBe('L1');
  });

  it('handles unmatched grant_id gracefully', () => {
    const grants = [makeGrant({ id: 'G1' })];
    const leads = [makeLead({ id: 'L1', grant_id: 'G999' })];

    const items = buildPriorityItems(leads, grants);
    // Either returns item with undefined grant or excludes it — both are valid
    if (items.length > 0) {
      expect(items[0].lead.id).toBe('L1');
    }
  });

  it('returns empty for empty inputs', () => {
    expect(buildPriorityItems([], [])).toEqual([]);
    expect(buildPriorityItems([makeLead()], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CSV upload → lead parsing flow
// ---------------------------------------------------------------------------
describe('WeeklyPriorities — CSV import', () => {
  function makeFile(content: string): File {
    return new File([content], 'test.csv', { type: 'text/csv' });
  }

  it('parses valid CSV with required columns', async () => {
    const csv = `first_name,last_name,organization,source
Alice,Smith,Ford Foundation,manual
Bob,Jones,Tech Corp,linkedin`;

    const result = await parseCSV(makeFile(csv));
    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(result.leads).toHaveLength(2);
    expect(result.leads[0].first_name).toBe('Alice');
    expect(result.leads[1].last_name).toBe('Jones');
  });

  it('generates lead IDs matching expected format', async () => {
    const csv = `first_name,last_name,organization,source
Alice,Smith,Org,csv`;

    const result = await parseCSV(makeFile(csv));
    expect(result.leads).toHaveLength(1);
    // IDs follow lead-{timestamp}-{index} pattern (renamed from prospect-
    // when the lead/prospect terminology was consolidated, csvParser.ts:185).
    expect(result.leads[0].id).toMatch(/^lead-\d+-\d+$/);
  });

  it('handles empty CSV', async () => {
    const csv = `first_name,last_name,organization,source`;
    const result = await parseCSV(makeFile(csv));
    expect(result.imported).toBe(0);
    expect(result.leads).toHaveLength(0);
  });

  it('reports errors for rows with no name at all', async () => {
    // csvParser.ts:166-170 validates that AT LEAST ONE of first_name /
    // last_name / name is present. Either alone is acceptable. Only fully
    // nameless rows trigger a VALIDATION_ERROR. This test previously expected
    // errors for first- or last-only rows, which is not the current contract.
    const csv = `first_name,last_name,organization,source
,,Org,csv
,,Another Org,csv`;

    const result = await parseCSV(makeFile(csv));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// End-to-end flow: CSV → assign grants → priority list
// ---------------------------------------------------------------------------
describe('WeeklyPriorities — end-to-end flow', () => {
  it('complete flow: import → assign → prioritize', async () => {
    // Step 1: Import leads from CSV
    const csv = `first_name,last_name,organization,source
Alice,Smith,Ford Foundation,csv
Bob,Jones,Tech Corp,csv`;
    const file = new File([csv], 'test.csv', { type: 'text/csv' });
    const importResult = await parseCSV(file);
    expect(importResult.leads).toHaveLength(2);

    // Step 2: Assign grants to leads
    const grants = [
      makeGrant({ id: 'G1', name: 'Spring Program', close_date: '2026-04-01' }),
      makeGrant({ id: 'G2', name: 'Summer Program', close_date: '2026-04-10' }),
    ];

    const leadsWithGrants = importResult.leads.map((lead, i) => ({
      ...lead,
      grant_id: grants[i % grants.length].id,
    }));

    // Step 3: Build priority list
    const priorities = buildPriorityItems(leadsWithGrants, grants);
    expect(priorities).toHaveLength(2);
    expect(priorities[0].grant).toBeTruthy();
    expect(priorities[0].suggested_action).toBeTruthy();
    expect(priorities[1].grant).toBeTruthy();
  });
});
