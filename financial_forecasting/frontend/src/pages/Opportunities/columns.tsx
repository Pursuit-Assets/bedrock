/**
 * Column definitions for the Opportunities DataGrid.
 *
 * Separated from the main component so the orchestrator stays focused on
 * layout and wiring rather than 600 lines of column config.
 */
import React from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Select,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Lock as LockIcon,
  LockOpen as LockOpenIcon,
} from '@mui/icons-material';
import EditRowButton from '../../components/EditRowButton';
import {
  GridColDef,
  GridRenderCellParams,
  GridRenderEditCellParams,
  GridValueGetterParams,
} from '@mui/x-data-grid';
import { format } from 'date-fns';
import { formatDollarMillions } from '../../utils/formatters';
import { OPPORTUNITY_STAGES, getStageHexColor } from '../../types/salesforce';
import { getStageColor, getProbabilityColor, calculatePaymentDate } from './helpers';
import type { Opportunity } from './helpers';
import { AccountEditCell, OwnerEditCell } from './EditCells';

// ---------------------------------------------------------------------------
// Callbacks the columns need from the parent component
// ---------------------------------------------------------------------------

export interface ColumnCallbacks {
  onTaskPanelOpen: (opp: Opportunity) => void;
  onStageChange: (params: GridRenderCellParams, newStage: string) => void;
  accountMap: Map<string, any>;
  userMap: Map<string, any>;
  // Lock support
  lockMap?: Map<string, { locked_by: string; locked_at: string }>;
  onLockToggle?: (oppId: string, ownerId: string, isLocked: boolean) => void;
  currentSfUserId?: string | null;
  canLock?: boolean;
  // Edit dialog
  onEditDialogOpen?: (opp: any) => void;
}

// ---------------------------------------------------------------------------
// Pipeline columns (Sales team — focus on closing deals)
// ---------------------------------------------------------------------------

function lockColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: '_lock',
    headerName: '',
    width: 44,
    sortable: false,
    filterable: false,
    disableColumnMenu: true,
    renderCell: (params: GridRenderCellParams) => {
      const opp = params.row as Opportunity;
      const lock = cb.lockMap?.get(opp.Id);
      const isOwner = cb.currentSfUserId && opp.OwnerId === cb.currentSfUserId;
      const isLockedByMe = lock && lock.locked_by === cb.currentSfUserId;
      const isLockedByOther = lock && !isLockedByMe;

      if (isLockedByMe) {
        return (
          <Tooltip title="Unlock this opportunity">
            <IconButton size="small" onClick={() => cb.onLockToggle?.(opp.Id, opp.OwnerId, true)}
              sx={{ color: '#ed6c02' }}>
              <LockIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        );
      }
      if (isLockedByOther) {
        const lockerName = cb.userMap.get(lock!.locked_by)?.Name || 'another user';
        return (
          <Tooltip title={`Locked by ${lockerName}`}>
            <LockIcon sx={{ fontSize: 18, color: '#d32f2f', cursor: 'default' }} />
          </Tooltip>
        );
      }
      if (isOwner && cb.canLock) {
        return (
          <Tooltip title="Lock this opportunity">
            <IconButton size="small" onClick={() => cb.onLockToggle?.(opp.Id, opp.OwnerId, false)}
              sx={{ color: '#bdbdbd', '&:hover': { color: '#ed6c02' } }}>
              <LockOpenIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        );
      }
      return null;
    },
  };
}

export function buildPipelineColumns(cb: ColumnCallbacks): GridColDef[] {
  return [
    lockColumn(cb),
    taskColumn(cb),
    {
      field: 'Name',
      headerName: 'Opportunity Name',
      flex: 2,
      minWidth: 250,
      editable: true,
      filterable: true,
    },
    accountColumn(cb, { editable: true }),
    ownerColumn(cb),
    stageColumn(cb),
    {
      field: 'Amount',
      headerName: 'Amount',
      flex: 0.8,
      minWidth: 120,
      type: 'number',
      editable: true,
      filterable: true,
      valueFormatter: (params) => formatDollarMillions(params.value as number),
    },
    {
      field: 'Probability',
      headerName: 'Probability',
      flex: 0.7,
      minWidth: 110,
      type: 'number',
      editable: true,
      filterable: true,
      renderCell: (params: GridRenderCellParams) => (
        <Chip
          label={`${params.value}%`}
          color={getProbabilityColor(params.value as number)}
          size="small"
          variant="outlined"
        />
      ),
    },
    closeDateColumn(),
    {
      field: 'PaymentDate__c',
      headerName: '1st Payment Date',
      flex: 0.9,
      minWidth: 130,
      type: 'date',
      editable: true,
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
      valueFormatter: (params) => (!params.value ? '-' : format(new Date(params.value as string), 'MMM dd, yyyy')),
    },
    lastModifiedColumn(),
    {
      field: 'expectedValue',
      headerName: 'Expected Value',
      flex: 0.9,
      minWidth: 130,
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => {
        const amount = params.row.Amount || 0;
        const probability = params.row.Probability || 0;
        return (amount * probability) / 100;
      },
      valueFormatter: (params) => formatDollarMillions(params.value as number),
    },
    editColumn(cb),
  ];
}

// ---------------------------------------------------------------------------
// Payment columns (Finance team — focus on tracking payments)
// ---------------------------------------------------------------------------

export function buildPaymentColumns(cb: ColumnCallbacks): GridColDef[] {
  return [
    taskColumn(cb),
    {
      field: 'Name',
      headerName: 'Grant Name',
      flex: 2,
      minWidth: 250,
      filterable: true,
    },
    accountColumn(cb, { editable: false }),
    closeDateColumn(),
    {
      field: 'Amount',
      headerName: 'Total Amount',
      flex: 0.9,
      minWidth: 130,
      type: 'number',
      filterable: true,
      valueFormatter: (params) => formatDollarMillions(params.value as number),
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ fontWeight: 600 }}>{formatDollarMillions(params.value as number)}</Box>
      ),
    },
    {
      field: 'npe01__Payments_Made__c',
      headerName: 'Received',
      flex: 0.9,
      minWidth: 130,
      type: 'number',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => params.row.npe01__Payments_Made__c || 0,
      valueFormatter: (params) => formatDollarMillions((params.value as number) || 0),
      renderCell: (params: GridRenderCellParams) => (
        <Box sx={{ color: 'success.main', fontWeight: 600 }}>
          {formatDollarMillions((params.value as number) || 0)}
        </Box>
      ),
    },
    {
      field: 'remainingAmount',
      headerName: 'Remaining',
      flex: 0.9,
      minWidth: 130,
      type: 'number',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => {
        const total = params.row.Amount || 0;
        const received = params.row.npe01__Payments_Made__c || 0;
        return total - received;
      },
      valueFormatter: (params) => formatDollarMillions(params.value as number),
      renderCell: (params: GridRenderCellParams) => {
        const remaining = params.value as number;
        return (
          <Box sx={{ color: remaining > 0 ? 'warning.main' : 'success.main', fontWeight: 600 }}>
            {formatDollarMillions(remaining)}
          </Box>
        );
      },
    },
    progressColumn(),
    {
      field: 'Number_of_Payments_Received__c',
      headerName: 'Payments',
      flex: 0.7,
      minWidth: 100,
      type: 'number',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => params.row.Number_of_Payments_Received__c || 0,
      renderCell: (params: GridRenderCellParams) => (
        <Chip
          label={`${params.value || 0} / ${params.row.npe01__Number_of_Payments__c || 0}`}
          color={((params.value as number) || 0) > 0 ? 'success' : 'default'}
          size="small"
        />
      ),
    },
    {
      field: 'Most_Recent_Payment_Date__c',
      headerName: 'Last Payment',
      flex: 0.9,
      minWidth: 130,
      type: 'date',
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
      valueFormatter: (params) => (!params.value ? 'No payments yet' : format(new Date(params.value as string), 'MMM dd, yyyy')),
    },
    {
      field: 'expectedPaymentDate',
      headerName: 'Next Expected',
      flex: 0.9,
      minWidth: 130,
      filterable: true,
      valueGetter: (params: GridValueGetterParams) => calculatePaymentDate(params.row.CloseDate),
      valueFormatter: (params) => (!params.value ? 'N/A' : format(params.value as Date, 'MMM dd, yyyy')),
    },
    paymentStatusColumn(),
    editColumn(cb),
  ];
}

// ---------------------------------------------------------------------------
// Edit column
// ---------------------------------------------------------------------------

function editColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: '__edit__',
    headerName: '',
    width: 50,
    sortable: false,
    filterable: false,
    disableColumnMenu: true,
    renderCell: (params: GridRenderCellParams) => (
      <EditRowButton
        onClick={() => cb.onEditDialogOpen?.(params.row)}
        tooltip="Edit opportunity"
      />
    ),
  };
}

// ---------------------------------------------------------------------------
// Shared column fragments
// ---------------------------------------------------------------------------

function taskColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'tasks',
    headerName: 'Tasks',
    width: 80,
    sortable: false,
    filterable: false,
    disableColumnMenu: true,
    renderCell: (params: GridRenderCellParams) => (
      <Button
        size="small"
        variant="text"
        onClick={(e) => { e.stopPropagation(); cb.onTaskPanelOpen(params.row); }}
        sx={{ minWidth: 0, fontSize: '0.75rem', textTransform: 'none' }}
      >
        Tasks
      </Button>
    ),
  };
}

function accountColumn(cb: ColumnCallbacks, opts: { editable: boolean }): GridColDef {
  return {
    field: 'AccountId',
    headerName: 'Funder/Account',
    flex: 1.5,
    minWidth: 180,
    editable: opts.editable,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const account = cb.accountMap.get(params.row.AccountId);
      return account?.Name || params.row.Account?.Name || 'Unknown';
    },
    renderCell: (params: GridRenderCellParams) => {
      const account = cb.accountMap.get(params.row.AccountId);
      return account?.Name || params.row.Account?.Name || 'Unknown';
    },
    ...(opts.editable ? { renderEditCell: (params: GridRenderEditCellParams) => <AccountEditCell {...params} /> } : {}),
  };
}

function ownerColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'OwnerId',
    headerName: 'Owner',
    flex: 1,
    minWidth: 150,
    editable: true,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const user = cb.userMap.get(params.row.OwnerId);
      return user?.Name || params.row.Owner?.Name || 'Unassigned';
    },
    renderCell: (params: GridRenderCellParams) => {
      const user = cb.userMap.get(params.row.OwnerId);
      return user?.Name || params.row.Owner?.Name || 'Unassigned';
    },
    renderEditCell: (params: GridRenderEditCellParams) => <OwnerEditCell {...params} />,
  };
}

function stageColumn(cb: ColumnCallbacks): GridColDef {
  return {
    field: 'StageName',
    headerName: 'Stage',
    flex: 1.2,
    minWidth: 160,
    editable: false,
    filterable: true,
    renderCell: (params: GridRenderCellParams) => (
      <Select
        value={params.value || ''}
        onChange={(e) => cb.onStageChange(params, e.target.value as string)}
        size="small"
        variant="standard"
        sx={{
          width: '100%',
          '& .MuiSelect-select': { padding: '4px 8px', fontSize: '0.875rem' },
          '&:before': { borderBottom: 'none' },
          '&:hover:not(.Mui-disabled):before': { borderBottom: 'none' },
          '&:after': { borderBottom: 'none' },
        }}
        renderValue={(value) => (
          <Chip
            label={value}
            size="small"
            sx={{ bgcolor: getStageHexColor(value as string), color: '#fff', fontWeight: 600 }}
          />
        )}
      >
        {OPPORTUNITY_STAGES.map((stage) => (
          <MenuItem key={stage} value={stage}>{stage}</MenuItem>
        ))}
      </Select>
    ),
  };
}

function closeDateColumn(): GridColDef {
  return {
    field: 'CloseDate',
    headerName: 'Close Date',
    flex: 0.9,
    minWidth: 120,
    type: 'date',
    editable: true,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
    valueFormatter: (params) => (!params.value ? 'N/A' : format(new Date(params.value as string), 'MMM dd, yyyy')),
  };
}

function lastModifiedColumn(): GridColDef {
  return {
    field: 'LastModifiedDate',
    headerName: 'Last Modified',
    flex: 0.9,
    minWidth: 120,
    type: 'dateTime',
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => (params.value ? new Date(params.value) : null),
    valueFormatter: (params) => (!params.value ? 'N/A' : format(new Date(params.value as string), 'MMM dd, yyyy')),
  };
}

function progressColumn(): GridColDef {
  return {
    field: 'paymentProgress',
    headerName: 'Progress',
    flex: 1,
    minWidth: 140,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const amount = params.row.Amount || 0;
      const received = params.row.npe01__Payments_Made__c || 0;
      return amount === 0 ? 0 : Math.round((received / amount) * 100);
    },
    renderCell: (params: GridRenderCellParams) => {
      const pct = params.value as number;
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
          <Box sx={{ flex: 1, height: 10, bgcolor: 'grey.300', borderRadius: 1, overflow: 'hidden' }}>
            <Box
              sx={{
                width: `${Math.min(pct, 100)}%`,
                height: '100%',
                bgcolor: pct >= 100 ? 'success.main' : pct > 0 ? 'warning.main' : 'grey.400',
                transition: 'width 0.3s',
              }}
            />
          </Box>
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 40 }}>{pct}%</Typography>
        </Box>
      );
    },
  };
}

function paymentStatusColumn(): GridColDef {
  return {
    field: 'paymentStatus',
    headerName: 'Status',
    flex: 0.8,
    minWidth: 120,
    filterable: true,
    valueGetter: (params: GridValueGetterParams) => {
      const amount = params.row.Amount || 0;
      const received = params.row.npe01__Payments_Made__c || 0;
      const outstanding = params.row.Outstanding_Payments__c || 0;
      if (amount === 0) return 'No amount';
      if (received >= amount) return 'Paid';
      if (received > 0) return 'Partial';
      if (outstanding > 0) return 'Scheduled';
      return 'Pending';
    },
    renderCell: (params: GridRenderCellParams) => {
      const status = params.value as string;
      const colorMap: Record<string, 'success' | 'warning' | 'info' | 'error' | 'default'> = {
        Paid: 'success', Partial: 'warning', Scheduled: 'info', Pending: 'error',
      };
      return <Chip label={status} color={colorMap[status] || 'default'} size="small" />;
    },
  };
}
