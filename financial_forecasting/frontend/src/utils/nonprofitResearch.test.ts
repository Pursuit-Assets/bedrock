import type { Lead } from '../types/weeklyPriorities';
import {
  searchOrganizations,
  lookup990,
  lookup990ByName,
  findPersonIn990s,
  enrichInstitutionalLead,
  enrichIndividualLead,
  batchEnrich,
  isEnrichable,
  countEnrichable,
} from './nonprofitResearch';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_SEARCH_RESPONSE = {
  organizations: [
    { ein: '123456789', name: 'Test Foundation', city: 'New York', state: 'NY', ntee_code: 'B20', score: 95 },
    { ein: '987654321', name: 'Second Org', city: 'Chicago', state: 'IL', ntee_code: 'J20', score: 80 },
  ],
};

const MOCK_ORG_RESPONSE = {
  organization: {
    name: 'Test Foundation',
    city: 'New York',
    state: 'NY',
    total_assets: 5000000,
    total_revenue: 2000000,
    total_expenses: 1800000,
    ntee_code: 'B20',
  },
  filings_with_data: [
    {
      tax_prd_yr: 2024,
      tax_prd: '202412',
      totfuncexpns: 1500000,
    },
  ],
};

// ---------------------------------------------------------------------------
// Helper: build a Lead
// ---------------------------------------------------------------------------

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'test-1',
    first_name: 'Jane',
    last_name: 'Donor',
    organization: 'Test Foundation',
    source: 'csv',
    status: 'new',
    priority: 'medium',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Lead;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  localStorage.removeItem('pursuit-990-cache');
  global.fetch = jest.fn();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  (console.warn as jest.Mock).mockRestore?.();
});

function mockFetchResponse(body: any, ok = true, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    json: async () => body,
  });
}

// ---------------------------------------------------------------------------
// 1-2. searchOrganizations
// ---------------------------------------------------------------------------
describe('searchOrganizations', () => {
  it('returns mapped results from ProPublica API', async () => {
    mockFetchResponse(MOCK_SEARCH_RESPONSE);

    const results = await searchOrganizations('Test Foundation');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
      'search.json?q=Test%20Foundation',
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      ein: '123456789',
      name: 'Test Foundation',
      city: 'New York',
      state: 'NY',
      ntee_code: 'B20',
      score: 95,
    });
  });

  it('uses cache on second call (no additional fetch)', async () => {
    mockFetchResponse(MOCK_SEARCH_RESPONSE);

    const first = await searchOrganizations('cached query');
    const second = await searchOrganizations('cached query');

    // Only one fetch should have been made
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// 3-4. lookup990
// ---------------------------------------------------------------------------
describe('lookup990', () => {
  it('fetches and parses filing data', async () => {
    mockFetchResponse(MOCK_ORG_RESPONSE);

    const filing = await lookup990('123456789');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain(
      'organizations/123456789.json',
    );
    expect(filing).not.toBeNull();
    expect(filing!.ein).toBe('123456789');
    expect(filing!.name).toBe('Test Foundation');
    expect(filing!.totalAssets).toBe(5000000);
    expect(filing!.totalRevenue).toBe(2000000);
    expect(filing!.totalGrants).toBe(1500000);
    expect(filing!.taxPeriod).toBe('2024');
  });

  it('returns null for unknown EIN (no organization in response)', async () => {
    mockFetchResponse({ organization: null, filings_with_data: [] });

    const filing = await lookup990('000000000');
    expect(filing).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. lookup990ByName
// ---------------------------------------------------------------------------
describe('lookup990ByName', () => {
  it('combines search + lookup (uses first match)', async () => {
    // First call: search
    mockFetchResponse(MOCK_SEARCH_RESPONSE);
    // Second call: org lookup for the first match
    mockFetchResponse(MOCK_ORG_RESPONSE);

    const filing = await lookup990ByName('Test Foundation');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(filing).not.toBeNull();
    expect(filing!.name).toBe('Test Foundation');
  });
});

// ---------------------------------------------------------------------------
// 6. findPersonIn990s
// ---------------------------------------------------------------------------
describe('findPersonIn990s', () => {
  it('returns appearances from search results', async () => {
    mockFetchResponse(MOCK_SEARCH_RESPONSE);

    const appearances = await findPersonIn990s('Jane Donor');

    expect(appearances).toHaveLength(2);
    expect(appearances[0]).toEqual({
      orgName: 'Test Foundation',
      ein: '123456789',
      title: 'Officer/Director',
      compensation: 0,
    });
    expect(appearances[1].orgName).toBe('Second Org');
  });
});

// ---------------------------------------------------------------------------
// 7-9. enrichInstitutionalLead
// ---------------------------------------------------------------------------
describe('enrichInstitutionalLead', () => {
  it('enriches with 990 data', async () => {
    // search call
    mockFetchResponse(MOCK_SEARCH_RESPONSE);
    // org lookup call
    mockFetchResponse(MOCK_ORG_RESPONSE);

    const lead = makeLead({
      id: 'inst-1',
      organization: 'Test Foundation',
      prospect_type: 'institutional_grantmaker',
    });

    const result = await enrichInstitutionalLead(lead);

    expect(result.error).toBeUndefined();
    expect(result.lead.enrichment_status).toBe('enriched');
    expect(result.lead.enrichment_source).toBe('propublica_990');
    expect(result.lead.ein).toBe('123456789');
    expect(result.lead.total_990_assets).toBe(5000000);
    expect(result.lead.total_990_grants_paid).toBe(1500000);
    expect(result.filing).toBeDefined();
  });

  it('sets not_found when no org found', async () => {
    // search returns empty
    mockFetchResponse({ organizations: [] });

    const lead = makeLead({ id: 'inst-2', organization: 'Ghost Org' });
    const result = await enrichInstitutionalLead(lead);

    expect(result.lead.enrichment_status).toBe('not_found');
    expect(result.filing).toBeUndefined();
  });

  it('handles error gracefully (sets partial)', async () => {
    // fetch throws
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('Network failure'));

    const lead = makeLead({ id: 'inst-3', organization: 'Error Org' });
    const result = await enrichInstitutionalLead(lead);

    expect(result.lead.enrichment_status).toBe('partial');
    expect(result.error).toBe('Network failure');
  });
});

// ---------------------------------------------------------------------------
// 10. enrichIndividualLead
// ---------------------------------------------------------------------------
describe('enrichIndividualLead', () => {
  it('enriches with board memberships', async () => {
    // findPersonIn990s → searchOrganizations
    mockFetchResponse(MOCK_SEARCH_RESPONSE);
    // lookup990 for first appearance
    mockFetchResponse(MOCK_ORG_RESPONSE);

    const lead = makeLead({
      id: 'indiv-1',
      first_name: 'Jane',
      last_name: 'Donor',
      prospect_type: 'hnwi',
    });

    const result = await enrichIndividualLead(lead);

    expect(result.lead.enrichment_status).toBe('enriched');
    expect(result.lead.enrichment_source).toBe('propublica_990');
    expect(result.lead.board_memberships).toContain('Test Foundation');
    expect(result.lead.board_memberships).toContain('Second Org');
    expect(result.filing).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. batchEnrich
// ---------------------------------------------------------------------------
describe('batchEnrich', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('processes multiple leads and calls onProgress', async () => {
    // Use real timers for this test — batchEnrich awaits setTimeout for the
    // rate-limit delay, and the fake-timer approach (advanceTimersByTime +
    // Promise.resolve) doesn't reliably flush the intermediate async/await
    // microtasks under jest, causing a 5000ms test timeout. The real wait is
    // only ~200ms per inter-lead delay, well within a reasonable budget.
    jest.useRealTimers();

    // Lead A (institutional): search + org lookup
    mockFetchResponse(MOCK_SEARCH_RESPONSE);
    mockFetchResponse(MOCK_ORG_RESPONSE);
    // Lead B (individual): search + org lookup
    mockFetchResponse(MOCK_SEARCH_RESPONSE);
    mockFetchResponse(MOCK_ORG_RESPONSE);

    const leadA = makeLead({
      id: 'batch-1',
      first_name: 'Org',
      last_name: 'Lead',
      organization: 'Test Foundation',
      prospect_type: 'institutional_grantmaker',
    });
    const leadB = makeLead({
      id: 'batch-2',
      first_name: 'Jane',
      last_name: 'Individual',
      organization: 'Some Corp',
      prospect_type: 'hnwi',
    });

    const onProgress = jest.fn();

    const results = await batchEnrich([leadA, leadB], onProgress);

    expect(results).toHaveLength(2);
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });
});

// ---------------------------------------------------------------------------
// 12-14. isEnrichable / countEnrichable
// ---------------------------------------------------------------------------
describe('isEnrichable', () => {
  it('returns true for leads with organization', () => {
    const lead = makeLead({ enrichment_status: undefined });
    expect(isEnrichable(lead)).toBe(true);
  });

  it('returns true for leads with first_name and last_name', () => {
    const lead = makeLead({
      organization: undefined,
      institution_name: undefined,
      ein: undefined,
      enrichment_status: undefined,
    });
    expect(isEnrichable(lead)).toBe(true);
  });

  it('returns false for already enriched leads', () => {
    const lead = makeLead({ enrichment_status: 'enriched' });
    expect(isEnrichable(lead)).toBe(false);
  });
});

describe('countEnrichable', () => {
  it('counts correctly', () => {
    const leads = [
      makeLead({ id: '1', enrichment_status: undefined }),
      makeLead({ id: '2', enrichment_status: 'enriched' }),
      makeLead({ id: '3', enrichment_status: 'not_found', ein: '111' }),
    ];

    // lead 1: enrichable (has org, not enriched)
    // lead 2: NOT enrichable (already enriched)
    // lead 3: enrichable (has org + ein, status is not_found which != 'enriched')
    expect(countEnrichable(leads)).toBe(2);
  });
});
