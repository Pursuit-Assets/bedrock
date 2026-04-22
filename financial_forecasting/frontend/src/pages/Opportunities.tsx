/**
 * Opportunities page — orchestrator component.
 *
 * Wires together sub-components extracted into the Opportunities/ directory:
 *   - useOpportunityData: data fetching, mutations, derived state
 *   - columns:            DataGrid column definitions
 *   - inline-edit/cells:  Domain cells (StageCell, OwnerCell, AccountCell, AmountCell)
 *   - SummaryCards:       metric cards above the grid
 *   - helpers:            pure functions + Opportunity interface
 */
import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Chip,
  CircularProgress,
  Alert,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  Add as AddIcon,
  Check as CheckIcon,
} from '@mui/icons-material';
import { DataGrid, GridToolbar, GridRenderCellParams } from '@mui/x-data-grid';
import toast from 'react-hot-toast';
import { parseISO, differenceInDays, startOfDay } from 'date-fns';

import { apiService } from '../services/api';
import PaymentScheduleModal from '../components/PaymentScheduleModal';
import TaskPanel from '../components/TaskPanel';
import PipelineFilterBar, { PipelineFilters, DEFAULT_FILTERS } from '../components/PipelineFilterBar';
import { OPPORTUNITY_STAGES, OPEN_STAGES, CLOSED_STAGES } from '../types/salesforce';
import type { Opportunity } from './Opportunities/helpers';
import { useOpportunityData, ViewMode, oppQueryKey } from './Opportunities/useOpportunityData';
import { buildPipelineColumns, buildPaymentColumns, ColumnCallbacks } from './Opportunities/columns';
import { SummaryCards } from './Opportunities/SummaryCards';
import OpportunityEditDialog from '../components/OpportunityEditDialog';
import ConfirmSaveButton from '../components/ConfirmSaveButton';
import { usePermissions } from '../contexts/PermissionsContext';
import { useDialogStack } from '../contexts/DialogStackContext';

const Opportunities: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { can, sfUserId } = usePermissions();
  const { pushDialog } = useDialogStack();
  const [searchParams] = useSearchParams();
  const searchFromUrl = searchParams.get('search') || '';

  // View & filter state
  const [viewMode, setViewMode] = useState<ViewMode>('open');
  const [philanthropyOnly, setPhilanthropyOnly] = useState(false);
  const [aijiOnly, setAijiOnly] = useState(false);
  // initialFilter values:
  //   'atRisk'       — set by Dashboard nav: low-prob / early-stage opps in the current quarter.
  //   'stale'        — set by Dashboard nav OR by clicking the Stale Deals card.
  //   'closingMonth' — set by clicking the Closing This Month card.
  const [initialFilter, setInitialFilter] = useState<'atRisk' | 'stale' | 'closingMonth' | null>(null);
  const [dashboardFilterAlert, setDashboardFilterAlert] = useState<string | null>(null);
  const [pipelineFilters, setPipelineFilters] = useState<PipelineFilters>(DEFAULT_FILTERS);

  // Selection & bulk actions
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [bulkActionDialogOpen, setBulkActionDialogOpen] = useState(false);
  const [bulkAction, setBulkAction] = useState<'withdraw' | 'stage' | ''>('');
  const [bulkTargetStage, setBulkTargetStage] = useState('');

  // Edit dialog
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);

  // Payment schedule modal
  const [paymentScheduleOpen, setPaymentScheduleOpen] = useState(false);
  const [paymentScheduleOpp, setPaymentScheduleOpp] = useState<Opportunity | null>(null);

  // Task panel
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [taskPanelOpp, setTaskPanelOpp] = useState<Opportunity | null>(null);

  // Data hook
  const {
    opportunities,
    users,
    accounts,
    accountMap,
    userMap,
    openCount,
    collectingCount,
    closedCount,
    isLoading,
    error,
    updateMutation,
    bulkUpdateMutation,
    queryClient,
    recentlyChangedIds,
    recentlyChangedRef,
    markRecentlyChanged,
    clearRecentlyChanged,
    lockMap,
    lockMutation,
    unlockMutation,
  } = useOpportunityData(viewMode, philanthropyOnly);

  // Handle incoming filter from Dashboard
  useEffect(() => {
    const state = location.state as {
      filterAtRisk?: boolean;
      filterStale?: boolean;
      dashboardFilters?: {
        owners: string[];
        closeDateStart: string;
        closeDateEnd: string;
        source: string;
      };
    } | null;
    if (state) {
      if (state.filterAtRisk) setInitialFilter('atRisk');
      else if (state.filterStale) setInitialFilter('stale');

      if (state.dashboardFilters) {
        const { owners, closeDateStart, closeDateEnd, source } = state.dashboardFilters;
        setPipelineFilters((prev) => ({
          ...prev,
          owners,
          closeDateStart,
          closeDateEnd,
        }));
        setDashboardFilterAlert(source);
      }

      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleBulkAction = (action: 'withdraw' | 'stage') => {
    if (selectedRowIds.length === 0) { toast.error('Please select opportunities first'); return; }
    setBulkAction(action);
    if (action === 'withdraw') setBulkTargetStage('Withdrawn');
    setBulkActionDialogOpen(true);
  };

  const handleBulkActionConfirm = () => {
    const updates = bulkAction === 'withdraw'
      ? { StageName: 'Withdrawn' }
      : bulkTargetStage ? { StageName: bulkTargetStage } : null;
    if (updates) {
      bulkUpdateMutation.mutate({ oppIds: selectedRowIds, updates }, {
        onSuccess: () => {
          setBulkActionDialogOpen(false);
          setSelectedRowIds([]);
          setBulkAction('');
          setBulkTargetStage('');
        },
      });
    }
  };

  const handleCellEdit = async (newRow: any, oldRow: any) => {
    const updates: any = {};
    Object.keys(newRow).forEach((key) => {
      if (newRow[key] !== oldRow[key] && key !== 'Id') {
        if (key === 'CloseDate' && newRow[key] instanceof Date) {
          updates[key] = newRow[key].toISOString().split('T')[0];
        } else if (key !== 'Account' && key !== 'Owner') {
          updates[key] = newRow[key];
        }
      }
    });
    if (Object.keys(updates).length === 0) return newRow;

    const loadingToast = toast.loading('Saving to Salesforce...');
    try {
      await apiService.updateOpportunity(newRow.Id, updates);
      toast.success('Saved!', { id: loadingToast, duration: 2000 });
      setTimeout(() => queryClient.invalidateQueries('opportunities'), 1000);
      return newRow;
    } catch (error: any) {
      toast.error(`Failed: ${error.response?.data?.detail || error.message}`, { id: loadingToast });
      return oldRow;
    }
  };

  /**
   * Stage change handler — special-cased because transitioning to
   * "Collecting / In Effect" navigates the user to the payment-schedule
   * page. Other stages go through the generic optimistic-update path.
   */
  const handleStageChange = (oppId: string, oldStage: string, newStage: string) => {
    if (newStage === oldStage) return;
    const loadingToast = toast.loading('Updating stage...');

    const closedStages = ['Withdrawn', 'Closed Lost', 'Closed / Did not Fulfill', 'Closed / Completed'];
    if (closedStages.includes(newStage)) markRecentlyChanged(oppId);

    if (newStage === 'Collecting / In Effect') {
      toast.dismiss(loadingToast);
      toast('Please review and confirm payment schedule', { icon: '\uD83D\uDCB0', duration: 3000 });
      navigate(`/payment-schedule/${oppId}`, {
        state: { fromStageChange: true, targetStage: newStage, opportunityId: oppId },
      });
      return;
    }

    // Optimistic update — MUST use the exact same key the hook feeds from.
    // Previously this built a 4-element array that didn't match the hook's
    // 2-element (filtered) or string (unfiltered) key, so the optimistic
    // write landed in an orphan cache entry and the UI showed no change
    // until the server round-trip invalidated + refetched.
    const currentQueryKey = oppQueryKey(philanthropyOnly);
    const oldData = queryClient.getQueryData(currentQueryKey);
    queryClient.setQueryData(currentQueryKey, (old: any) =>
      old?.map((opp: any) => (opp.Id === oppId ? { ...opp, StageName: newStage } : opp)),
    );

    apiService.updateOpportunity(oppId, { StageName: newStage })
      .then(() => {
        toast.success('Stage updated!', { id: loadingToast });
        queryClient.invalidateQueries('opportunities');
      })
      .catch((err: any) => {
        queryClient.setQueryData(currentQueryKey, oldData);
        clearRecentlyChanged(oppId);
        toast.error(`Failed: ${err.response?.data?.detail || err.message}`, { id: loadingToast });
      });
  };

  /**
   * Generic per-field save used by the inline-edit domain cells
   * (AccountCell, OwnerCell, AmountCell). Sends a patch, invalidates the
   * cache, and surfaces toasts. Throws on failure so the primitive can
   * surface an error in the cell.
   */
  const handleFieldSave = async (oppId: string, field: string, newValue: any) => {
    const loadingToast = toast.loading('Saving...');
    try {
      await apiService.updateOpportunity(oppId, { [field]: newValue });
      toast.success('Saved!', { id: loadingToast, duration: 2000 });
      // Invalidate immediately — the previous setTimeout(500ms) created a
      // stale-cache window during which downstream consumers (Priorities,
      // NetworkMap, Leads, AutomationReview, Progress, PaymentProcessing,
      // etc.) read pre-mutation data, and rapid sequential edits raced
      // each other's refetch cycles. Mirror handleStageChange's behavior.
      queryClient.invalidateQueries('opportunities');
    } catch (err: any) {
      toast.error(`Failed: ${err.response?.data?.detail || err.message}`, { id: loadingToast });
      throw err;
    }
  };

  // ---------------------------------------------------------------------------
  // Column callbacks & columns (memoized)
  // ---------------------------------------------------------------------------

  const columnCallbacks: ColumnCallbacks = useMemo(() => ({
    onTaskPanelOpen: (opp) => { setTaskPanelOpp(opp); setTaskPanelOpen(true); },
    onStageChange: handleStageChange,
    onSaveField: handleFieldSave,
    accountMap,
    userMap,
    users,
    accounts,
    lockMap,
    onLockToggle: (oppId, ownerId, isLocked) => {
      if (isLocked) unlockMutation.mutate(oppId);
      else lockMutation.mutate({ oppId, ownerId });
    },
    currentSfUserId: sfUserId,
    canLock: can('lock_own_opportunities'),
    onEditDialogOpen: (opp) => { setSelectedOpp(opp); setEditDialogOpen(true); },
  }), [accountMap, userMap, users, accounts, philanthropyOnly, viewMode, lockMap, sfUserId]);

  const pipelineColumns = useMemo(() => buildPipelineColumns(columnCallbacks), [columnCallbacks]);
  const paymentColumns = useMemo(() => buildPaymentColumns(columnCallbacks), [columnCallbacks]);

  // ---------------------------------------------------------------------------
  // Filtered / visible opportunities
  // ---------------------------------------------------------------------------

  const displayOpps = useMemo(() => {
    if (viewMode === 'open') {
      return opportunities.filter((opp) => {
        const isOpen = (OPEN_STAGES as readonly string[]).includes(opp.StageName);
        return isOpen || Boolean(recentlyChangedIds[opp.Id]) || recentlyChangedRef.current.has(opp.Id);
      });
    }
    if (viewMode === 'collecting') {
      return opportunities.filter((opp) => {
        const s = opp.StageName || '';
        return s.includes('Collecting') || s.includes('In Effect');
      });
    }
    return opportunities.filter((opp) => (CLOSED_STAGES as readonly string[]).includes(opp.StageName));
  }, [opportunities, viewMode, recentlyChangedIds]);

  // Apply pipeline filter bar filters
  let visibleOpps = useMemo(() => {
    let filtered = displayOpps;
    const f = pipelineFilters;

    // AIJI toggle — match Campaign name OR Opportunity name
    if (f.aijiOnly) {
      filtered = filtered.filter((opp) => {
        const name = (opp.Name || '').toUpperCase();
        const campaign = ((opp as any).Campaign?.Name || '').toUpperCase();
        return name.includes('AIJI') || name.includes('AI JOBS INSTITUTE')
            || campaign.includes('AIJI') || campaign.includes('AI JOBS INSTITUTE');
      });
    }

    // Owner filter
    if (f.owners.length > 0) {
      filtered = filtered.filter((opp) => f.owners.includes(opp.OwnerId));
    }

    // Stage filter
    if (f.stages.length > 0) {
      filtered = filtered.filter((opp) => f.stages.includes(opp.StageName));
    }

    // Revenue stream (RecordType)
    if (f.revenueStreams.length > 0) {
      filtered = filtered.filter((opp) => opp.RecordType?.Name && f.revenueStreams.includes(opp.RecordType.Name));
    }

    // Amount range
    if (f.amountRange[0] > 0 || f.amountRange[1] < 50000000) {
      filtered = filtered.filter((opp) => {
        const amt = opp.Amount || 0;
        return amt >= f.amountRange[0] && amt <= f.amountRange[1];
      });
    }

    // Close date range
    if (f.closeDateStart) {
      filtered = filtered.filter((opp) => opp.CloseDate && opp.CloseDate >= f.closeDateStart);
    }
    if (f.closeDateEnd) {
      filtered = filtered.filter((opp) => opp.CloseDate && opp.CloseDate <= f.closeDateEnd);
    }

    // Stale toggle (30+ days since last activity).
    // Predicate MUST stay in sync with:
    //   - SummaryCards.tsx "Stale Deals" card count
    //   - the `initialFilter === 'stale'` click-through below
    // Definition: LastModifiedDate older than 30 days. No past-due-by-CloseDate
    // component (that's a different concept — "overdue" — and would need its own
    // card if we want to surface it).
    if (f.staleOnly) {
      const today = startOfDay(new Date());
      filtered = filtered.filter(
        (opp) => opp.LastModifiedDate && differenceInDays(today, parseISO(opp.LastModifiedDate)) > 30,
      );
    }

    return filtered;
  }, [displayOpps, pipelineFilters]);

  // Apply legacy initial filter from Dashboard navigation
  if (initialFilter === 'atRisk') {
    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const qEnd = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0);
    visibleOpps = visibleOpps.filter((opp) => {
      if (!opp.CloseDate) return false;
      const cd = parseISO(opp.CloseDate);
      const inQ = cd >= qStart && cd <= qEnd;
      const atRisk = (opp.Probability || 0) < 50 || ['Lead Gen', 'New Lead', 'Qualifying'].includes(opp.StageName || '');
      return inQ && atRisk;
    });
  } else if (initialFilter === 'stale') {
    // Must match SummaryCards.tsx "Stale Deals" card count predicate and the
    // pipelineFilters.staleOnly predicate above. Previously this filter added
    // an `isPastDue` OR leg and a CloseDate-required AND leg that the card
    // count didn't share, producing a card-vs-table mismatch (e.g. 388 vs 473).
    const today = startOfDay(new Date());
    visibleOpps = visibleOpps.filter(
      (opp) => opp.LastModifiedDate && differenceInDays(today, parseISO(opp.LastModifiedDate)) > 30,
    );
  } else if (initialFilter === 'closingMonth') {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    visibleOpps = visibleOpps.filter((opp) => {
      if (!opp.CloseDate) return false;
      const cd = parseISO(opp.CloseDate);
      return cd >= monthStart && cd <= monthEnd;
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      {/* Header: view mode tabs + bulk actions + new/refresh */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <Button variant={viewMode === 'open' ? 'contained' : 'outlined'} onClick={() => setViewMode('open')} sx={{ minWidth: 150 }}>
            Open Pipeline <Chip label={openCount} size="small" sx={{ ml: 1, bgcolor: viewMode === 'open' ? 'rgba(255,255,255,0.3)' : 'default' }} />
          </Button>
          <Button variant={viewMode === 'collecting' ? 'contained' : 'outlined'} onClick={() => setViewMode('collecting')}
            color={viewMode === 'collecting' ? 'success' : 'inherit'} sx={{ minWidth: 180 }}>
            Collecting / In Effect <Chip label={collectingCount} size="small" sx={{ ml: 1, bgcolor: viewMode === 'collecting' ? 'rgba(255,255,255,0.3)' : 'default' }} />
          </Button>
          <Button variant={viewMode === 'closed' ? 'contained' : 'outlined'} onClick={() => setViewMode('closed')}
            color={viewMode === 'closed' ? 'error' : 'inherit'} sx={{ minWidth: 150 }}>
            Closed
            <Chip label={closedCount} size="small"
              sx={{ ml: 1, bgcolor: viewMode === 'closed' ? 'rgba(255,255,255,0.3)' : 'default' }} />
          </Button>
        </Box>
        <Box sx={{ display: 'flex', gap: 2 }}>
          {selectedRowIds.length > 0 && (
            <>
              <Chip label={`${selectedRowIds.length} selected`} color="primary" onDelete={() => setSelectedRowIds([])} />
              <Button onClick={() => handleBulkAction('withdraw')} variant="outlined" color="error" size="small">Withdraw Selected</Button>
              <Button onClick={() => handleBulkAction('stage')} variant="outlined" color="primary" size="small">Change Stage</Button>
            </>
          )}
          <Button startIcon={<AddIcon />} onClick={() => navigate('/opportunities/new')} variant="contained" color="primary">New Opportunity</Button>
          <Button startIcon={<RefreshIcon />} onClick={() => queryClient.invalidateQueries('opportunities')} variant="outlined">Refresh</Button>
        </Box>
      </Box>

      {/* Pipeline Filter Bar */}
      <PipelineFilterBar
        filters={pipelineFilters}
        initialExpanded={!!dashboardFilterAlert}
        onChange={(f) => {
          setPipelineFilters(f);
          // Sync legacy flags for data hook
          setAijiOnly(f.aijiOnly);
        }}
        ownerOptions={users.map((u: any) => ({ id: u.Id, name: u.Name, isActive: u.IsActive !== false }))}
        revenueStreamOptions={(() => {
          const streams = new Set<string>();
          opportunities.forEach((o) => { if (o.RecordType?.Name) streams.add(o.RecordType.Name); });
          return Array.from(streams).sort();
        })()}
      />

      {/* Dashboard navigation alert */}
      {dashboardFilterAlert && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setDashboardFilterAlert(null)}>
          Filtered from Dashboard: {dashboardFilterAlert}
        </Alert>
      )}

      {/* Filter alerts */}
      {initialFilter && (
        <Alert severity="warning" sx={{ mb: 3 }} onClose={() => setInitialFilter(null)}>
          {initialFilter === 'atRisk' && <><strong>Showing At-Risk Deals Only:</strong> Current quarter opportunities with low probability (&lt;50%) or early stage.</>}
          {initialFilter === 'stale' && <><strong>Showing Stale Opportunities Only:</strong> Opportunities that are past due or haven't been updated in 30+ days.</>}
          {initialFilter === 'closingMonth' && <><strong>Showing Opportunities Closing This Month:</strong> Click the card again to clear, or use ✕ to dismiss.</>}
        </Alert>
      )}

      {/* View mode hints */}
      {viewMode === 'open' && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>Open Pipeline:</strong> Track and manage open opportunities. Edit fields inline to update Salesforce instantly.
        </Alert>
      )}
      {viewMode === 'collecting' && (
        <Alert severity="success" sx={{ mb: 3 }}>
          <strong>Collecting / In Effect:</strong> Monitor won grants with payment tracking.
        </Alert>
      )}
      {viewMode === 'closed' && (
        <Alert severity="error" sx={{ mb: 3 }}>
          <strong>Closed Opportunities:</strong> View completed, lost, withdrawn, or unfulfilled opportunities.
        </Alert>
      )}

      {/* Summary cards — Stale / Closing-this-month / Total-pipeline cards
          double as click-to-filter handles. Toggle: clicking the active card
          clears the filter. */}
      <SummaryCards
        viewMode={viewMode}
        opps={visibleOpps}
        activeFilter={initialFilter}
        onCardClick={(filter) => {
          setInitialFilter((prev) => (prev === filter ? null : filter));
          // Clear the dashboard banner — in-page click takes ownership of the
          // filter state from here.
          setDashboardFilterAlert(null);
        }}
      />

      {/* Error */}
      {error && <Alert severity="error" sx={{ mb: 3 }}>Failed to load opportunities. Please check your connection.</Alert>}

      {/* Data grid */}
      <Card>
        <CardContent>
          {/* Summary strip removed — duplicated the topline cards above. */}

          <Box sx={{ height: 'calc(100vh - 500px)', minHeight: 600, width: '100%' }}>
            <DataGrid
              rows={visibleOpps}
              columns={viewMode === 'collecting' ? paymentColumns : pipelineColumns}
              loading={isLoading}
              getRowId={(row) => row.Id}
              pagination
              pageSizeOptions={[25, 50, 100, 250, 500]}
              editMode="cell"
              processRowUpdate={viewMode === 'open' ? handleCellEdit : undefined}
              onProcessRowUpdateError={console.error}
              checkboxSelection
              rowSelectionModel={selectedRowIds}
              onRowSelectionModelChange={(sel) => setSelectedRowIds(sel as string[])}
              slots={{ toolbar: GridToolbar }}
              slotProps={{
                toolbar: { showQuickFilter: true, quickFilterProps: { debounceMs: 500 }, printOptions: { disableToolbarButton: true }, csvOptions: { disableToolbarButton: true } },
              }}
              initialState={{
                pagination: { paginationModel: { pageSize: 100, page: 0 } },
                sorting: {
                  sortModel: viewMode === 'collecting'
                    ? [{ field: 'Most_Recent_Payment_Date__c', sort: 'desc' }]
                    : [{ field: 'expectedValue', sort: 'desc' }],
                },
                filter: searchFromUrl
                  ? { filterModel: { items: [], quickFilterValues: [searchFromUrl] } }
                  : undefined,
              }}
              filterMode="client"
              sortingMode="client"
              paginationMode="client"
              disableRowSelectionOnClick={false}
              disableColumnFilter={false}
              disableColumnMenu={false}
              isCellEditable={(params) => {
                if (viewMode !== 'open') return false;
                // Block editing on locked opportunities
                if (lockMap.has(params.row.Id)) {
                  const lock = lockMap.get(params.row.Id)!;
                  if (lock.locked_by !== sfUserId) return false;
                }
                // Only list fields that actually use DataGrid's native edit
                // UI. Fields owned by an inline-edit domain cell (StageCell,
                // OwnerCell, AccountCell, AmountCell, ProbabilityCell,
                // DateCell, …) have `editable: false` on the column def and
                // handle their own save flow — listing them here silently
                // re-enables DataGrid-native edit alongside the domain cell
                // if someone ever flips `editable: true` on the column.
                return ['Name', 'CloseDate'].includes(params.field);
              }}
              sx={{
                '& .MuiDataGrid-cell:focus': { outline: 'none' },
                '& .MuiDataGrid-cell--editable': {
                  cursor: 'pointer', bgcolor: 'background.paper',
                  '&:hover': { backgroundColor: 'action.hover', boxShadow: 'inset 0 0 0 1px rgba(25, 118, 210, 0.5)' },
                },
                '& .MuiDataGrid-cell--editing': { backgroundColor: 'primary.light', boxShadow: 'inset 0 0 0 2px #1976d2' },
                '& .MuiDataGrid-row:hover .MuiDataGrid-cell--editable': { backgroundColor: 'action.hover' },
              }}
            />
          </Box>
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <OpportunityEditDialog
        open={editDialogOpen}
        onClose={() => { setEditDialogOpen(false); setSelectedOpp(null); }}
        opportunityId={selectedOpp?.Id ?? null}
        initialData={selectedOpp ?? undefined}
        onSaved={() => { setEditDialogOpen(false); setSelectedOpp(null); }}
        onStageClosedCompleted={(opp) => {
          setEditDialogOpen(false);
          setPaymentScheduleOpp(opp as any);
          setPaymentScheduleOpen(true);
        }}
        onOpenRelated={(type, id) => pushDialog({ type, id })}
      />

      {/* Payment Schedule Modal */}
      {paymentScheduleOpp && (
        <PaymentScheduleModal
          open={paymentScheduleOpen}
          onClose={() => setPaymentScheduleOpen(false)}
          opportunityId={paymentScheduleOpp.Id}
          opportunityAmount={paymentScheduleOpp.Amount}
          opportunityName={paymentScheduleOpp.Name}
          onScheduleCreated={() => { setPaymentScheduleOpen(false); queryClient.invalidateQueries('opportunities'); toast.success('Payment schedule created!'); }}
        />
      )}

      {/* Task Panel */}
      <TaskPanel open={taskPanelOpen} onClose={() => { setTaskPanelOpen(false); setTaskPanelOpp(null); }} opportunity={taskPanelOpp} users={users} />

      {/* Bulk Action Dialog */}
      <Dialog open={bulkActionDialogOpen} onClose={() => setBulkActionDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{bulkAction === 'withdraw' ? 'Withdraw Opportunities' : 'Change Stage'}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2 }}>
            {bulkAction === 'withdraw' ? (
              <Alert severity="warning" sx={{ mb: 2 }}>
                Are you sure you want to withdraw {selectedRowIds.length} selected opportunities? This will change their stage to "Withdrawn".
              </Alert>
            ) : (
              <>
                <Alert severity="info" sx={{ mb: 2 }}>Change the stage for {selectedRowIds.length} selected opportunities.</Alert>
                <TextField fullWidth select label="New Stage" value={bulkTargetStage} onChange={(e) => setBulkTargetStage(e.target.value)} sx={{ mt: 2 }}>
                  {OPPORTUNITY_STAGES.map((stage) => <MenuItem key={stage} value={stage}>{stage}</MenuItem>)}
                </TextField>
              </>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkActionDialogOpen(false)}>Cancel</Button>
          <ConfirmSaveButton
            onConfirm={handleBulkActionConfirm}
            loading={bulkUpdateMutation.isLoading}
            disabled={bulkAction === 'stage' && !bulkTargetStage}
            color={bulkAction === 'withdraw' ? 'error' : 'primary'}
            confirmTitle={`Update ${selectedRowIds.length} opportunities in Salesforce?`}
            confirmMessage="This will update all selected opportunities. Changes are tracked in field history."
          >
            Confirm
          </ConfirmSaveButton>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default Opportunities;
