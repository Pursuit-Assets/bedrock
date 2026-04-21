/**
 * Unit tests for PaymentEditDialog.
 *
 * First tests for this component — it was orphan (defined but not imported
 * anywhere in the frontend) until PR #159 wired it up as the clickthrough
 * from PaymentSchedule.tsx.
 *
 * Mock strategy:
 * - apiService methods mocked at module boundary
 * - usePermissions hook mocked per-test via jest.mocked reference
 * - react-hot-toast default export mocked to capture invocations
 * - Fresh QueryClient per render (retry: false, cacheTime: 0, staleTime: 0)
 *   so useSchemaPicklist and useQueryClient don't leak state between cases
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from 'react-query';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../services/api', () => ({
  apiService: {
    getSchemaDescribe: jest.fn(),
    updateSfPayment: jest.fn(),
    deleteSfPayment: jest.fn(),
  },
}));

jest.mock('../contexts/PermissionsContext', () => ({
  usePermissions: jest.fn(),
}));

jest.mock('react-hot-toast', () => {
  const fn: any = jest.fn();
  fn.success = jest.fn();
  fn.error = jest.fn();
  return { __esModule: true, default: fn };
});

// Import after jest.mock calls so the mocks are registered first.
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import toast from 'react-hot-toast';
import PaymentEditDialog from './PaymentEditDialog';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const updateSfPayment = apiService.updateSfPayment as jest.Mock;
const deleteSfPayment = apiService.deleteSfPayment as jest.Mock;
const usePermissionsMock = usePermissions as jest.Mock;
const mockToast = toast as unknown as jest.Mock & { success: jest.Mock; error: jest.Mock };

// ── Helpers ────────────────────────────────────────────────────────────────

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0, staleTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function buildInitialData(overrides: Record<string, any> = {}) {
  return {
    Id: 'a0x000000000001',
    Name: 'PMT-001',
    npe01__Opportunity__c: '006000000000001',
    npe01__Payment_Amount__c: 100,
    npe01__Scheduled_Date__c: '2026-05-01',
    npe01__Payment_Date__c: null,
    npe01__Paid__c: false,
    npe01__Payment_Method__c: null,
    npe01__Check_Reference_Number__c: null,
    Amount_Received__c: null,
    Department__c: null,
    GL_Account__c: null,
    Batch_Name__c: null,
    npe01__Written_Off__c: false,
    Write_off_reason__c: null,
    Payment_Status__c: 'Scheduled',
    npe01__Opportunity__r: { Name: 'Acme Grant 2026', Account: { Name: 'Acme Foundation' } },
    CreatedDate: '2026-04-01T10:00:00Z',
    LastModifiedDate: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

function defaultPermissionsResult(overrides: Record<string, any> = {}) {
  return {
    can: jest.fn().mockReturnValue(true),
    isAdmin: true,
    sfUserId: '005000000000001',
    orgUserId: null,
    isPlatformUnlinked: false,
    profileName: 'Admin',
    permissions: { edit_payments: true },
    loading: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

/** Respond with a schema describe where every requested field has the shape the test wants. */
function mockSchemaWith(paymentMethods: Array<{ value: string; active: boolean }> = []) {
  getSchemaDescribe.mockImplementation(async () => ({
    data: {
      sobject: 'npe01__OppPayment__c',
      fields: [
        {
          name: 'npe01__Payment_Method__c',
          type: 'picklist',
          picklistValues: paymentMethods.map((pm) => ({ value: pm.value, label: pm.value, active: pm.active })),
        },
        { name: 'Department__c', type: 'picklist', picklistValues: [] },
        { name: 'GL_Account__c', type: 'picklist', picklistValues: [] },
      ],
      recordTypes: [],
    },
  }));
}

beforeEach(() => {
  getSchemaDescribe.mockReset();
  updateSfPayment.mockReset();
  deleteSfPayment.mockReset();
  mockToast.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue(defaultPermissionsResult());
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PaymentEditDialog', () => {
  it('renders key fields populated from initialData', async () => {
    mockSchemaWith([{ value: 'ACH', active: true }, { value: 'Check', active: true }]);

    render(
      <PaymentEditDialog
        open
        onClose={jest.fn()}
        paymentId="a0x000000000001"
        initialData={buildInitialData({
          npe01__Payment_Amount__c: 2500,
          npe01__Payment_Method__c: 'Check',
          npe01__Check_Reference_Number__c: 'CHK-777',
          Batch_Name__c: 'April Batch',
        })}
      />,
      { wrapper: createWrapper() },
    );

    // Header shows the Payment number from initialData.Name
    expect(screen.getByText('PMT-001')).toBeInTheDocument();

    // Amount renders its initial value
    const amountInput = screen.getByLabelText('Payment Amount') as HTMLInputElement;
    expect(amountInput.value).toBe('2500');

    // Scheduled Date renders its ISO value
    const scheduledInput = screen.getByLabelText('Scheduled Date') as HTMLInputElement;
    expect(scheduledInput.value).toBe('2026-05-01');

    // Check / Reference # is populated
    const checkRef = screen.getByLabelText('Check/Reference #') as HTMLInputElement;
    expect(checkRef.value).toBe('CHK-777');

    // Batch Name is populated
    const batchName = screen.getByLabelText('Batch Name') as HTMLInputElement;
    expect(batchName.value).toBe('April Batch');

    // Relationship section shows Opportunity + Account names from the join
    expect(screen.getByText(/Acme Grant 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Foundation/)).toBeInTheDocument();
  });

  it('populates Payment Method select from useSchemaPicklist when schema resolves with active values', async () => {
    mockSchemaWith([
      { value: 'ACH', active: true },
      { value: 'Check', active: true },
      { value: 'Benevity', active: true },
      { value: 'LegacyMethod', active: false }, // inactive — should be filtered out
    ]);

    render(
      <PaymentEditDialog
        open
        onClose={jest.fn()}
        paymentId="a0x000000000001"
        initialData={buildInitialData({ npe01__Payment_Method__c: 'Check' })}
      />,
      { wrapper: createWrapper() },
    );

    // Wait for the hook to resolve; the editable TextField should be present (not the disabled fallback)
    await waitFor(() => {
      expect(screen.queryByText(/Payment Method list unavailable/)).not.toBeInTheDocument();
      expect(screen.queryByText(/No active payment methods/)).not.toBeInTheDocument();
    });

    // Open the select; verify active options render and inactive ones don't
    const select = screen.getByLabelText('Payment Method');
    fireEvent.mouseDown(select);

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('ACH')).toBeInTheDocument();
    expect(within(listbox).getByText('Check')).toBeInTheDocument();
    expect(within(listbox).getByText('Benevity')).toBeInTheDocument();
    expect(within(listbox).queryByText('LegacyMethod')).not.toBeInTheDocument();
  });

  it('falls back to disabled Payment Method with distinguished helper text (error vs empty)', async () => {
    // Case A: schema describe rejects → "Payment Method list unavailable"
    getSchemaDescribe.mockRejectedValue(new Error('SF schema 500'));

    const { unmount } = render(
      <PaymentEditDialog
        open
        onClose={jest.fn()}
        paymentId="a0x000000000001"
        initialData={buildInitialData({ npe01__Payment_Method__c: 'Check' })}
      />,
      { wrapper: createWrapper() },
    );

    await waitFor(
      () => {
        expect(screen.getByText('Payment Method list unavailable')).toBeInTheDocument();
      },
      { timeout: 5000 }, // hook retries once with ~1s backoff
    );

    // The disabled TextField still shows the stored value so the user sees their data
    const disabledField = screen.getByLabelText('Payment Method') as HTMLInputElement;
    expect(disabledField.value).toBe('Check');
    expect(disabledField).toBeDisabled();

    unmount();

    // Case B: schema resolves but picklist has no active values → "No active payment methods available"
    getSchemaDescribe.mockReset();
    getSchemaDescribe.mockImplementation(async () => ({
      data: {
        sobject: 'npe01__OppPayment__c',
        fields: [
          {
            name: 'npe01__Payment_Method__c',
            type: 'picklist',
            picklistValues: [{ value: 'Deprecated', label: 'Deprecated', active: false }],
          },
          { name: 'Department__c', type: 'picklist', picklistValues: [] },
          { name: 'GL_Account__c', type: 'picklist', picklistValues: [] },
        ],
        recordTypes: [],
      },
    }));

    render(
      <PaymentEditDialog
        open
        onClose={jest.fn()}
        paymentId="a0x000000000001"
        initialData={buildInitialData({ npe01__Payment_Method__c: 'Check' })}
      />,
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(screen.getByText('No active payment methods available')).toBeInTheDocument();
    });
    // And the error helper text is NOT shown
    expect(screen.queryByText('Payment Method list unavailable')).not.toBeInTheDocument();
  });

  it('fires updateSfPayment with diffed updates on Save → Confirm', async () => {
    mockSchemaWith([{ value: 'ACH', active: true }]);
    updateSfPayment.mockResolvedValue({ data: { success: true } });
    const onSaved = jest.fn();
    const onClose = jest.fn();

    render(
      <PaymentEditDialog
        open
        onClose={onClose}
        onSaved={onSaved}
        paymentId="a0x000000000001"
        initialData={buildInitialData({ npe01__Payment_Amount__c: 100 })}
      />,
      { wrapper: createWrapper() },
    );

    // Change Amount from 100 → 500
    const amountInput = screen.getByLabelText('Payment Amount') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '500' } });
    expect(amountInput.value).toBe('500');

    // Click Save → popover opens → click Confirm
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(updateSfPayment).toHaveBeenCalledTimes(1);
    });

    // Only the changed field should be sent, with numeric parsing applied
    expect(updateSfPayment).toHaveBeenCalledWith('a0x000000000001', {
      npe01__Payment_Amount__c: 500,
    });

    // Post-save callbacks fire
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith('a0x000000000001', { npe01__Payment_Amount__c: 500 });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows "No changes detected" toast and closes when Save is triggered with an unmodified form', async () => {
    mockSchemaWith([{ value: 'ACH', active: true }]);
    const onClose = jest.fn();

    render(
      <PaymentEditDialog
        open
        onClose={onClose}
        paymentId="a0x000000000001"
        initialData={buildInitialData()}
      />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith('No changes detected');
      expect(onClose).toHaveBeenCalled();
    });
    // No API call made when there are no changes
    expect(updateSfPayment).not.toHaveBeenCalled();
  });

  it('shows a destructive warning popover before firing deleteSfPayment on confirm', async () => {
    mockSchemaWith([{ value: 'ACH', active: true }]);
    deleteSfPayment.mockResolvedValue({ data: { success: true } });
    const onDeleted = jest.fn();
    const onClose = jest.fn();

    render(
      <PaymentEditDialog
        open
        onClose={onClose}
        onDeleted={onDeleted}
        paymentId="a0x000000000001"
        initialData={buildInitialData()}
      />,
      { wrapper: createWrapper() },
    );

    // Only one "Delete" button exists initially (popover closed). Click it
    // to open the ConfirmSaveButton popover — it does NOT fire the delete
    // directly; user must confirm in the popover.
    const footerDelete = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(footerDelete);

    // Destructive warning language surfaces in the popover
    await screen.findByText('Delete Payment?');
    expect(
      screen.getByText(/This permanently deletes the payment from Salesforce/),
    ).toBeInTheDocument();
    // Irreversibility is called out in the message
    expect(
      screen.getByText(/This cannot be undone/),
    ).toBeInTheDocument();

    // Guard: opening the popover alone has NOT fired the network call
    expect(deleteSfPayment).not.toHaveBeenCalled();

    // When the popover opens, MUI focus-traps inside it and aria-hides the
    // rest of the dialog. testing-library's getByRole respects that, so the
    // only accessible "Delete" button is now the popover's confirm button.
    const confirmDelete = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmDelete);

    await waitFor(() => {
      expect(deleteSfPayment).toHaveBeenCalledWith('a0x000000000001');
      expect(onDeleted).toHaveBeenCalledWith('a0x000000000001');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('hides the Delete button when the user lacks edit_payments permission', async () => {
    mockSchemaWith([{ value: 'ACH', active: true }]);
    usePermissionsMock.mockReturnValue(defaultPermissionsResult({
      isAdmin: false,
      can: jest.fn().mockReturnValue(false),
      permissions: {},
    }));

    render(
      <PaymentEditDialog
        open
        onClose={jest.fn()}
        paymentId="a0x000000000001"
        initialData={buildInitialData()}
      />,
      { wrapper: createWrapper() },
    );

    // Wait for the "no permission" banner (a proxy for full render)
    await screen.findByText(/You don't have permission to edit payments/i);
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('disables every editable field when the user has no edit_payments permission', async () => {
    mockSchemaWith([{ value: 'ACH', active: true }, { value: 'Check', active: true }]);
    usePermissionsMock.mockReturnValue(defaultPermissionsResult({
      isAdmin: false,
      can: jest.fn().mockReturnValue(false),
      permissions: {},
    }));

    render(
      <PaymentEditDialog
        open
        onClose={jest.fn()}
        paymentId="a0x000000000001"
        initialData={buildInitialData({ npe01__Payment_Method__c: 'Check' })}
      />,
      { wrapper: createWrapper() },
    );

    // The "no permission" banner renders at the top of the dialog
    expect(
      screen.getByText(/You don't have permission to edit payments/i),
    ).toBeInTheDocument();

    // Representative editable fields are all disabled
    expect(screen.getByLabelText('Payment Amount')).toBeDisabled();
    expect(screen.getByLabelText('Scheduled Date')).toBeDisabled();
    expect(screen.getByLabelText('Payment Date')).toBeDisabled();
    expect(screen.getByLabelText('Check/Reference #')).toBeDisabled();
    expect(screen.getByLabelText('Amount Received')).toBeDisabled();
    expect(screen.getByLabelText('Batch Name')).toBeDisabled();
    expect(screen.getByLabelText('Write-Off Notes')).toBeDisabled();

    // Wait for the schema hook to settle so the Payment Method renders its
    // editable branch (with disabled={!canEdit}). Without waiting we might
    // catch the hook mid-load and see the fallback branch instead.
    await waitFor(() => {
      expect(screen.getByLabelText('Payment Method')).toBeDisabled();
    });
  });
});
