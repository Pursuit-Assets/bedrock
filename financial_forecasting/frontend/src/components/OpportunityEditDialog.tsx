import React, { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Grid,
  Typography,
  Divider,
  Alert,
  Autocomplete,
  InputAdornment,
  Box,
  Button,
  FormControlLabel,
  Switch,
  IconButton,
  Tooltip,
} from '@mui/material';
import { OpenInNew as OpenInNewIcon } from '@mui/icons-material';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { OPPORTUNITY_STAGES, COLLECTING_STAGES, CLOSED_STAGES } from '../types/salesforce';

// ── Types ───────────────────────────────────────────────────────────────────

interface OpportunityEditDialogProps {
  open: boolean;
  onClose: () => void;
  opportunityId: string | null;
  initialData?: Record<string, any>;
  onSaved?: (oppId: string, updates: Record<string, any>) => void;
  onStageClosedCompleted?: (opp: { Id: string; Name: string; Amount: number }) => void;
  /** When provided, shows "Open" icons next to lookup fields for stacked dialog navigation. */
  onOpenRelated?: (type: 'opportunity' | 'account' | 'contact', id: string) => void;
}

interface UserOption {
  Id: string;
  Name: string;
}

interface AccountOption {
  Id: string;
  Name: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Stages where the Payment Summary section is shown (Collecting + all Closed). */
const PAYMENT_SUMMARY_STAGES = new Set<string>([
  ...COLLECTING_STAGES,
  ...CLOSED_STAGES,
]);

/** Nested relationship objects that must never be sent to the update API. */
const SKIP_FIELDS = new Set(['Account', 'Owner', 'RecordType', 'attributes']);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the opportunities array from the react-query cache (handles varying shapes). */
function extractOppsArray(cached: unknown): Record<string, any>[] {
  if (Array.isArray(cached)) return cached;
  if (cached && typeof cached === 'object') {
    const obj = cached as Record<string, any>;
    return obj.opportunities || obj.data || [];
  }
  return [];
}

/** Format an ISO date string to a readable locale string. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

const OpportunityEditDialog: React.FC<OpportunityEditDialogProps> = ({
  open,
  onClose,
  opportunityId,
  initialData,
  onSaved,
  onStageClosedCompleted,
  onOpenRelated,
}) => {
  const queryClient = useQueryClient();
  const { can, isAdmin, sfUserId } = usePermissions();

  // ── Local state ─────────────────────────────────────────────────────────
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [originalOpp, setOriginalOpp] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [users, setUsers] = useState<UserOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);

  // ── Permission checks ───────────────────────────────────────────────────
  const isOwner = originalOpp?.OwnerId === sfUserId;
  const canEditOwner =
    isAdmin ||
    (can('edit_all_opportunities') && can('reassign_opportunities')) ||
    (isOwner && can('reassign_opportunities'));
  const canEdit =
    isAdmin ||
    can('edit_all_opportunities') ||
    (isOwner && can('edit_own_opportunities'));

  // ── Resolve opportunity data on open ────────────────────────────────────
  useEffect(() => {
    if (!open || !opportunityId) {
      setOriginalOpp(null);
      setEditForm({});
      setErrors({});
      return;
    }

    let resolved: Record<string, any> | null = null;

    // 1. Use initialData if provided
    if (initialData && initialData.Id === opportunityId) {
      resolved = initialData;
    }

    // 2. Fallback: look in the react-query cache
    if (!resolved) {
      const cached = queryClient.getQueryData('opportunities');
      const opps = extractOppsArray(cached);
      resolved = opps.find((o) => o.Id === opportunityId) || null;
    }

    if (resolved) {
      setOriginalOpp({ ...resolved });
      setEditForm({ ...resolved });
    } else {
      setOriginalOpp(null);
      setEditForm({});
    }
  }, [open, opportunityId, initialData, queryClient]);

  // ── Fetch users & accounts when dialog opens ───────────────────────────
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    setUsersLoading(true);
    apiService
      .getUsers()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.users || res.data || [];
        setUsers(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });

    setAccountsLoading(true);
    apiService
      .getAccounts()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.accounts || res.data || [];
        setAccounts(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Derived values for Autocomplete ─────────────────────────────────────
  const selectedOwner = useMemo(
    () => users.find((u) => u.Id === editForm.OwnerId) || null,
    [users, editForm.OwnerId],
  );

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.Id === editForm.AccountId) || null,
    [accounts, editForm.AccountId],
  );

  // ── Field change handler ────────────────────────────────────────────────
  const handleFieldChange = (field: string, value: any) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!opportunityId || !originalOpp) return;

    // Validate SF-required fields before saving
    const newErrors: Record<string, string> = {};
    if (!editForm.Name?.toString().trim()) {
      newErrors.Name = 'Opportunity name is required';
    }
    if (!editForm.CloseDate) {
      newErrors.CloseDate = 'Close date is required';
    }
    if (!editForm.StageName) {
      newErrors.StageName = 'Stage is required';
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    // Diff: only send changed fields (skip nested relationship objects)
    const updates: Record<string, any> = {};
    for (const key of Object.keys(editForm)) {
      if (SKIP_FIELDS.has(key)) continue;
      const newVal = editForm[key];
      const oldVal = originalOpp[key];
      if (newVal !== oldVal) {
        updates[key] = newVal;
      }
    }

    // Special numeric parsing
    if ('Amount' in updates) {
      updates.Amount = parseFloat(updates.Amount) || 0;
    }
    if ('Probability' in updates) {
      updates.Probability = parseInt(updates.Probability, 10) || 0;
    }

    if (Object.keys(updates).length === 0) {
      toast('No changes detected');
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiService.updateOpportunity(opportunityId, updates);
      toast.success('Saved!');
      queryClient.invalidateQueries('opportunities');

      if (onSaved) {
        onSaved(opportunityId, updates);
      }

      // Check if stage transitioned to "Closed / Completed"
      const newStage = editForm.StageName;
      const oldStage = originalOpp.StageName;
      if (
        newStage !== oldStage &&
        newStage === 'Closed / Completed' &&
        onStageClosedCompleted
      ) {
        onStageClosedCompleted({
          Id: opportunityId,
          Name: editForm.Name || originalOpp.Name,
          Amount: parseFloat(editForm.Amount) || originalOpp.Amount || 0,
        });
      }

      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to save opportunity';
      toast.error(detail);
    } finally {
      setSaving(false);
    }
  };

  // ── Not-found state ─────────────────────────────────────────────────────
  const notFound = open && opportunityId && !originalOpp;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Edit Opportunity
        {originalOpp?.Name && (
          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 0.25 }}>
            {originalOpp.Name}
          </Typography>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {notFound && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Opportunity not found. It may have been deleted or you may not have access.
          </Alert>
        )}

        {!canEdit && originalOpp && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can only edit opportunities you own.
          </Alert>
        )}

        {originalOpp && (
          <>
            {/* ── Section 1: Core Fields ──────────────────────────────── */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Name"
                  fullWidth
                  size="small"
                  required
                  disabled={!canEdit}
                  value={editForm.Name || ''}
                  onChange={(e) => handleFieldChange('Name', e.target.value)}
                  error={!!errors.Name}
                  helperText={errors.Name}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Stage"
                  fullWidth
                  size="small"
                  select
                  required
                  disabled={!canEdit}
                  value={editForm.StageName || ''}
                  onChange={(e) => handleFieldChange('StageName', e.target.value)}
                  error={!!errors.StageName}
                  helperText={errors.StageName}
                >
                  {OPPORTUNITY_STAGES.map((stage) => (
                    <MenuItem key={stage} value={stage}>
                      {stage}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Amount"
                  fullWidth
                  size="small"
                  type="number"
                  disabled={!canEdit}
                  value={editForm.Amount ?? ''}
                  onChange={(e) => handleFieldChange('Amount', e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Probability (%)"
                  fullWidth
                  size="small"
                  type="number"
                  disabled={!canEdit}
                  value={editForm.Probability ?? ''}
                  onChange={(e) => handleFieldChange('Probability', e.target.value)}
                  inputProps={{ min: 0, max: 100 }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Close Date"
                  fullWidth
                  size="small"
                  type="date"
                  required
                  disabled={!canEdit}
                  value={editForm.CloseDate || ''}
                  onChange={(e) => handleFieldChange('CloseDate', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  error={!!errors.CloseDate}
                  helperText={errors.CloseDate}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Type"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Type || ''}
                  onChange={(e) => handleFieldChange('Type', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Renewal / Repeat"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.RenewalRepeat__c || ''}
                  onChange={(e) => handleFieldChange('RenewalRepeat__c', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  <MenuItem value="New">New</MenuItem>
                  <MenuItem value="Renewal">Renewal</MenuItem>
                  <MenuItem value="Upsell">Upsell</MenuItem>
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Active_Opportunity__c}
                      onChange={(e) =>
                        handleFieldChange('Active_Opportunity__c', e.target.checked)
                      }
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label="Active Opportunity"
                />
              </Grid>
            </Grid>

            {/* ── Section 2: Details ──────────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Details
            </Typography>

            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Lead Source"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.LeadSource || ''}
                  onChange={(e) => handleFieldChange('LeadSource', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Next Step"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.NextStep || ''}
                  onChange={(e) => handleFieldChange('NextStep', e.target.value)}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Description"
                  fullWidth
                  size="small"
                  multiline
                  rows={3}
                  disabled={!canEdit}
                  value={editForm.Description || ''}
                  onChange={(e) => handleFieldChange('Description', e.target.value)}
                />
              </Grid>
              <Grid item xs={12}>
                <Box sx={{ display: 'flex', gap: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    <strong>Forecast Category:</strong>{' '}
                    {editForm.ForecastCategory || '—'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    <strong>Expected Revenue:</strong>{' '}
                    {editForm.ExpectedRevenue != null
                      ? `$${Number(editForm.ExpectedRevenue).toLocaleString()}`
                      : '—'}
                  </Typography>
                </Box>
              </Grid>
            </Grid>

            {/* ── Section 3: Payment Summary (Collecting+ stages only) ── */}
            {PAYMENT_SUMMARY_STAGES.has(originalOpp.StageName) && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                  Payment Summary
                </Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Payments Received:</strong>{' '}
                      {editForm.npe01__Payments_Made__c != null
                        ? `$${Number(editForm.npe01__Payments_Made__c).toLocaleString()}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Outstanding:</strong>{' '}
                      {editForm.Outstanding_Payments__c != null
                        ? `$${Number(editForm.Outstanding_Payments__c).toLocaleString()}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Payment Count:</strong>{' '}
                      {editForm.Number_of_Payments_Received__c != null ||
                      editForm.npe01__Number_of_Payments__c != null
                        ? `${editForm.Number_of_Payments_Received__c ?? 0} / ${editForm.npe01__Number_of_Payments__c ?? 0}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Last Payment:</strong>{' '}
                      {editForm.Last_Actual_Payment__c != null
                        ? `$${Number(editForm.Last_Actual_Payment__c).toLocaleString()}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Most Recent Payment:</strong>{' '}
                      {formatDate(editForm.Most_Recent_Payment_Date__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>First Payment:</strong>{' '}
                      {formatDate(editForm.PaymentDate__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Next Scheduled:</strong>{' '}
                      {formatDate(editForm.Earliest_Scheduled_Payment__c)}
                    </Typography>
                  </Grid>
                </Grid>
              </>
            )}

            {/* ── Section 4: Ownership & Contract ─────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Ownership & Contract
            </Typography>

            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <Autocomplete
                  options={users}
                  loading={usersLoading}
                  getOptionLabel={(option: UserOption) => option.Name || ''}
                  value={selectedOwner}
                  onChange={(_e, newValue) =>
                    handleFieldChange('OwnerId', newValue?.Id || editForm.OwnerId)
                  }
                  isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                  disabled={!canEditOwner}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Owner"
                      size="small"
                      helperText={
                        !canEditOwner
                          ? 'Reassigning requires the Reassign Opportunities permission'
                          : undefined
                      }
                    />
                  )}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Autocomplete
                    options={accounts}
                    loading={accountsLoading}
                    getOptionLabel={(option: AccountOption) => option.Name || ''}
                    value={selectedAccount}
                    onChange={(_e, newValue) =>
                      handleFieldChange('AccountId', newValue?.Id || editForm.AccountId)
                    }
                    isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                    disabled={!canEdit}
                    sx={{ flex: 1 }}
                    renderInput={(params) => (
                      <TextField {...params} label="Account" size="small" />
                    )}
                  />
                  {onOpenRelated && editForm.AccountId && (
                    <Tooltip title="Open account">
                      <IconButton
                        size="small"
                        onClick={() => onOpenRelated('account', editForm.AccountId)}
                      >
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Contract Start Date"
                  fullWidth
                  size="small"
                  type="date"
                  disabled={!canEdit}
                  value={editForm.Contract_Start_Date__c || ''}
                  onChange={(e) =>
                    handleFieldChange('Contract_Start_Date__c', e.target.value)
                  }
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Contract End Date"
                  fullWidth
                  size="small"
                  type="date"
                  disabled={!canEdit}
                  value={editForm.Contract_End_Date__c || ''}
                  onChange={(e) =>
                    handleFieldChange('Contract_End_Date__c', e.target.value)
                  }
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Payment Terms"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Payment_Terms__c || ''}
                  onChange={(e) =>
                    handleFieldChange('Payment_Terms__c', e.target.value)
                  }
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Billing Frequency"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Billing_Frequency__c || ''}
                  onChange={(e) =>
                    handleFieldChange('Billing_Frequency__c', e.target.value)
                  }
                />
              </Grid>
            </Grid>

            {/* ── Read-only footer ────────────────────────────────────── */}
            <Box sx={{ mt: 2.5, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                Created: {formatDate(originalOpp.CreatedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Modified: {formatDate(originalOpp.LastModifiedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Record Type: {originalOpp.RecordType?.Name || '—'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Activity: {formatDate(originalOpp.LastActivityDate)}
              </Typography>
            </Box>
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose}>Cancel</Button>
        <ConfirmSaveButton
          onConfirm={handleSave}
          loading={saving}
          disabled={!canEdit || !originalOpp}
        >
          Save
        </ConfirmSaveButton>
      </DialogActions>
    </Dialog>
  );
};

export default OpportunityEditDialog;
