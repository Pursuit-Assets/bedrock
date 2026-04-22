/**
 * Unit tests for PaymentCreateDialog — new in PR #161.
 *
 * PaymentCreateDialog is the "+ Add Payment" dialog stacked on top of the Opp
 * drawer's inline Payment Schedule accordion. It's a minimum-field form
 * (Amount, Scheduled Date, optional Payment Method) that POSTs via
 * apiService.createSfPayment — distinct from PaymentEditDialog's PATCH.
 *
 * Coverage:
 *   1. Renders required fields with a pre-filled opportunity name in the subtitle
 *   2. Form is clean on each open (stale state from a prior create doesn't leak)
 *   3. Save with valid input fires createSfPayment + onCreated with the new id
 *   4. Validation blocks save when Amount ≤ 0 or Scheduled Date is empty
 *   5. Permission gate disables the form + save button when !edit_payments
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from 'react-query';

jest.mock('../services/api', () => ({
  apiService: {
    getSchemaDescribe: jest.fn(),
    createSfPayment: jest.fn(),
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

import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import toast from 'react-hot-toast';
import PaymentCreateDialog from './PaymentCreateDialog';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const createSfPayment = apiService.createSfPayment as jest.Mock;
const usePermissionsMock = usePermissions as jest.Mock;
const mockToast = toast as unknown as jest.Mock & { success: jest.Mock; error: jest.Mock };

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0, staleTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function defaultPermissions(overrides: Record<string, any> = {}) {
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

function renderDialog(props: Partial<React.ComponentProps<typeof PaymentCreateDialog>> = {}) {
  const onClose = jest.fn();
  const onCreated = jest.fn();
  const result = render(
    <PaymentCreateDialog
      open
      onClose={onClose}
      opportunityId="006000000000001"
      opportunityName="Acme Grant 2026"
      onCreated={onCreated}
      {...props}
    />,
    { wrapper: createWrapper() },
  );
  return { onClose, onCreated, ...result };
}

beforeEach(() => {
  getSchemaDescribe.mockReset();
  // Default: Payment Method picklist returns a couple of active values so the
  // editable branch renders (avoids the fallback noise unless a test asks).
  getSchemaDescribe.mockResolvedValue({
    data: {
      sobject: 'npe01__OppPayment__c',
      fields: [
        {
          name: 'npe01__Payment_Method__c',
          type: 'picklist',
          picklistValues: [
            { value: 'ACH', label: 'ACH', active: true },
            { value: 'Check', label: 'Check', active: true },
          ],
        },
      ],
      recordTypes: [],
    },
  });
  createSfPayment.mockReset();
  mockToast.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue(defaultPermissions());
});

describe('PaymentCreateDialog', () => {
  it('renders Amount + Scheduled Date + Payment Method fields with opp name subtitle', () => {
    renderDialog();

    // Dialog title + opp name subtitle
    expect(screen.getByText('Add Payment')).toBeInTheDocument();
    expect(screen.getByText('Acme Grant 2026')).toBeInTheDocument();

    // Required fields present
    expect(screen.getByLabelText(/^Amount/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Scheduled Date/)).toBeInTheDocument();
    // Payment Method (optional, label without asterisk)
    expect(screen.getByLabelText('Payment Method')).toBeInTheDocument();
  });

  it('resets form state each time the dialog opens', () => {
    // First open: user types an amount and then closes
    const { rerender } = render(
      <PaymentCreateDialog
        open
        onClose={jest.fn()}
        opportunityId="006000000000001"
        opportunityName="Acme Grant 2026"
      />,
      { wrapper: createWrapper() },
    );
    const amount = screen.getByLabelText(/^Amount/) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '1234' } });
    expect(amount.value).toBe('1234');

    // Close + reopen → form should be empty again
    rerender(
      <PaymentCreateDialog
        open={false}
        onClose={jest.fn()}
        opportunityId="006000000000001"
        opportunityName="Acme Grant 2026"
      />,
    );
    rerender(
      <PaymentCreateDialog
        open
        onClose={jest.fn()}
        opportunityId="006000000000001"
        opportunityName="Acme Grant 2026"
      />,
    );
    const amountReopened = screen.getByLabelText(/^Amount/) as HTMLInputElement;
    expect(amountReopened.value).toBe('');
  });

  it('fires createSfPayment and onCreated(id) with the returned payment id', async () => {
    createSfPayment.mockResolvedValue({
      data: { success: true, data: { id: 'a0x000000000099', message: 'Payment created' } },
    });

    const { onCreated } = renderDialog();

    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/^Scheduled Date/), { target: { value: '2026-07-15' } });

    // Save → ConfirmSaveButton popover → Confirm (the confirm label here is "Create")
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const confirmBtn = await screen.findByRole('button', { name: /^Create$/, hidden: false });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(createSfPayment).toHaveBeenCalledTimes(1);
    });
    expect(createSfPayment).toHaveBeenCalledWith({
      opportunity_id: '006000000000001',
      amount: 5000,
      scheduled_date: '2026-07-15',
      payment_method: null,
    });

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('a0x000000000099');
    });
  });

  it('blocks save and surfaces inline validation errors when Amount ≤ 0 or Scheduled Date is empty', async () => {
    renderDialog();

    // Leave amount empty, no scheduled date → click Save → Confirm
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const confirmBtn = await screen.findByRole('button', { name: /^Create$/, hidden: false });
    fireEvent.click(confirmBtn);

    // Validation errors are rendered as helperText
    await screen.findByText(/Amount must be greater than 0/);
    expect(screen.getByText(/Scheduled date is required/)).toBeInTheDocument();
    // And no API call fired
    expect(createSfPayment).not.toHaveBeenCalled();
  });

  it('disables the form + Create button when the user lacks edit_payments permission', () => {
    usePermissionsMock.mockReturnValue(defaultPermissions({
      isAdmin: false,
      can: jest.fn().mockReturnValue(false),
      permissions: {},
    }));

    renderDialog();

    expect(screen.getByLabelText(/^Amount/)).toBeDisabled();
    expect(screen.getByLabelText(/^Scheduled Date/)).toBeDisabled();

    // The Create button (top-level in the dialog's DialogActions) is
    // disabled via ConfirmSaveButton's `disabled` prop.
    const createButtons = screen.getAllByRole('button', { name: 'Create' });
    // The ConfirmSaveButton renders a Button whose disabled state comes
    // from the canEdit check.
    expect(createButtons.some((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    // The permission-denied banner renders at the top of the dialog body
    expect(
      screen.getByText(/You don't have permission to create payments/i),
    ).toBeInTheDocument();
  });
});
