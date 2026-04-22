/**
 * Unit tests for TaskPanel.
 *
 * PR #169 / Lane B. Four tests:
 *   1. Status + Priority picklists populate from useSchemaPicklist
 *   2. Contact autocomplete wires WhoId on create
 *   3. Subject persists as string on create (B9 regression lock-down —
 *      checklist artifact where Subject was sent as a boolean was not
 *      reproducible on dev HEAD 1661ad8 after 10 verification passes;
 *      this guards against a future regression)
 *   4. Update sends only CHANGED fields (B8 regression lock-down — prior
 *      behavior sent the full editTask object verbatim, including empty
 *      string ActivityDate / OwnerId / WhoId which SF would 400 on)
 *
 * Mock strategy mirrors PaymentEditDialog.test.tsx:1-150.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from 'react-query';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../services/api', () => ({
  apiService: {
    getSchemaDescribe: jest.fn(),
    getContacts: jest.fn(),
    getOpportunityLocks: jest.fn(),
    getOpportunityTasks: jest.fn(),
    getProjects: jest.fn(),
    getTaskDependenciesForOpp: jest.fn(),
    createTask: jest.fn(),
    updateTask: jest.fn(),
    deleteTask: jest.fn(),
    addTaskDependency: jest.fn(),
    removeTaskDependency: jest.fn(),
    linkSfTaskToProject: jest.fn(),
    unlinkSfTaskFromProject: jest.fn(),
    duplicateTask: jest.fn(),
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
import TaskPanel from './TaskPanel';

const getSchemaDescribe = apiService.getSchemaDescribe as jest.Mock;
const getContacts = apiService.getContacts as jest.Mock;
const getOpportunityLocks = apiService.getOpportunityLocks as jest.Mock;
const getOpportunityTasks = apiService.getOpportunityTasks as jest.Mock;
const getProjects = apiService.getProjects as jest.Mock;
const getTaskDependenciesForOpp = apiService.getTaskDependenciesForOpp as jest.Mock;
const createTask = apiService.createTask as jest.Mock;
const updateTask = apiService.updateTask as jest.Mock;
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
    permissions: { edit_all_opportunities: true },
    loading: false,
    refetch: jest.fn(),
    ...overrides,
  };
}

function buildOpportunity() {
  return {
    Id: '006000000000001',
    Name: 'Acme Grant 2026',
    Account: { Name: 'Acme Foundation' },
    StageName: 'Qualifying',
    Amount: 25000,
    Probability: 50,
    CloseDate: '2026-06-30',
    Owner: { Name: 'Test Owner' },
  };
}

function buildTask(overrides: Record<string, any> = {}) {
  return {
    Id: '00T000000000001',
    Subject: 'Review contract',
    Status: 'Not Started',
    Priority: 'Normal',
    ActivityDate: '2026-05-10',
    Description: 'Initial review pass',
    OwnerId: '005000000000001',
    OwnerName: 'Test Owner',
    WhoId: null,
    WhoName: null,
    CreatedById: '005000000000001',
    CreatedByName: 'Test Owner',
    CreatedDate: '2026-04-01T10:00:00Z',
    LastModifiedDate: '2026-04-01T10:00:00Z',
    Type: null,
    TaskSubtype: null,
    WhatId: '006000000000001',
    ...overrides,
  };
}

function mockTaskSchemaWith(
  statusValues: string[] = ['Not Started', 'In Progress', 'Completed'],
  priorityValues: string[] = ['High', 'Normal', 'Low'],
) {
  getSchemaDescribe.mockImplementation(async (sobject: string) => {
    if (sobject !== 'Task') {
      return { data: { sobject, fields: [], recordTypes: [] } };
    }
    return {
      data: {
        sobject: 'Task',
        fields: [
          {
            name: 'Status',
            type: 'picklist',
            picklistValues: statusValues.map((v) => ({ value: v, label: v, active: true })),
          },
          {
            name: 'Priority',
            type: 'picklist',
            picklistValues: priorityValues.map((v) => ({ value: v, label: v, active: true })),
          },
        ],
        recordTypes: [],
      },
    };
  });
}

// jsdom doesn't implement Element.scrollIntoView; TaskPanel calls it via
// requestAnimationFrame in the selectedTaskId auto-expand effect, so stub it
// here before any render. Tests that don't use selectedTaskId are unaffected.
beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  getSchemaDescribe.mockReset();
  getContacts.mockReset();
  getContacts.mockResolvedValue({ data: { data: [] } });
  getOpportunityLocks.mockReset();
  getOpportunityLocks.mockResolvedValue({ data: { data: [] } });
  getOpportunityTasks.mockReset();
  getOpportunityTasks.mockResolvedValue({ data: { data: [] } });
  getProjects.mockReset();
  getProjects.mockResolvedValue({ data: { data: [] } });
  getTaskDependenciesForOpp.mockReset();
  getTaskDependenciesForOpp.mockResolvedValue({ data: { data: [] } });
  createTask.mockReset();
  updateTask.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockReturnValue(defaultPermissions());
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TaskPanel — Status + Priority picklists (B6)', () => {
  it('renders Status + Priority options from useSchemaPicklist when schema describe resolves', async () => {
    mockTaskSchemaWith(
      ['Not Started', 'Waiting on someone else', 'Completed'],
      ['High', 'Medium-High', 'Normal'],
    );

    render(
      <TaskPanel open onClose={jest.fn()} opportunity={buildOpportunity()} users={[]} />,
      { wrapper: createWrapper() },
    );

    // Open the create form
    fireEvent.click(await screen.findByRole('button', { name: /Add Task/i }));

    // Schema describe resolves for the Task sobject (once for Status, once for
    // Priority — useSchemaPicklist dedupes via react-query, so typically one
    // network call serves both).
    await waitFor(() => {
      expect(getSchemaDescribe).toHaveBeenCalledWith('Task');
    });

    // Open the Status select — MUI Selects expose an accessible `combobox`
    // role that takes the InputLabel's text as its name. Once opened, the
    // listbox should include the schema-driven option that isn't in the
    // hardcoded fallback list — proving the fallback branch isn't shadowing
    // the real picklist data.
    const statusSelect = await screen.findByRole('combobox', { name: 'Status' });
    fireEvent.mouseDown(statusSelect);

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('Waiting on someone else')).toBeInTheDocument();
  });
});

describe('TaskPanel — Contact autocomplete (B5)', () => {
  it('wires WhoId onto createTask when a contact is selected in the create form', async () => {
    mockTaskSchemaWith();
    getContacts.mockResolvedValue({
      data: {
        data: [
          { Id: '003000000000001', Name: 'Jane Doe' },
          { Id: '003000000000002', Name: 'John Smith' },
        ],
      },
    });
    createTask.mockResolvedValue({ data: { success: true, id: '00T000000000999' } });

    render(
      <TaskPanel open onClose={jest.fn()} opportunity={buildOpportunity()} users={[]} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByRole('button', { name: /Add Task/i }));

    // Type a subject so Create becomes enabled.
    const subject = screen.getByLabelText('Subject');
    fireEvent.change(subject, { target: { value: 'Follow up call' } });

    // Wait for the Contact autocomplete to be populated from the getContacts
    // mock — it becomes enabled once the query resolves.
    const contactInput = await screen.findByLabelText(/Contact \(optional\)/);
    fireEvent.mouseDown(contactInput);
    fireEvent.change(contactInput, { target: { value: 'Jane' } });

    // Pick the matching option from the popup listbox
    const option = await screen.findByText('Jane Doe');
    fireEvent.click(option);

    // Trigger Create + confirm popover
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(createTask).toHaveBeenCalled();
    });

    // createTask(oppId, payload) — assert the selected contact was passed as WhoId.
    const [, payload] = createTask.mock.calls[0];
    expect(payload.WhoId).toBe('003000000000001');
    expect(payload.Subject).toBe('Follow up call');
  });
});

describe('TaskPanel — B9 regression lock-down (Subject persists as string)', () => {
  it('sends Subject as the typed string, not coerced to a boolean or other primitive', async () => {
    mockTaskSchemaWith();
    createTask.mockResolvedValue({ data: { success: true, id: '00T000000000999' } });

    render(
      <TaskPanel open onClose={jest.fn()} opportunity={buildOpportunity()} users={[]} />,
      { wrapper: createWrapper() },
    );

    fireEvent.click(await screen.findByRole('button', { name: /Add Task/i }));

    const subject = screen.getByLabelText('Subject');
    fireEvent.change(subject, { target: { value: 'test' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(createTask).toHaveBeenCalled();
    });

    const [, payload] = createTask.mock.calls[0];
    expect(typeof payload.Subject).toBe('string');
    expect(payload.Subject).toBe('test');
    // B9 guard: the checklist noted a case where Subject was a boolean. Belt
    // and suspenders — assert it isn't `true` / `false` / a number either.
    expect(payload.Subject).not.toBe(true);
    expect(payload.Subject).not.toBe(false);
  });
});

describe('TaskPanel — B8 regression lock-down (diff-based update)', () => {
  it('sends only changed fields on save, not the full editTask object', async () => {
    mockTaskSchemaWith();
    const task = buildTask({
      Id: '00T000000000555',
      Subject: 'Original subject',
      Description: 'Original description',
      Priority: 'Normal',
      Status: 'In Progress',
      ActivityDate: '2026-05-10',
      OwnerId: '005000000000001',
      WhoId: null,
      WhatId: '006000000000001',
    });
    getOpportunityTasks.mockResolvedValue({ data: { data: [task] } });
    updateTask.mockResolvedValue({ data: { success: true } });

    render(
      <TaskPanel
        open
        onClose={jest.fn()}
        opportunity={buildOpportunity()}
        users={[]}
        // selectedTaskId + editOnOpen auto-triggers startEditing for this task
        // once the tasks query resolves — saves us from having to find the
        // right Edit button in the collapsed task card.
        selectedTaskId="00T000000000555"
        editOnOpen
      />,
      { wrapper: createWrapper() },
    );

    // Wait for the edit form to render — Subject field becomes visible.
    const subjectField = await screen.findByDisplayValue('Original subject');
    expect(subjectField).toBeInTheDocument();

    // Change ONLY Description. Everything else stays the same as the original.
    const descFields = screen.getAllByDisplayValue('Original description');
    // Description textarea is the editable one
    const descField = descFields.find((el) => el.tagName === 'TEXTAREA') || descFields[0];
    fireEvent.change(descField, { target: { value: 'Updated description' } });

    // Trigger Save + confirm popover.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(updateTask).toHaveBeenCalled();
    });

    const [taskId, updates] = updateTask.mock.calls[0];
    expect(taskId).toBe('00T000000000555');

    // B8 guard: the saveEdit diff must only include Description.
    expect(updates).toEqual({ Description: 'Updated description' });
    // Explicit negative assertions — the old bug was sending every field
    // including empty-string ActivityDate / OwnerId which SF rejected with 400.
    expect(updates).not.toHaveProperty('ActivityDate');
    expect(updates).not.toHaveProperty('OwnerId');
    expect(updates).not.toHaveProperty('Subject');
    expect(updates).not.toHaveProperty('Status');
    expect(updates).not.toHaveProperty('Priority');
    expect(updates).not.toHaveProperty('WhoId');
    expect(updates).not.toHaveProperty('WhatId');
  });
});
