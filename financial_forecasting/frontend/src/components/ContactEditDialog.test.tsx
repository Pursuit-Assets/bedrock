/**
 * Unit tests for ContactEditDialog.
 *
 * Lane A in PR #169 added the destructive Delete footer button + onDeleted
 * callback on the Details tab. This test locks down the two-step popover
 * flow: click footer Delete → popover opens (no network call yet) → click
 * Confirm → deleteSfContact fires + parent's onDeleted callback receives
 * the contactId.
 *
 * Mock strategy mirrors PaymentEditDialog.test.tsx:1-150.
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
    updateContact: jest.fn(),
    deleteSfContact: jest.fn(),
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
import ContactEditDialog from './ContactEditDialog';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const getUsers = apiService.getUsers as jest.Mock;
const getAccounts = apiService.getAccounts as jest.Mock;
const deleteSfContact = apiService.deleteSfContact as jest.Mock;
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
    permissions: { edit_contacts: true },
    loading: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

function buildContact(overrides: Record<string, any> = {}) {
  return {
    Id: '003000000000001',
    FirstName: 'Jane',
    LastName: 'Doe',
    Name: 'Jane Doe',
    Email: 'jane@example.org',
    Phone: null,
    Title: null,
    AccountId: '001000000000001',
    Account: { Name: 'Acme Foundation' },
    OwnerId: '005000000000001',
    CreatedDate: '2026-04-01T10:00:00Z',
    LastModifiedDate: '2026-04-01T10:00:00Z',
    ...overrides,
  };
}

function mockSchemaEmpty() {
  getSchemaDescribe.mockImplementation(async () => ({
    data: { sobject: 'Contact', fields: [], recordTypes: [] },
  }));
}

beforeEach(() => {
  getSchemaDescribe.mockReset();
  getUsers.mockReset();
  getUsers.mockResolvedValue({ data: { data: [] } });
  getAccounts.mockReset();
  getAccounts.mockResolvedValue({ data: { data: [] } });
  deleteSfContact.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue(defaultPermissions());
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('ContactEditDialog — destructive delete', () => {
  it('shows a warning popover before firing deleteSfContact on confirm', async () => {
    mockSchemaEmpty();
    deleteSfContact.mockResolvedValue({ data: { success: true } });
    const onDeleted = jest.fn();
    const onClose = jest.fn();

    render(
      <ContactEditDialog
        open
        onClose={onClose}
        onDeleted={onDeleted}
        contactId="003000000000001"
        initialData={buildContact()}
      />,
      { wrapper: createWrapper() },
    );

    // Click the footer Delete — opens the popover.
    const footerDelete = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(footerDelete);

    await screen.findByText('Delete Contact?');
    expect(
      screen.getByText(/This permanently deletes the contact from Salesforce/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This cannot be undone/),
    ).toBeInTheDocument();

    // Guard: opening the popover alone must NOT fire the network call.
    expect(deleteSfContact).not.toHaveBeenCalled();

    // Popover focus-trap means the only accessible "Delete" button now is
    // the popover's confirm button.
    const confirmDelete = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(confirmDelete);

    await waitFor(() => {
      expect(deleteSfContact).toHaveBeenCalledWith('003000000000001');
      expect(onDeleted).toHaveBeenCalledWith('003000000000001');
      expect(onClose).toHaveBeenCalled();
    });
  });
});
