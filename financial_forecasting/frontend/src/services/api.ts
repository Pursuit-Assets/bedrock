/**
 * API service for communicating with the FastAPI backend
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  OpportunityCreatePayload,
  OpportunityUpdatePayload,
  AccountUpdatePayload,
  ContactUpdatePayload,
  PaymentUpdatePayload,
} from '../types/api';
import type {
  ActivityCreatePayload,
  ActivityUpdatePayload,
  ActivityFilterParams,
  ActivitySearchParams,
} from '../types/activity';

/** Request body for POST /api/ai/pipeline-analysis.
 *  Either `days` (preset lookback, 1..365) OR `start`+`end` (YYYY-MM-DD, within
 *  the last 365 days). `days` and start/end are mutually exclusive server-side. */
export interface PipelineAnalysisBody {
  days?: number;
  start?: string;
  end?: string;
  owner_ids?: string[];
}

// Create axios instance with default config
const api: AxiosInstance = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:8000',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Include cookies in requests
});

// ---------------------------------------------------------------------------
// Salesforce session gating
// ---------------------------------------------------------------------------
// All /api/salesforce/* calls wait on a one-time /auth/salesforce/status check
// so that on page load (and after a session-expired retry), every SF request
// carries a freshly-validated cookie. The backend's /auth/salesforce/status
// refreshes the access_token and writes a new sf_tokens cookie when needed;
// awaiting it here lets the browser's cookie jar update before the gated
// request actually goes out.

let _sfReadyPromise: Promise<void> | null = null;

function _runSfStatusCheck(): Promise<void> {
  return api
    .get('/auth/salesforce/status', { _sfSkipRetry: true } as any)
    .then(() => {})
    .catch(() => {});
}

function _ensureSfReady(): Promise<void> {
  if (!_sfReadyPromise) {
    _sfReadyPromise = _runSfStatusCheck();
  }
  return _sfReadyPromise;
}

api.interceptors.request.use(
  async (config) => {
    const url = config.url || '';
    const skip = (config as any)._sfSkipRetry;
    if (url.includes('/api/salesforce/') && !skip) {
      await _ensureSfReady();
    }
    return config;
  },
  (error) => Promise.reject(error)
);

function _isSalesforceSessionError(error: AxiosError): boolean {
  if (error.response?.status !== 500) return false;
  const detail = (error.response?.data as any)?.detail;
  if (typeof detail !== 'string') return false;
  return (
    detail.includes('session expired') ||
    detail.includes('INVALID_SESSION_ID') ||
    detail.includes('re-authentication failed')
  );
}

// If a session error slips past the request-side gate (e.g. token expired
// mid-request), replace the ready-promise with a fresh status-check so any
// concurrent requests await the same refresh rather than stampeding.
function _refreshSalesforceSession(): Promise<void> {
  _sfReadyPromise = _runSfStatusCheck();
  return _sfReadyPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const config = error.config as (typeof error.config & { _sfRetried?: boolean; _sfSkipRetry?: boolean }) | undefined;

    if (
      config &&
      !config._sfRetried &&
      !config._sfSkipRetry &&
      _isSalesforceSessionError(error) &&
      !(config.url || '').includes('/auth/salesforce/status')
    ) {
      config._sfRetried = true;
      try {
        await _refreshSalesforceSession();
        return api.request(config);
      } catch (refreshErr) {
        console.error('Salesforce session refresh failed:', refreshErr);
      }
    }

    if (error.response) {
      const status = error.response.status;
      const detail = (error.response.data as any)?.detail || '';
      if (status === 403 && typeof detail === 'string' && detail.startsWith('Permission denied:')) {
        import('react-hot-toast').then(({ toast }) => {
          toast.error(detail.replace('Permission denied: ', 'You need the ') + ' permission');
        });
      }
      console.error('API Error:', status, error.response.data);
    } else if (error.request) {
      console.error('Network Error:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    return Promise.reject(error);
  }
);

// API methods
export const apiService = {
  // Health checks
  healthCheck: () => api.get('/health'),
  servicesHealth: () => api.get('/health/services'),

  // Salesforce - Opportunities
  getOpportunities: (params?: { stage?: string; stages?: readonly string[]; limit?: number; record_type?: string; opp_type?: string; active_only?: boolean }) =>
    api.get('/api/salesforce/opportunities', {
      params,
      paramsSerializer: (p: Record<string, string | string[] | number | boolean | undefined | null>) => {
        const sp = new URLSearchParams();
        Object.entries(p).forEach(([k, v]) => {
          if (Array.isArray(v)) v.forEach(i => sp.append(k, i));
          else if (v !== undefined && v !== null) sp.append(k, String(v));
        });
        return sp.toString();
      },
    }),
  
  getStageHistory: (days: number = 30) =>
    api.get('/api/salesforce/opportunities/stage-history', { params: { days } }),

  getOwnershipHistory: (days: number = 7) =>
    api.get('/api/salesforce/opportunities/ownership-history', { params: { days } }),

  analyzePipeline: (body: PipelineAnalysisBody) =>
    api.post('/api/ai/pipeline-analysis', body),

  // Owner Goals (Wall of Progress)
  getOwnerGoals: (fiscalYear: number) =>
    api.get('/api/owner-goals', { params: { fiscal_year: fiscalYear } }),

  upsertOwnerGoal: (sfUserId: string, payload: { fiscal_year: number; goal_amount: number; notes?: string }) =>
    api.put(`/api/owner-goals/${sfUserId}`, payload),

  deleteOwnerGoal: (sfUserId: string, fiscalYear: number) =>
    api.delete(`/api/owner-goals/${sfUserId}`, { params: { fiscal_year: fiscalYear } }),

  createOpportunity: (data: OpportunityCreatePayload) =>
    api.post('/api/salesforce/opportunities', data),

  updateOpportunity: (opportunityId: string, updates: Record<string, string | number | boolean | null>) =>
    api.put(`/api/salesforce/opportunities/${opportunityId}`, {
      opportunity_id: opportunityId,
      updates,
      reason: 'Updated via Revenue Hub'
    } satisfies OpportunityUpdatePayload),

  bulkUpdateOpportunities: (opportunityIds: string[], updates: Record<string, string | number | boolean | null>) =>
    api.put('/api/salesforce/opportunities/bulk-update', {
      opportunity_ids: opportunityIds,
      updates
    }),

  // Salesforce - Tasks (linked to Opportunities)
  getOpportunityTasks: (opportunityId: string) =>
    api.get(`/api/salesforce/opportunities/${opportunityId}/tasks`),
  
  createTask: (opportunityId: string, taskData: {
    Subject: string;
    Status?: string;
    Priority?: string;
    ActivityDate?: string;
    Description?: string;
    OwnerId?: string;
  }) => api.post(`/api/salesforce/opportunities/${opportunityId}/tasks`, taskData),
  
  updateTask: (taskId: string, updates: {
    Subject?: string;
    Status?: string;
    Priority?: string;
    ActivityDate?: string;
    Description?: string;
    OwnerId?: string;
    WhatId?: string;
  }) => api.put(`/api/salesforce/tasks/${taskId}`, updates),
  
  deleteTask: (taskId: string) =>
    api.delete(`/api/salesforce/tasks/${taskId}`),

  duplicateTask: (taskId: string, whatId?: string) =>
    api.post(`/api/salesforce/tasks/${taskId}/duplicate`, { WhatId: whatId || null }),

  // Salesforce Task Dependencies (stored locally)
  getTaskDependenciesForOpp: (taskIds: string[]) =>
    api.get('/api/salesforce/task-dependencies', { params: { task_ids: taskIds.join(',') } }),
  getTaskDependencies: (taskId: string) =>
    api.get(`/api/salesforce/tasks/${taskId}/dependencies`),
  addTaskDependency: (taskId: string, dependsOnId: string) =>
    api.post(`/api/salesforce/tasks/${taskId}/dependencies`, { depends_on_id: dependsOnId }),
  removeTaskDependency: (depId: string) =>
    api.delete(`/api/salesforce/task-dependencies/${depId}`),

  // Salesforce - Schema Describe (picklist values, field metadata)
  getSchemaDescribe: (sobject: string) =>
    api.get(`/api/salesforce/schema/${sobject}`),

  // Salesforce - Global Search (SOSL cross-entity)
  globalSearch: (q: string, limit?: number, signal?: AbortSignal) =>
    api.get('/api/salesforce/search', { params: { q, limit: limit || 10 }, signal }),

  // Salesforce - Accounts
  getAccounts: (params?: { limit?: number }) =>
    api.get('/api/salesforce/accounts', { params }),

  searchAccounts: (q: string, limit?: number) =>
    api.get('/api/salesforce/accounts/search', { params: { q, limit: limit || 25 } }),

  searchContacts: (q: string, limit?: number) =>
    api.get('/api/salesforce/contacts/search', { params: { q, limit: limit || 25 } }),

  updateAccount: (accountId: string, updates: Record<string, string | number | boolean | null>) =>
    api.put(`/api/salesforce/accounts/${accountId}`, {
      updates,
      reason: 'Updated via Revenue Hub',
    } satisfies AccountUpdatePayload),

  // Sage Intacct Master Data
  getSageCustomers: () =>
    api.get('/api/sage/customers'),

  getSageGLAccounts: () =>
    api.get('/api/sage/gl-accounts'),
  
  getSagePayments: (params?: { limit?: number }) =>
    api.get('/api/sage/payments', { params }),
  
  getSageInvoices: (params?: { limit?: number }) =>
    api.get('/api/sage/invoices', { params }),
  
  getSageExpenses: (params?: { limit?: number }) =>
    api.get('/api/sage/expenses', { params }),

  getSageUnpaidBills: (params?: { limit?: number }) =>
    api.get('/api/sage/unpaid-bills', { params }),

  getSageDepartments: () =>
    api.get('/api/sage/departments'),

  getSageClasses: () =>
    api.get('/api/sage/classes'),

  getSageLocations: () =>
    api.get('/api/sage/locations'),
  
  createAccount: (data: {
    Name: string;
    Type?: string;
    Website?: string;
    Phone?: string;
  }) => api.post('/api/salesforce/accounts', data),

  // Salesforce - Contacts
  getContacts: (params?: { account_id?: string; limit?: number }) =>
    api.get('/api/salesforce/contacts', { params }),
  
  createContact: (data: {
    FirstName?: string;
    LastName: string;
    AccountId: string;
    Title?: string;
    Email?: string;
    Phone?: string;
    Primary_Affiliation__c?: string;
  }) => api.post('/api/salesforce/contacts', data),

  updateContact: (contactId: string, updates: Record<string, string | number | boolean | null>) =>
    api.put(`/api/salesforce/contacts/${contactId}`, {
      updates,
      reason: 'Updated via Revenue Hub',
    } satisfies ContactUpdatePayload),

  // Salesforce - Payments (npe01__OppPayment__c)
  getSfPayments: (params?: { opportunity_id?: string; limit?: number }) =>
    api.get('/api/salesforce/payments', { params }),

  getSfOpportunityPayments: (opportunityId: string) =>
    api.get(`/api/salesforce/opportunities/${opportunityId}/payments`),

  updateSfPayment: (paymentId: string, updates: Record<string, string | number | boolean | null>) =>
    api.put(`/api/salesforce/payments/${paymentId}`, {
      updates,
      reason: 'Updated via Revenue Hub',
    } satisfies PaymentUpdatePayload),

  // Salesforce - Users
  getUsers: (params?: { limit?: number }) =>
    api.get('/api/salesforce/users', { params }),

  // Progress Visibility override was removed 2026-04-21 (BUG-UI-19).
  // The /api/progress-tracking/* routes still exist on the backend but
  // are intentionally left orphaned — to be pruned once we've confirmed
  // no external caller depends on them. Do not re-add client methods;
  // use `apiService.getUsers()` for active SF users instead.

  // Sage Intacct - Invoices
  getInvoices: (params?: { customer_id?: string; limit?: number }) =>
    api.get('/api/intacct/invoices', { params }),
  
  createInvoice: (invoiceData: {
    opportunity_id: string;
    customer_id: string;
    amount: number;
    due_date: string;
    line_items: any[];
    notes?: string;
  }) => api.post('/api/intacct/invoices', invoiceData),

  // Sage Intacct - Payments
  getPayments: (params?: { customer_id?: string; limit?: number }) =>
    api.get('/api/intacct/payments', { params }),
  
  // Cash Flow
  getCashFlowSummary: () =>
    api.get('/api/cashflow/summary'),

  // Forecasting
  getPaymentForecast: (params?: { days_ahead?: number; min_probability?: number }) =>
    api.get('/api/forecasting/payment-forecast', { params }),
  
  getCashFlow: (params?: { months_ahead?: number }) =>
    api.get('/api/forecasting/cash-flow', { params }),
  
  getMetrics: () =>
    api.get('/api/forecasting/metrics'),
  
  generateReport: (params?: { period_days?: number }) =>
    api.post('/api/forecasting/generate-report', null, { params }),

  // Data Sync
  triggerSync: (syncType: 'all' | 'salesforce' | 'intacct' = 'all') =>
    api.post(`/api/sync/trigger?sync_type=${syncType}`),

  // Invoice Matching
  getGrantInvoices: () =>
    api.get('/api/matching/grant-invoices'),
  
  getInvoiceMatches: () =>
    api.get('/api/matching/matches'),
  
  searchOpportunities: (searchTerm: string, limit?: number, invoiceData?: {
    customer_name?: string;
    invoice_amount?: number;
    invoice_date?: string;
  }) =>
    api.get('/api/matching/search-opportunities', { 
      params: { 
        q: searchTerm, 
        limit: limit || 50,
        customer_name: invoiceData?.customer_name || '',
        invoice_amount: invoiceData?.invoice_amount || 0,
        invoice_date: invoiceData?.invoice_date || ''
      } 
    }),
  
  saveInvoiceMatch: (matchData: {
    invoice_id: string;
    opportunity_id: string;
    confidence?: string;
    notes?: string;
    customer_name?: string;
    invoice_amount?: number;
    invoice_date?: string;
  }) => api.post('/api/matching/save-match', matchData),
  
  deleteInvoiceMatch: (invoiceId: string) =>
    api.delete(`/api/matching/delete-match/${invoiceId}`),

  // Slack Integration
  getAccountSlackActivity: (accountName: string, limit: number = 50) =>
    api.get(`/api/slack/account-activity/${encodeURIComponent(accountName)}`, { params: { limit } }),
  
  slackHealthCheck: () =>
    api.get('/api/slack/health'),

  // Fireflies Integration
  getAccountFirefliesMeetings: (accountName: string, limit: number = 20) =>
    api.get(`/api/fireflies/account-meetings/${encodeURIComponent(accountName)}`, { params: { limit } }),
  
  firefliesHealthCheck: () =>
    api.get('/api/fireflies/health'),

  // Gmail Integration
  getAccountGmailActivity: (accountName: string, limit: number = 20) =>
    api.get(`/api/gmail/account-activity/${encodeURIComponent(accountName)}`, { params: { limit } }),

  gmailHealthCheck: () =>
    api.get('/api/gmail/health'),

  // Google Calendar Integration
  getAccountCalendarActivity: (accountName: string, limit: number = 20) =>
    api.get(`/api/calendar/account-activity/${encodeURIComponent(accountName)}`, { params: { limit } }),

  calendarHealthCheck: () =>
    api.get('/api/calendar/health'),

  // My Priorities — tasks and calendar
  getMyTasks: (start?: string, end?: string) =>
    api.get('/api/salesforce/my-tasks', { params: { start, end } }),

  getMyCalendarEvents: (start?: string, end?: string, limit: number = 100, calendar_id?: string) =>
    api.get('/api/calendar/my-events', { params: { start, end, limit, calendar_id } }),

  // Automation Review
  getPendingReviews: () =>
    api.get('/api/automation-review/pending'),

  getAllReviews: () =>
    api.get('/api/automation-review/all'),

  approveReview: (id: string, edits?: any) =>
    api.post(`/api/automation-review/${id}/approve`, edits || {}),

  rejectReview: (id: string, reason?: string) =>
    api.post(`/api/automation-review/${id}/reject`, { reason }),

  submitSlackWebhook: (text: string, channel?: string) =>
    api.post('/api/slack/webhook', { text, channel: channel || 'manual', user_name: 'Bedrock User' }),

  getSlackChannelMessages: (channelName: string, limit: number = 50) =>
    api.get(`/api/slack/channel-messages/${encodeURIComponent(channelName)}`, { params: { limit } }),

  getSlackPipelineUpdates: (limit: number = 50) =>
    api.get('/api/slack/pipeline-updates', { params: { limit } }),

  ingestPipelineUpdates: (limit: number = 20) =>
    api.post('/api/automation-review/ingest-pipeline', null, { params: { limit } }),

  getCalendarConfig: () =>
    api.get('/api/calendar/config'),

  // Google Drive Integration
  getAccountDriveActivity: (accountName: string, limit: number = 20, opportunityName?: string) =>
    api.get(`/api/drive/account-activity/${encodeURIComponent(accountName)}`, {
      params: { limit, ...(opportunityName ? { opportunity_name: opportunityName } : {}) }
    }),

  driveHealthCheck: () =>
    api.get('/api/drive/health'),

  // AI-Powered Activity Intelligence (unified)

  // Payment Schedule Management
  parsePaymentSchedule: (opportunityId: string, data: {
    natural_language_text: string;
    opportunity_amount: number;
  }) =>
    api.post(`/api/opportunities/${opportunityId}/payment-schedule/parse`, data),

  getPaymentSchedule: (opportunityId: string) =>
    api.get(`/api/opportunities/${opportunityId}/payment-schedule`),

  createPaymentSchedule: (opportunityId: string, data: {
    payments: Array<{
      payment_date: string;
      amount: number;
      status: string;
    }>;
  }) =>
    api.post(`/api/opportunities/${opportunityId}/payment-schedule`, data),

  updatePayment: (opportunityId: string, paymentId: string, data: {
    payment_date?: string;
    amount?: number;
    paid?: boolean;
    payment_method?: string;
    received_date?: string;
    notes?: string;
  }) =>
    api.put(`/api/opportunities/${opportunityId}/payment-schedule/${paymentId}`, data),

  deletePayment: (opportunityId: string, paymentId: string) =>
    api.delete(`/api/opportunities/${opportunityId}/payment-schedule/${paymentId}`),

  // Finance Dashboard
  getAwaitingInvoices: () =>
    api.get('/api/finance/awaiting-invoices'),

  getActiveCollections: () =>
    api.get('/api/finance/active-collections'),

  getCompletedGrants: () =>
    api.get('/api/finance/completed'),

  getUnsentInvoices: () =>
    api.get('/api/finance/unsent-invoices'),

  createSageInvoice: (paymentId: string, sendEmail: boolean = false) =>
    api.post('/api/finance/create-invoice', { 
      payment_id: paymentId,
      send_email: sendEmail 
    }),

  sendInvoiceEmail: (salesforceInvoiceId: string) =>
    api.post('/api/finance/send-invoice-email', { 
      salesforce_invoice_id: salesforceInvoiceId 
    }),

  syncInvoiceStatus: () =>
    api.post('/api/finance/sync-invoice-status'),

  // Opportunity Stage Management
  validateStageChange: (opportunityId: string, newStage: string) =>
    api.post('/api/opportunities/validate-stage-change', {
      opportunity_id: opportunityId,
      new_stage: newStage
    }),

  updateOpportunityStage: (opportunityId: string, newStage: string) =>
    api.post('/api/opportunities/update-stage', {
      opportunity_id: opportunityId,
      new_stage: newStage
    }),

  savePaymentSchedule: (opportunityId: string, payments: Array<{amount: number, scheduled_date: string}>) =>
    api.post('/api/opportunities/create-payment-schedule', {
      opportunity_id: opportunityId,
      payments: payments,
      delete_existing: true
    }),

  // Projects (PostgreSQL-backed)
  getProjects: () =>
    api.get('/api/projects'),

  getProject: (projectId: string) =>
    api.get(`/api/projects/${projectId}`),

  createProject: (data: { name: string; description?: string }) =>
    api.post('/api/projects', data),

  updateProject: (projectId: string, data: { name?: string; description?: string }) =>
    api.put(`/api/projects/${projectId}`, data),

  deleteProject: (projectId: string) =>
    api.delete(`/api/projects/${projectId}`),

  getDeletedProjects: () =>
    api.get('/api/projects/trash'),

  restoreProject: (projectId: string) =>
    api.post(`/api/projects/${projectId}/restore`),

  purgeProject: (projectId: string) =>
    api.delete(`/api/projects/${projectId}/purge`),

  linkOpportunity: (projectId: string, data: { opportunity_id: string; role?: string }) =>
    api.post(`/api/projects/${projectId}/opportunities`, data),

  unlinkOpportunity: (projectId: string, opportunityId: string) =>
    api.delete(`/api/projects/${projectId}/opportunities/${opportunityId}`),

  getProjectOpportunities: (projectId: string) =>
    api.get(`/api/projects/${projectId}/opportunities`),

  importProjectData: (projectId: string, data: { workstreams: any[]; replace?: boolean }) =>
    api.post(`/api/projects/${projectId}/import`, data),

  // Project ownership & contributors (M19)
  getProjectUsers: () =>
    api.get('/api/projects/users'),

  addProjectContributor: (projectId: string, data: { user_email: string }) =>
    api.post(`/api/projects/${projectId}/contributors`, data),

  removeProjectContributor: (projectId: string, userEmail: string) =>
    api.delete(`/api/projects/${projectId}/contributors/${encodeURIComponent(userEmail)}`),

  transferProjectOwnership: (projectId: string, data: { new_owner_email: string }) =>
    api.put(`/api/projects/${projectId}/owner`, data),

  createWorkstream: (projectId: string, data: { name: string; description?: string; sort_order?: number }) =>
    api.post(`/api/projects/${projectId}/workstreams`, data),

  updateWorkstream: (workstreamId: string, data: { name?: string; description?: string; sort_order?: number }) =>
    api.put(`/api/workstreams/${workstreamId}`, data),

  deleteWorkstream: (workstreamId: string) =>
    api.delete(`/api/workstreams/${workstreamId}`),

  createMilestone: (workstreamId: string, data: { title: string; status?: string; priority?: string; owner?: string; description?: string }) =>
    api.post(`/api/workstreams/${workstreamId}/milestones`, data),

  updateMilestone: (milestoneId: string, data: { title?: string; status?: string; priority?: string; owner?: string; description?: string }) =>
    api.put(`/api/milestones/${milestoneId}`, data),

  deleteMilestone: (milestoneId: string) =>
    api.delete(`/api/milestones/${milestoneId}`),

  createProjectTask: (milestoneId: string, data: { title: string; status?: string; owner?: string; deadline?: string; start_date?: string; description?: string }) =>
    api.post(`/api/milestones/${milestoneId}/tasks`, data),

  updateProjectTask: (taskId: string, data: { title?: string; status?: string; owner?: string; deadline?: string; start_date?: string; description?: string; updates?: string }) =>
    api.put(`/api/project-tasks/${taskId}`, data),

  deleteProjectTask: (taskId: string) =>
    api.delete(`/api/project-tasks/${taskId}`),

  // Salesforce Task ↔ Project Bridge
  linkSfTaskToProject: (projectId: string, data: { sf_task_id: string; milestone_id?: string; sort_order?: number }) =>
    api.post(`/api/projects/${projectId}/sf-tasks`, data),
  unlinkSfTaskFromProject: (linkId: string) =>
    api.delete(`/api/sf-task-project/${linkId}`),
  getProjectSfTasks: (projectId: string) =>
    api.get(`/api/projects/${projectId}/sf-tasks`),
  getProjectByOpportunity: (opportunityId: string) =>
    api.get(`/api/projects/by-opportunity/${opportunityId}`),
  getSfTaskProjectLink: (sfTaskId: string) =>
    api.get(`/api/sf-task-project/by-task/${sfTaskId}`),

  // Activities (M10 backend — CRUD, search, sync, insights)
  getActivities: (params?: ActivityFilterParams) =>
    api.get('/api/activities', { params }),
  getActivity: (id: string) =>
    api.get(`/api/activities/${id}`),
  createActivity: (data: ActivityCreatePayload) =>
    api.post('/api/activities', data),
  updateActivity: (id: string, data: ActivityUpdatePayload) =>
    api.put(`/api/activities/${id}`, data),
  deleteActivity: (id: string) =>
    api.delete(`/api/activities/${id}`),
  searchActivities: (params: ActivitySearchParams) =>
    api.get('/api/activities/search', { params }),
  activitySyncCount: () =>
    api.post('/api/activities/sync/count'),
  activitySyncTrigger: () =>
    api.post('/api/activities/sync/trigger'),
  activitySyncStatus: () =>
    api.get('/api/activities/sync/status'),
  activityMatchContext: (params: { email?: string; name?: string }) =>
    api.get('/api/activities/match-context', { params }),
  activityInsights: (params: { opportunity_id?: string; account_id?: string }) =>
    api.post('/api/activities/insights', null, { params }),

  // Cache Management
  clearCache: () =>
    api.post('/api/cache/clear'),

  // Permissions & Roles
  getMyPermissions: () =>
    api.get('/api/permissions/me'),
  getPermissionProfiles: () =>
    api.get('/api/permissions/profiles'),
  getPermissionProfile: (profileId: string) =>
    api.get(`/api/permissions/profiles/${profileId}`),
  createPermissionProfile: (data: { name: string; description?: string; is_default?: boolean; permissions: Record<string, boolean> }) =>
    api.post('/api/permissions/profiles', data),
  updatePermissionProfile: (profileId: string, data: { name?: string; description?: string; is_default?: boolean; permissions?: Record<string, boolean> }) =>
    api.put(`/api/permissions/profiles/${profileId}`, data),
  deletePermissionProfile: (profileId: string) =>
    api.delete(`/api/permissions/profiles/${profileId}`),
  getAppUsers: () =>
    api.get('/api/permissions/users'),
  updateAppUser: (userId: string, data: { profile_id?: string; sf_user_id?: string; name?: string; is_active?: boolean }) =>
    api.put(`/api/permissions/users/${userId}`, data),

  // Permission unlock requests
  createUnlockRequest: (data: { profile_id: string; permission_key: string }) =>
    api.post('/api/permissions/unlock-requests', data),
  getUnlockRequests: (params?: { status?: string }) =>
    api.get('/api/permissions/unlock-requests', { params }),
  approveUnlockRequest: (id: string) =>
    api.post(`/api/permissions/unlock-requests/${id}/approve`),
  rejectUnlockRequest: (id: string, note?: string) =>
    api.post(`/api/permissions/unlock-requests/${id}/reject`, { admin_note: note || '' }),

  // Opportunity Locks
  getOpportunityLocks: () =>
    api.get('/api/opportunities/locks'),
  lockOpportunity: (opportunityId: string, ownerId: string) =>
    api.post(`/api/opportunities/${opportunityId}/lock`, { owner_id: ownerId }),
  unlockOpportunity: (opportunityId: string) =>
    api.delete(`/api/opportunities/${opportunityId}/lock`),

  // Authentication
  getCurrentUser: () =>
    api.get('/auth/me'),
  
  logout: () =>
    api.post('/auth/logout'),

  // Salesforce OAuth
  getSalesforceStatus: () =>
    api.get('/auth/salesforce/status'),
  
  disconnectSalesforce: () =>
    api.post('/auth/salesforce/disconnect'),

  // Prospect Import
  prospectImportPreview: (csvText: string) =>
    api.post('/api/prospect-import/preview', { csv_text: csvText }),

  prospectImportParse: (csvText: string, columnMapping: Record<string, string | string[] | undefined>, filename?: string) =>
    api.post('/api/prospect-import/parse', {
      csv_text: csvText,
      column_mapping: columnMapping,
      filename: filename || 'import.csv',
    }),

  prospectImportGetPersons: (sessionId?: string) =>
    api.get('/api/prospect-import/persons', { params: sessionId ? { session_id: sessionId } : {} }),

  prospectImportWriteToCrm: (sessionId?: string) =>
    api.post('/api/prospect-import/write-to-crm', { session_id: sessionId }),
};

// Export axios instance for custom requests
export default api;
