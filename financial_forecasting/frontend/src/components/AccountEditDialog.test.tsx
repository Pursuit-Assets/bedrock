/**
 * Unit tests for AccountEditDialog.
 *
 * Lane A in PR #169 added the destructive Delete footer button + onDeleted
 * callback. This test locks down the two-step popover flow: a single click
 * on the footer "Delete" opens the ConfirmSaveButton popover but MUST NOT
 * fire the network call — only the popover's Confirm button does. Parent's
 * onDeleted callback must receive the accountId on success.
 *
 * Mock strategy mirrors PaymentEditDialog.test.tsx:1-150 — apiService methods
 * mocked at module boundary, fresh QueryClient per render, usePermissions
 * via jest.mocked reference.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from 'react-query';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../services/api', () => ({
  apiService: {
    getSchemaDescribe: jest.fn(),
    getUsers: jest.fn(),
    getAccounts: jest.fn(),
    updateAccount: jest.fn(),
    deleteSfAccount: jest.fn(),
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
import AccountEditDialog from './AccountEditDialog';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const getUsers = apiService.getUsers as jest.Mock;
const getAccounts = apiService.getAccounts as jest.Mock;
const deleteSfAccount = apiService.deleteSfAccount as jest.Mock;
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

function defaultPermissions(overrides: Record<string, any> = {}) {
  return {
    can: jest.fn().mockReturnValue(true),
    isAdmin: true,
    sfUserId: '005000000000001',
    orgUserId: null,
    isPlatformUnlinked: false,
    profileName: 'Admin',
    permissions: { edit_accounts: true },
    loading: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

function buildAccount(overrides: Record<string, any> = {}) {
  return {
    Id: '001000000000001',
    Name: 'Acme Foundation',
    Type: null,
    Industry: null,
    AccountSource: null,
    Account_Tier__c: null,
    Company_Size__c: null,
    Phone: null,
    Website: null,
    Active__c: true,
    Description: null,
    BillingStreet: null,
    BillingCity: null,
    BillingState: null,
    BillingPostalCode: null,
    OwnerId: '005000000000001',
    ParentId: null,
    CreatedDate: '2026-04-01T10:00:00Z',
    LastModifiedDate: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

function mockSchemaEmpty() {
  // Minimal describe — no picklist values. Fallback messaging renders but
  // the dialog doesn't crash. The delete path doesn't depend on picklists.
  getSchemaDescribe.mockImplementation(async () => ({
    data: { sobject: 'Account', fields: [], recordTypes: [] },
  }));
}

beforeEach(() => {
  getSchemaDescribe.mockReset();
  getUsers.mockReset();
  getUsers.mockResolvedValue({ data: { data: [] } });
  getAccounts.mockReset();
  getAccounts.mockResolvedValue({ data: { data: [] } });
  deleteSfAccount.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue(defaultPermissions());
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AccountEditDialog — destructive delete', () => {
  it('shows a warning popover before firing deleteSfAccount on confirm', async () => {
    mockSchemaEmpty();
    deleteSfAccount.mockResolvedValue({ data: { success: true } });
    const onDeleted = jest.fn();
    const onClose = jest.fn();

    render(
      <AccountEditDialog
        open
        onClose={onClose}
        onDeleted={onDeleted}
        accountId="001000000000001"
        initialData={buildAccount()}
      />,
      { wrapper: createWrapper() },
    );

    // Click the footer Delete — opens the ConfirmSaveButton popover.
    const footerDelete = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(footerDelete);

    // Destructive warning language surfaces
    await screen.findByText('Delete Account?');
    expect(
      screen.getByText(/This permanently deletes the account from Salesforce/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This cannot be undone/),
    ).toBeInTheDocument();

    // Guard: opening the popover alone has NOT fired the network call.
    expect(deleteSfAccount).not.toHaveBeenCalled();

    // When the popover opens, MUI focus-traps inside it and aria-hides the
    // rest of the dialog. testing-library's getByRole respects that, so the
    // only accessible "Delete" button is now the popover's confirm button.
    const confirmDelete = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmDelete);

    await waitFor(() => {
      expect(deleteSfAccount).toHaveBeenCalledWith('001000000000001');
      expect(onDeleted).toHaveBeenCalledWith('001000000000001');
      expect(onClose).toHaveBeenCalled();
    });
  });
});
