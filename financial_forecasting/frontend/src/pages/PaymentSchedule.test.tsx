/**
 * Unit tests for PaymentSchedule.tsx — covers the new Edit Details
 * clickthrough that wires PaymentEditDialog (PR #159).
 *
 * Tests:
 *   1. Renders payment rows from a mocked getPaymentSchedule response
 *   2. Edit Details opens PaymentEditDialog populated with the full SF record
 *   3. After PaymentEditDialog.onSaved fires, getPaymentSchedule is called
 *      again (refresh) so the schedule table stays in sync with the single-
 *      record PATCH that PaymentEditDialog performed
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../services/api', () => ({
  apiService: {
    getPaymentSchedule: jest.fn(),
    getSfOpportunityPayments: jest.fn(),
    savePaymentSchedule: jest.fn(),
    updateOpportunityStage: jest.fn(),
    getSchemaDescribe: jest.fn(),
    updateSfPayment: jest.fn(),
  },
}));

jest.mock('../contexts/PermissionsContext', () => ({
  usePermissions: jest.fn(),
}));

jest.mock('react-hot-toast', () => {
  const fn: any = jest.fn();
  fn.success = jest.fn();
  fn.error = jest.fn();
  return { toast: fn, __esModule: true, default: fn };
});

import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import PaymentSchedule from './PaymentSchedule';

const getPaymentSchedule = apiService.getPaymentSchedule as jest.Mock;
const getSfOpportunityPayments = apiService.getSfOpportunityPayments as jest.Mock;
const savePaymentSchedule = apiService.savePaymentSchedule as jest.Mock;
const updateOpportunityStage = apiService.updateOpportunityStage as jest.Mock;
const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const updateSfPayment = apiService.updateSfPayment as jest.Mock;
const usePermissionsMock = usePermissions as jest.Mock;

// ── Helpers ────────────────────────────────────────────────────────────────

function createWrapper(opportunityId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0, staleTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/payment-schedule/${opportunityId}`]}>
        <Routes>
          <Route path="/payment-schedule/:opportunityId" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function scheduleResponse(payments: Array<{ Id?: string; Amount: number; ScheduledDate: string; Paid?: boolean }>) {
  return {
    data: {
      success: true,
      opportunity: {
        Id: '006000000000001',
        Name: 'Acme Grant 2026',
        Amount: payments.reduce((s, p) => s + p.Amount, 0),
        StageName: 'Collecting / In Effect',
      },
      payments,
    },
  };
}

function sfPaymentRecord(overrides: Record<string, any> = {}) {
  return {
    Id: 'a0x000000000001',
    Name: 'PMT-001',
    npe01__Opportunity__c: '006000000000001',
    npe01__Payment_Amount__c: 5000,
    npe01__Scheduled_Date__c: '2026-05-15',
    npe01__Payment_Date__c: null,
    npe01__Paid__c: false,
    npe01__Payment_Method__c: 'ACH',
    npe01__Check_Reference_Number__c: null,
    Amount_Received__c: null,
    Department__c: null,
    GL_Account__c: null,
    Batch_Name__c: null,
    Reconciled_with_Finance__c: false,
    Payment_Estimate__c: false,
    npe01__Written_Off__c: false,
    Write_off_reason__c: null,
    npe01__Opportunity__r: { Name: 'Acme Grant 2026', Account: { Name: 'Acme Foundation' } },
    Payment_Status__c: 'Scheduled',
    CreatedDate: '2026-04-01T10:00:00Z',
    LastModifiedDate: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  getPaymentSchedule.mockReset();
  getSfOpportunityPayments.mockReset();
  savePaymentSchedule.mockReset();
  updateOpportunityStage.mockReset();
  updateSfPayment.mockReset();
  getSchemaDescribe.mockReset();
  // Default empty picklist response so PaymentEditDialog renders without
  // hitting an unhandled rejection (the picklist fallback branch handles
  // the empty case gracefully).
  getSchemaDescribe.mockResolvedValue({
    data: { sobject: 'npe01__OppPayment__c', fields: [], recordTypes: [] },
  });
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue({
    can: jest.fn().mockReturnValue(true),
    isAdmin: true,
    sfUserId: '005000000000001',
    orgUserId: null,
    isPlatformUnlinked: false,
    profileName: 'Admin',
    permissions: { edit_payments: true },
    loading: false,
    refetch: jest.fn(),
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PaymentSchedule — Edit Details clickthrough', () => {
  it('renders payment rows with retained Salesforce Ids from the schedule response', async () => {
    getPaymentSchedule.mockResolvedValue(
      scheduleResponse([
        { Id: 'a0x000000000001', Amount: 5000, ScheduledDate: '2026-05-15', Paid: false },
        { Id: 'a0x000000000002', Amount: 5000, ScheduledDate: '2026-06-15', Paid: false },
      ]),
    );

    render(<PaymentSchedule />, { wrapper: createWrapper('006000000000001') });

    // Wait for the Opp header to render — signals that the async load resolved
    await waitFor(() => {
      expect(screen.getByText('Acme Grant 2026')).toBeInTheDocument();
    });

    // Both rows render with their Amount values — rows are <input> fields
    // inside the table; find them by the filled numeric value.
    const amountInputs = screen.getAllByPlaceholderText('0.00') as HTMLInputElement[];
    expect(amountInputs).toHaveLength(2);
    expect(amountInputs[0].value).toBe('5000');
    expect(amountInputs[1].value).toBe('5000');

    // Both saved rows expose the Edit Details icon button (they have Salesforce Ids).
    const editButtons = screen.getAllByTitle('Edit payment details');
    expect(editButtons).toHaveLength(2);
  });

  it('opens PaymentEditDialog populated with the fetched SF record when Edit Details is clicked', async () => {
    getPaymentSchedule.mockResolvedValue(
      scheduleResponse([
        { Id: 'a0x000000000001', Amount: 5000, ScheduledDate: '2026-05-15', Paid: false },
      ]),
    );
    // getSfOpportunityPayments returns the full 29-field records array directly
    // (not wrapped) — match backend shape at main.py:713 `return records`.
    getSfOpportunityPayments.mockResolvedValue({
      data: [sfPaymentRecord({ Id: 'a0x000000000001', npe01__Payment_Amount__c: 5000 })],
    });

    render(<PaymentSchedule />, { wrapper: createWrapper('006000000000001') });

    const editBtn = await screen.findByTitle('Edit payment details');
    fireEvent.click(editBtn);

    // PaymentEditDialog opens — its header renders the Payment Name from initialData
    await waitFor(() => {
      expect(screen.getByText('PMT-001')).toBeInTheDocument();
    });

    // The dialog's Payment Amount field shows the value from the fetched SF record
    const amountInput = screen.getByLabelText('Payment Amount') as HTMLInputElement;
    expect(amountInput.value).toBe('5000');

    // The fetch happened with the opp id from the route param
    expect(getSfOpportunityPayments).toHaveBeenCalledWith('006000000000001');
  });

  it('calls getPaymentSchedule again after PaymentEditDialog onSaved fires', async () => {
    getPaymentSchedule.mockResolvedValue(
      scheduleResponse([
        { Id: 'a0x000000000001', Amount: 5000, ScheduledDate: '2026-05-15', Paid: false },
      ]),
    );
    getSfOpportunityPayments.mockResolvedValue({
      data: [sfPaymentRecord({ Id: 'a0x000000000001', npe01__Payment_Amount__c: 5000 })],
    });
    updateSfPayment.mockResolvedValue({ data: { success: true } });

    render(<PaymentSchedule />, { wrapper: createWrapper('006000000000001') });

    // Initial load → 1 call
    await waitFor(() => {
      expect(getPaymentSchedule).toHaveBeenCalledTimes(1);
    });

    // Open the detail dialog
    fireEvent.click(await screen.findByTitle('Edit payment details'));
    await screen.findByText('PMT-001');

    // Change a field to make the save diff non-empty (otherwise the dialog
    // short-circuits with "No changes detected" and still fires onSaved? No —
    // it fires onClose but not onSaved in the no-change path. Need a real diff.)
    const amountInput = screen.getByLabelText('Payment Amount') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '7500' } });

    // Click Save → Confirm in the popover
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    // After save, PaymentSchedule's handleDetailSaved → loadPaymentSchedule()
    // triggers a second getPaymentSchedule call.
    await waitFor(() => {
      expect(updateSfPayment).toHaveBeenCalled();
      expect(getPaymentSchedule).toHaveBeenCalledTimes(2);
    });
  });
});
