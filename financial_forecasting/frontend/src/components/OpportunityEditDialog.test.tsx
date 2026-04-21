/**
 * Unit tests for OpportunityEditDialog — Part 5 of PR #159.
 *
 * Covers:
 *   Conversions (tests 1-9):
 *     1-4  StageName schema-driven select + distinguished fallback + not-in-list
 *     5-7  RenewalRepeat__c schema-driven select + distinguished fallback + not-in-list
 *     8-9  Earliest_Scheduled_Payment__c editable date picker + onChange
 *   Payment Schedule nav link (tests 10-12, added in Part 2):
 *    10    "View Payment Schedule" renders when stage ∈ Collecting/Closed
 *    11    Link click invokes useNavigate with /payment-schedule/:oppId
 *    12    Link NOT rendered when Payment Summary block is hidden
 *
 * Mock notes:
 * - getSchemaDescribe uses mockImplementation so all three callers
 *   (useSchemaPicklist × 2 + useOpportunityRecordTypes) all receive a valid
 *   response regardless of call order.
 * - ActivityTimeline is mocked to null so tests don't need to stub
 *   getActivities — the Activities tab never renders in these tests (default
 *   dialogTab = 0 = Details).
 * - react-router-dom useNavigate is captured via module mock so nav tests
 *   can assert the exact path.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from 'react-query';

// ── Mocks (must precede imports of the component under test) ──────────────

jest.mock('../services/api', () => ({
  apiService: {
    getSchemaDescribe: jest.fn(),
    getUsers: jest.fn(),
    getAccounts: jest.fn(),
    updateOpportunity: jest.fn(),
  },
}));

jest.mock('../contexts/PermissionsContext', () => ({
  usePermissions: jest.fn(),
}));

// ActivityTimeline only renders on tab-1; short-circuit to keep tests focused
// on the Details tab and avoid needing getActivities / timeline-specific mocks.
jest.mock('./ActivityTimeline', () => {
  return function MockActivityTimeline() {
    return null;
  };
});

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('react-hot-toast', () => {
  const fn: any = jest.fn();
  fn.success = jest.fn();
  fn.error = jest.fn();
  return { __esModule: true, default: fn };
});

import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import OpportunityEditDialog from './OpportunityEditDialog';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const getUsers = apiService.getUsers as jest.Mock;
const getAccounts = apiService.getAccounts as jest.Mock;
const usePermissionsMock = usePermissions as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0, staleTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

type PicklistEntry = { value: string; active: boolean };

/** Build a describe response with configurable StageName + RenewalRepeat__c picklists.
 *  If caller passes `fields: null` the entire fields array is swapped out (used
 *  to test the field-missing-from-response case). */
function mockSchema(config: {
  stages?: PicklistEntry[];
  renewalRepeat?: PicklistEntry[];
  recordTypes?: any[];
  fieldsOverride?: any[]; // for tests that need to omit fields
}) {
  getSchemaDescribe.mockImplementation(async (sobject: string) => {
    if (sobject !== 'Opportunity') {
      return { data: { sobject, fields: [], recordTypes: [] } };
    }
    const defaultFields = [
      {
        name: 'StageName',
        type: 'picklist',
        picklistValues: (config.stages ?? []).map((s) => ({
          value: s.value,
          label: s.value,
          active: s.active,
        })),
      },
      {
        name: 'RenewalRepeat__c',
        type: 'picklist',
        picklistValues: (config.renewalRepeat ?? []).map((r) => ({
          value: r.value,
          label: r.value,
          active: r.active,
        })),
      },
    ];
    return {
      data: {
        sobject: 'Opportunity',
        fields: config.fieldsOverride ?? defaultFields,
        recordTypes: config.recordTypes ?? [],
      },
    };
  });
}

function defaultPermissions(overrides: Record<string, any> = {}) {
  return {
    can: jest.fn().mockReturnValue(true),
    isAdmin: true,
    sfUserId: '005000000000001',
    orgUserId: null,
    isPlatformUnlinked: false,
    profileName: 'Admin',
    permissions: { edit_all_opportunities: true, reassign_opportunities: true },
    loading: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

function buildOpp(overrides: Record<string, any> = {}) {
  return {
    Id: '006000000000001',
    Name: 'Acme Grant 2026',
    StageName: 'Qualifying',
    Amount: 25000,
    Probability: 50,
    CloseDate: '2026-06-30',
    ExpectedRevenue: 12500,
    OwnerId: '005000000000001',
    AccountId: '001000000000001',
    Account: { Name: 'Acme Foundation' },
    Owner: { Name: 'Test Owner' },
    RecordType: { Name: 'Philanthropy' },
    RecordTypeId: null,
    RenewalRepeat__c: null,
    Earliest_Scheduled_Payment__c: null,
    Active_Opportunity__c: true,
    npe01__Payments_Made__c: null,
    Outstanding_Payments__c: null,
    Number_of_Payments_Received__c: null,
    npe01__Number_of_Payments__c: null,
    Most_Recent_Payment_Date__c: null,
    PaymentDate__c: null,
    Last_Actual_Payment__c: null,
    Contract_Start_Date__c: null,
    Contract_End_Date__c: null,
    Payment_Terms__c: null,
    Billing_Frequency__c: null,
    CreatedDate: '2026-04-01T10:00:00Z',
    LastModifiedDate: '2026-04-01T10:00:00Z',
    LastActivityDate: null,
    ...overrides,
  };
}

function renderDialog(initialData: Record<string, any>) {
  return render(
    <OpportunityEditDialog
      open
      onClose={jest.fn()}
      opportunityId={initialData.Id}
      initialData={initialData}
    />,
    { wrapper: createWrapper() },
  );
}

beforeEach(() => {
  getSchemaDescribe.mockReset();
  getUsers.mockReset();
  getUsers.mockResolvedValue({ data: { data: [] } });
  getAccounts.mockReset();
  getAccounts.mockResolvedValue({ data: { data: [] } });
  mockNavigate.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue(defaultPermissions());
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('OpportunityEditDialog — StageName conversion', () => {
  it('renders active SF stage values as options, hiding inactive ones', async () => {
    mockSchema({
      stages: [
        { value: 'Lead Gen', active: true },
        { value: 'Qualifying', active: true },
        { value: 'Contract Creation', active: true },
        { value: 'Legacy Stage That Was Deactivated', active: false },
      ],
    });

    renderDialog(buildOpp({ StageName: 'Qualifying' }));

    // Wait for the schema hook to settle — the editable select is the branch
    // we want to be in. When hooks resolve, the fallback helperText disappears.
    await waitFor(() => {
      expect(screen.queryByText('Stage list unavailable')).not.toBeInTheDocument();
      expect(screen.queryByText('No active stages available')).not.toBeInTheDocument();
    });

    // Open the Stage select
    // Stage is a required field, so MUI appends a visual asterisk to the
    // label text. Match with a regex to accept both "Stage" and "Stage *".
    const stageInput = screen.getByLabelText(/^Stage\s*\*?$/);
    fireEvent.mouseDown(stageInput);

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Lead Gen')).toBeInTheDocument();
    expect(within(listbox).getByText('Qualifying')).toBeInTheDocument();
    expect(within(listbox).getByText('Contract Creation')).toBeInTheDocument();
    // Inactive values are filtered out by useSchemaPicklist
    expect(within(listbox).queryByText('Legacy Stage That Was Deactivated')).not.toBeInTheDocument();
  });

  it('renders disabled fallback with "Stage list unavailable" when schema fetch errors', async () => {
    getSchemaDescribe.mockRejectedValue(new Error('SF schema 500'));

    renderDialog(buildOpp({ StageName: 'Qualifying' }));

    // Retry:1 means hook settles after ~1s backoff; give it up to 5s.
    await waitFor(
      () => {
        expect(screen.getByText('Stage list unavailable')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.queryByText('No active stages available')).not.toBeInTheDocument();
  });

  it('renders disabled fallback with "No active stages available" when schema resolves empty', async () => {
    mockSchema({ stages: [], renewalRepeat: [] });

    renderDialog(buildOpp({ StageName: 'Qualifying' }));

    await waitFor(() => {
      expect(screen.getByText('No active stages available')).toBeInTheDocument();
    });
    expect(screen.queryByText('Stage list unavailable')).not.toBeInTheDocument();
  });

  it('preserves a not-in-list StageName value as a disabled "(inactive)" MenuItem', async () => {
    mockSchema({
      stages: [
        { value: 'Lead Gen', active: true },
        { value: 'Qualifying', active: true },
        { value: 'Closed Lost', active: true },
      ],
      renewalRepeat: [],
    });

    renderDialog(buildOpp({ StageName: 'Deprecated_Legacy_Stage' }));

    await waitFor(() => {
      expect(screen.queryByText('Stage list unavailable')).not.toBeInTheDocument();
      expect(screen.queryByText('No active stages available')).not.toBeInTheDocument();
    });

    // Open the select; the legacy value should appear as a disabled option
    // Stage is a required field, so MUI appends a visual asterisk to the
    // label text. Match with a regex to accept both "Stage" and "Stage *".
    const stageInput = screen.getByLabelText(/^Stage\s*\*?$/);
    fireEvent.mouseDown(stageInput);

    const listbox = await screen.findByRole('listbox');
    const inactiveOption = within(listbox).getByText('Deprecated_Legacy_Stage (inactive)');
    expect(inactiveOption).toBeInTheDocument();
    // The MenuItem wrapping the label is marked as disabled
    expect(inactiveOption.closest('li')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('OpportunityEditDialog — RenewalRepeat__c conversion', () => {
  it('renders active SF values as options plus an explicit None option at the top', async () => {
    mockSchema({
      stages: [{ value: 'Qualifying', active: true }],
      renewalRepeat: [
        { value: 'New', active: true },
        { value: 'Renewal', active: true },
        { value: 'Upsell', active: true },
      ],
    });

    renderDialog(buildOpp({ RenewalRepeat__c: 'New' }));

    // Wait for the editable branch to mount — both fallback helperTexts must
    // be absent for us to be in the editable-branch render.
    await waitFor(() => {
      expect(screen.queryByText('Renewal / Repeat list unavailable')).not.toBeInTheDocument();
      expect(screen.queryByText('No active Renewal / Repeat values available')).not.toBeInTheDocument();
    });

    const rrInput = screen.getByLabelText('Renewal / Repeat');
    fireEvent.mouseDown(rrInput);

    const listbox = await screen.findByRole('listbox');
    // Explicit None + three active SF values
    expect(within(listbox).getByText('None')).toBeInTheDocument();
    expect(within(listbox).getByText('New')).toBeInTheDocument();
    expect(within(listbox).getByText('Renewal')).toBeInTheDocument();
    expect(within(listbox).getByText('Upsell')).toBeInTheDocument();
  });

  it('renders disabled fallback with distinguished helper text when schema returns no renewal values', async () => {
    mockSchema({
      stages: [{ value: 'Qualifying', active: true }],
      renewalRepeat: [],
    });

    renderDialog(buildOpp({ RenewalRepeat__c: null }));

    await waitFor(() => {
      expect(
        screen.getByText('No active Renewal / Repeat values available'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Renewal / Repeat list unavailable'),
    ).not.toBeInTheDocument();
  });

  it('preserves a not-in-list RenewalRepeat__c value as a disabled "(inactive)" MenuItem', async () => {
    mockSchema({
      stages: [{ value: 'Qualifying', active: true }],
      renewalRepeat: [
        { value: 'New', active: true },
        { value: 'Renewal', active: true },
      ],
    });

    // Old record had a "Expansion" value that SF since removed from the picklist.
    renderDialog(buildOpp({ RenewalRepeat__c: 'Expansion' }));

    await waitFor(() => {
      expect(screen.queryByText('Renewal / Repeat list unavailable')).not.toBeInTheDocument();
      expect(screen.queryByText('No active Renewal / Repeat values available')).not.toBeInTheDocument();
    });

    const rrInput = screen.getByLabelText('Renewal / Repeat');
    fireEvent.mouseDown(rrInput);

    const listbox = await screen.findByRole('listbox');
    const inactiveOption = within(listbox).getByText('Expansion (inactive)');
    expect(inactiveOption).toBeInTheDocument();
    expect(inactiveOption.closest('li')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('OpportunityEditDialog — Earliest_Scheduled_Payment__c conversion', () => {
  it('renders as an editable date input when stage is in PAYMENT_SUMMARY_STAGES', async () => {
    mockSchema({ stages: [{ value: 'Collecting / In Effect', active: true }], renewalRepeat: [] });

    renderDialog(
      buildOpp({
        StageName: 'Collecting / In Effect',
        Earliest_Scheduled_Payment__c: '2026-05-15',
      }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Next Scheduled Payment')).toBeInTheDocument();
    });

    const dateInput = screen.getByLabelText('Next Scheduled Payment') as HTMLInputElement;
    expect(dateInput.type).toBe('date');
    expect(dateInput.value).toBe('2026-05-15');
    // Editable for a user with edit_all_opportunities
    expect(dateInput).not.toBeDisabled();
  });

  it('updates editForm when the date picker changes (onChange → handleFieldChange)', async () => {
    mockSchema({ stages: [{ value: 'Collecting / In Effect', active: true }], renewalRepeat: [] });

    renderDialog(
      buildOpp({
        StageName: 'Collecting / In Effect',
        Earliest_Scheduled_Payment__c: '2026-05-15',
      }),
    );

    const dateInput = (await screen.findByLabelText('Next Scheduled Payment')) as HTMLInputElement;
    expect(dateInput.value).toBe('2026-05-15');

    fireEvent.change(dateInput, { target: { value: '2026-12-01' } });

    // Re-query after state update — the controlled input reflects editForm state
    await waitFor(() => {
      const updated = screen.getByLabelText('Next Scheduled Payment') as HTMLInputElement;
      expect(updated.value).toBe('2026-12-01');
    });
  });
});

describe('OpportunityEditDialog — View Payment Schedule nav link', () => {
  it('renders the View Payment Schedule button when stage is in PAYMENT_SUMMARY_STAGES', async () => {
    mockSchema({ stages: [{ value: 'Collecting / In Effect', active: true }], renewalRepeat: [] });

    renderDialog(
      buildOpp({ StageName: 'Collecting / In Effect' }),
    );

    // Button is inside the same Payment Summary conditional block, which only
    // renders when originalOpp.StageName ∈ PAYMENT_SUMMARY_STAGES.
    const btn = await screen.findByRole('button', { name: /View Payment Schedule/i });
    expect(btn).toBeInTheDocument();
  });

  it('navigates to /payment-schedule/<opportunityId> when the link is clicked', async () => {
    mockSchema({ stages: [{ value: 'Closed / Completed', active: true }], renewalRepeat: [] });

    renderDialog(
      buildOpp({ Id: '006000000000042', StageName: 'Closed / Completed' }),
    );

    const btn = await screen.findByRole('button', { name: /View Payment Schedule/i });
    fireEvent.click(btn);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/payment-schedule/006000000000042');
  });

  it('does NOT render the View Payment Schedule button when stage is early-pipeline', async () => {
    mockSchema({ stages: [{ value: 'Qualifying', active: true }], renewalRepeat: [] });

    renderDialog(
      buildOpp({ StageName: 'Qualifying' }),
    );

    // Let the dialog fully mount (stages hook resolved) before asserting absence
    await waitFor(() => {
      expect(screen.queryByText('Stage list unavailable')).not.toBeInTheDocument();
      expect(screen.queryByText('No active stages available')).not.toBeInTheDocument();
    });

    expect(
      screen.queryByRole('button', { name: /View Payment Schedule/i }),
    ).not.toBeInTheDocument();
  });
});
