import React, { useState, useEffect, useCallback } from 'react';
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
  InputAdornment,
  Box,
  Button,
  FormControlLabel,
  Switch,
  Chip,
} from '@mui/material';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { useSchemaPicklist } from '../hooks/useSchemaPicklist';
import { fieldStatusProps, findMissingFields } from '../utils/fieldLoadStatus';
import SaveBlockedDialog from './SaveBlockedDialog';

// Fields the dialog can save. Missing → silent overwrite risk; save-guard
// blocks with SaveBlockedDialog. Per-field "⚠ Couldn't load" surfaces gaps.
const PAYMENT_EDITABLE_FIELDS: readonly string[] = [
  'npe01__Payment_Amount__c',
  'npe01__Scheduled_Date__c',
  'npe01__Payment_Date__c',
  'npe01__Paid__c',
  'npe01__Payment_Method__c',
  'npe01__Check_Reference_Number__c',
  'Amount_Received__c',
  'Department__c',
  'GL_Account__c',
  'GL_Payment_Received__c',
  'Reconciled_with_Finance__c',
  'Payment_Estimate__c',
  'Batch_Name__c',
  'npe01__Written_Off__c',
  'Write_off_reason__c',
] as const;

// ── Types ───────────────────────────────────────────────────────────────────

interface PaymentEditDialogProps {
  open: boolean;
  onClose: () => void;
  paymentId: string | null;
  initialData?: Record<string, any>;
  onSaved?: (paymentId: string, updates: Record<string, any>) => void;
  /** Fires after a successful destructive delete from the footer Delete
   *  button. Parent is responsible for invalidating any payment list caches
   *  (the Opp accordion's `paymentListQuery.refetch()` or PaymentSchedule's
   *  `loadPaymentSchedule()`). Distinct from onSaved because semantics differ
   *  — no updates dict, record is gone rather than modified. */
  onDeleted?: (paymentId: string) => void;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Nested relationship objects that must never be sent to the update API. */
const SKIP_FIELDS = new Set([
  'npe01__Opportunity__r', 'Affiliation__r', 'Invoice__r', 'attributes',
]);

/** Formula/calculated fields — display only, never send in updates. */
const FORMULA_FIELDS = new Set([
  'Payment_Status__c',
  'Delinquent__c',
  'Paid_Status__c',
  'Amount_Formula__c',
  'Amount_Minus_Received__c',
  'NameFormula__c',
  'Payment_for_Month_Of__c',
]);

/** Non-updateable system fields. */
const READONLY_FIELDS = new Set([
  'Id', 'Name', 'CreatedDate', 'LastModifiedDate',
  'IsDeleted', 'SystemModstamp',
  'npe01__Opportunity__c', // Parent opportunity — not changeable via edit
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function formatCurrency(val: number | null | undefined): string {
  if (val == null) return '—';
  return `$${Number(val).toLocaleString()}`;
}

// ── Component ───────────────────────────────────────────────────────────────

const PaymentEditDialog: React.FC<PaymentEditDialogProps> = ({
  open,
  onClose,
  paymentId,
  initialData,
  onSaved,
  onDeleted,
}) => {
  const queryClient = useQueryClient();
  const { can, isAdmin } = usePermissions();

  // ── Local state ─────────────────────────────────────────────────────────
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [originalRecord, setOriginalRecord] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveBlockedMissing, setSaveBlockedMissing] = useState<string[]>([]);

  // Per-field load-status helper. Payment dialog has no per-field validation
  // errors today, so this is a thin wrapper — kept for parity with the other
  // dialogs so future validation additions slot in cleanly.
  const getHelperProps = (fieldName: string) =>
    fieldStatusProps(fieldName, originalRecord);

  // Schema-driven picklists. Each hook shares the 30-min react-query cache keyed
  // on (sobject, fieldName) with every other caller so the SF describe fetch
  // dedupes. Empty options → disabled fallback below; distinguished helper text
  // explains error vs empty-but-no-error.
  const paymentMethod = useSchemaPicklist('npe01__OppPayment__c', 'npe01__Payment_Method__c');
  const department = useSchemaPicklist('npe01__OppPayment__c', 'Department__c');
  const glAccount = useSchemaPicklist('npe01__OppPayment__c', 'GL_Account__c');

  // ── Permission checks ───────────────────────────────────────────────────
  const canEdit = isAdmin || can('edit_payments');

  // ── Resolve payment data on open ────────────────────────────────────────
  useEffect(() => {
    if (!open || !paymentId) {
      setOriginalRecord(null);
      setEditForm({});
      return;
    }

    if (initialData && initialData.Id === paymentId) {
      setOriginalRecord({ ...initialData });
      setEditForm({ ...initialData });
    } else {
      setOriginalRecord(null);
      setEditForm({});
    }
  }, [open, paymentId, initialData]);

  // ── Field change handler ────────────────────────────────────────────────
  const handleFieldChange = useCallback((field: string, value: any) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!paymentId || !originalRecord) return;

    // Block save if the loaded record is missing any editable field.
    const missing = findMissingFields(PAYMENT_EDITABLE_FIELDS, originalRecord);
    if (missing.length > 0) {
      setSaveBlockedMissing(missing);
      return;
    }

    // Diff: only send changed fields
    const updates: Record<string, any> = {};
    for (const key of Object.keys(editForm)) {
      if (SKIP_FIELDS.has(key) || FORMULA_FIELDS.has(key) || READONLY_FIELDS.has(key)) continue;
      const newVal = editForm[key];
      const oldVal = originalRecord[key];
      if (newVal !== oldVal) {
        updates[key] = newVal;
      }
    }

    // Numeric parsing
    if ('npe01__Payment_Amount__c' in updates) {
      updates.npe01__Payment_Amount__c = parseFloat(updates.npe01__Payment_Amount__c) || 0;
    }
    if ('Amount_Received__c' in updates) {
      updates.Amount_Received__c = parseFloat(updates.Amount_Received__c) || null;
    }

    if (Object.keys(updates).length === 0) {
      toast('No changes detected');
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiService.updateSfPayment(paymentId, updates);
      toast.success('Payment saved!');
      // Invalidate opportunities cache — payment rollup fields on Opportunity change
      queryClient.invalidateQueries('opportunities');
      if (onSaved) onSaved(paymentId, updates);
      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to save payment';
      toast.error(detail);
    } finally {
      setSaving(false);
    }
  };

  // ── Delete handler ──────────────────────────────────────────────────────
  // Destructive and irreversible at the SF level. The Delete button in the
  // footer uses ConfirmSaveButton's popover pattern with explicit scary
  // wording so the click chain is always a 2-step opt-in (click Delete →
  // read the warning → click Delete in the popover).
  const handleDelete = async () => {
    if (!paymentId) return;
    setDeleting(true);
    try {
      await apiService.deleteSfPayment(paymentId);
      toast.success('Payment deleted');
      // Rollup fields on the parent Opp change when a payment goes away.
      queryClient.invalidateQueries('opportunities');
      if (onDeleted) onDeleted(paymentId);
      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to delete payment';
      toast.error(detail);
    } finally {
      setDeleting(false);
    }
  };

  // ── Not-found state ─────────────────────────────────────────────────────
  const notFound = open && paymentId && !originalRecord;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        Edit Payment
        {originalRecord?.Name && (
          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 0.25 }}>
            {originalRecord.Name}
          </Typography>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {notFound && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Payment not found.
          </Alert>
        )}

        {!canEdit && originalRecord && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You don't have permission to edit payments.
          </Alert>
        )}

        {originalRecord && (
          <>
            {/* ── Section 1: Payment Details ───────────────────────── */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Payment Amount"
                  fullWidth
                  size="small"
                  type="number"
                  disabled={!canEdit}
                  value={editForm.npe01__Payment_Amount__c ?? ''}
                  onChange={(e) => handleFieldChange('npe01__Payment_Amount__c', e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  }}
                  {...getHelperProps('npe01__Payment_Amount__c')}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Scheduled Date"
                  fullWidth
                  size="small"
                  type="date"
                  disabled={!canEdit}
                  value={editForm.npe01__Scheduled_Date__c || ''}
                  onChange={(e) => handleFieldChange('npe01__Scheduled_Date__c', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  {...getHelperProps('npe01__Scheduled_Date__c')}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Payment Date"
                  fullWidth
                  size="small"
                  type="date"
                  disabled={!canEdit}
                  value={editForm.npe01__Payment_Date__c || ''}
                  onChange={(e) => handleFieldChange('npe01__Payment_Date__c', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  {...getHelperProps('npe01__Payment_Date__c')}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.npe01__Paid__c}
                      onChange={(e) => handleFieldChange('npe01__Paid__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label="Paid"
                  sx={{ mt: 0.5 }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                {paymentMethod.options.length > 0 ? (
                  <TextField
                    label="Payment Method"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.npe01__Payment_Method__c || ''}
                    onChange={(e) => handleFieldChange('npe01__Payment_Method__c', e.target.value)}
                    {...getHelperProps('npe01__Payment_Method__c')}
                  >
                    <MenuItem value="">None</MenuItem>
                    {paymentMethod.options.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                    {/* Preserve the stored value if SF deactivated it (picklist drift). */}
                    {editForm.npe01__Payment_Method__c
                      && !paymentMethod.options.some((v) => v === editForm.npe01__Payment_Method__c) && (
                      <MenuItem value={editForm.npe01__Payment_Method__c} disabled>
                        {editForm.npe01__Payment_Method__c} (inactive)
                      </MenuItem>
                    )}
                  </TextField>
                ) : (
                  <TextField
                    label="Payment Method"
                    fullWidth
                    size="small"
                    disabled
                    value={editForm.npe01__Payment_Method__c || ''}
                    helperText={paymentMethod.error
                      ? 'Payment Method list unavailable'
                      : 'No active payment methods available'}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Check/Reference #"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.npe01__Check_Reference_Number__c || ''}
                  onChange={(e) => handleFieldChange('npe01__Check_Reference_Number__c', e.target.value)}
                  {...getHelperProps('npe01__Check_Reference_Number__c')}
                />
              </Grid>
            </Grid>

            {/* ── Section 2: Status (read-only formula fields) ─────── */}
            {(originalRecord.Payment_Status__c || originalRecord.Delinquent__c != null) && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                  Status
                </Typography>
                <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                  {originalRecord.Payment_Status__c && (
                    <Chip
                      label={`Status: ${originalRecord.Payment_Status__c}`}
                      size="small"
                      color={originalRecord.Payment_Status__c === 'Paid' ? 'success' : 'default'}
                      variant="outlined"
                    />
                  )}
                  {originalRecord.Paid_Status__c && (
                    <Chip
                      label={originalRecord.Paid_Status__c}
                      size="small"
                      variant="outlined"
                    />
                  )}
                  {originalRecord.Delinquent__c && (
                    <Chip
                      label="Delinquent"
                      size="small"
                      color="error"
                      variant="outlined"
                    />
                  )}
                  {originalRecord.Amount_Minus_Received__c != null && (
                    <Typography variant="body2" color="text.secondary" sx={{ alignSelf: 'center' }}>
                      <strong>Remaining:</strong> {formatCurrency(originalRecord.Amount_Minus_Received__c)}
                    </Typography>
                  )}
                </Box>
              </>
            )}

            {/* ── Section 3: Financial ────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Financial
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Amount Received"
                  fullWidth
                  size="small"
                  type="number"
                  disabled={!canEdit}
                  value={editForm.Amount_Received__c ?? ''}
                  onChange={(e) => handleFieldChange('Amount_Received__c', e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  }}
                  {...getHelperProps('Amount_Received__c')}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                {department.options.length > 0 ? (
                  <TextField
                    label="Department"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.Department__c || ''}
                    onChange={(e) => handleFieldChange('Department__c', e.target.value)}
                    {...getHelperProps('Department__c')}
                  >
                    <MenuItem value="">None</MenuItem>
                    {department.options.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                    {editForm.Department__c
                      && !department.options.some((v) => v === editForm.Department__c) && (
                      <MenuItem value={editForm.Department__c} disabled>
                        {editForm.Department__c} (inactive)
                      </MenuItem>
                    )}
                  </TextField>
                ) : (
                  <TextField
                    label="Department"
                    fullWidth
                    size="small"
                    disabled
                    value={editForm.Department__c || ''}
                    helperText={department.error
                      ? 'Department list unavailable'
                      : 'No active departments available'}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={6}>
                {glAccount.options.length > 0 ? (
                  <TextField
                    label="GL Account"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.GL_Account__c || ''}
                    onChange={(e) => handleFieldChange('GL_Account__c', e.target.value)}
                    {...getHelperProps('GL_Account__c')}
                  >
                    <MenuItem value="">None</MenuItem>
                    {glAccount.options.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                    {editForm.GL_Account__c
                      && !glAccount.options.some((v) => v === editForm.GL_Account__c) && (
                      <MenuItem value={editForm.GL_Account__c} disabled>
                        {editForm.GL_Account__c} (inactive)
                      </MenuItem>
                    )}
                  </TextField>
                ) : (
                  <TextField
                    label="GL Account"
                    fullWidth
                    size="small"
                    disabled
                    value={editForm.GL_Account__c || ''}
                    helperText={glAccount.error
                      ? 'GL Account list unavailable'
                      : 'No active GL accounts available'}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="GL Payment Received"
                  fullWidth
                  size="small"
                  type="date"
                  disabled={!canEdit}
                  value={editForm.GL_Payment_Received__c || ''}
                  onChange={(e) => handleFieldChange('GL_Payment_Received__c', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  {...getHelperProps('GL_Payment_Received__c')}
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Reconciled_with_Finance__c}
                      onChange={(e) => handleFieldChange('Reconciled_with_Finance__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label={<Typography variant="body2">Reconciled</Typography>}
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Payment_Estimate__c}
                      onChange={(e) => handleFieldChange('Payment_Estimate__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label={<Typography variant="body2">Estimate</Typography>}
                />
              </Grid>
              <Grid item xs={12}>
                <TextField
                  label="Batch Name"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Batch_Name__c || ''}
                  onChange={(e) => handleFieldChange('Batch_Name__c', e.target.value)}
                  {...getHelperProps('Batch_Name__c')}
                />
              </Grid>
            </Grid>

            {/* ── Section 4: Write-Off ────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Write-Off
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={4}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.npe01__Written_Off__c}
                      onChange={(e) => handleFieldChange('npe01__Written_Off__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label="Written Off"
                />
              </Grid>
              <Grid item xs={12} sm={8}>
                <TextField
                  label="Write-Off Notes"
                  fullWidth
                  size="small"
                  multiline
                  rows={2}
                  disabled={!canEdit}
                  value={editForm.Write_off_reason__c || ''}
                  onChange={(e) => handleFieldChange('Write_off_reason__c', e.target.value)}
                  {...getHelperProps('Write_off_reason__c')}
                />
              </Grid>
            </Grid>

            {/* ── Section 5: Relationship (read-only links) ──────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Relationship
            </Typography>
            <Grid container spacing={1.5}>
              <Grid item xs={12} sm={6}>
                <Typography variant="body2" color="text.secondary">
                  <strong>Opportunity:</strong>{' '}
                  {originalRecord.npe01__Opportunity__r?.Name || '—'}
                </Typography>
              </Grid>
              <Grid item xs={12} sm={6}>
                <Typography variant="body2" color="text.secondary">
                  <strong>Account:</strong>{' '}
                  {originalRecord.npe01__Opportunity__r?.Account?.Name || '—'}
                </Typography>
              </Grid>
              {originalRecord.Invoice__c && (
                <Grid item xs={12} sm={6}>
                  <Typography variant="body2" color="text.secondary">
                    <strong>Invoice:</strong> {originalRecord.Invoice__c}
                  </Typography>
                </Grid>
              )}
            </Grid>

            {/* ── Read-only footer ────────────────────────────────── */}
            <Box sx={{ mt: 2.5, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                Payment #: {originalRecord.Name || '—'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Created: {formatDate(originalRecord.CreatedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Modified: {formatDate(originalRecord.LastModifiedDate)}
              </Typography>
            </Box>
          </>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {/*
          Destructive delete: left-aligned via marginRight:auto so the primary
          Save action stays on the right. ConfirmSaveButton handles the
          2-step opt-in (click Delete → read warning in popover → confirm).
          Hidden until the record has loaded (!originalRecord) — nothing to
          delete yet — and locked behind edit_payments permission.
        */}
        {originalRecord && canEdit && (
          <ConfirmSaveButton
            onConfirm={handleDelete}
            loading={deleting}
            disabled={!paymentId}
            variant="outlined"
            color="error"
            confirmTitle="Delete Payment?"
            confirmMessage="This permanently deletes the payment from Salesforce. This cannot be undone, and the parent opportunity's payment rollups will recalculate."
            confirmLabel="Delete"
            sx={{ mr: 'auto' }}
          >
            Delete
          </ConfirmSaveButton>
        )}
        <Button onClick={onClose} disabled={saving || deleting}>Cancel</Button>
        <ConfirmSaveButton
          onConfirm={handleSave}
          loading={saving}
          disabled={!canEdit || !originalRecord || deleting}
        >
          Save
        </ConfirmSaveButton>
      </DialogActions>

      <SaveBlockedDialog
        open={saveBlockedMissing.length > 0}
        onClose={() => setSaveBlockedMissing([])}
        missingFields={saveBlockedMissing}
        recordLabel="payment"
      />
    </Dialog>
  );
};

export default PaymentEditDialog;
