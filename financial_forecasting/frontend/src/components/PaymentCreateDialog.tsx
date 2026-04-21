/**
 * PaymentCreateDialog — create a single Salesforce Payment (npe01__OppPayment__c)
 * on a given Opportunity.
 *
 * Distinct from PaymentEditDialog (which updates an existing record) and from
 * the bulk PaymentScheduleModal/PaymentSchedule page (which wipes and recreates
 * the whole schedule). This is the "+ Add Payment" button inside the Opp dialog's
 * inline Payment Schedule accordion — a fast path for appending one payment
 * without navigating away from the Opportunity.
 *
 * Minimum-field form by design: Amount, Scheduled Date, Payment Method (optional).
 * After creation the user can open PaymentEditDialog on the new row for the
 * remaining fields (GL Account, Reconciled, Batch Name, etc.).
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Grid,
  Typography,
  Alert,
  InputAdornment,
  Button,
} from '@mui/material';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { useSchemaPicklist } from '../hooks/useSchemaPicklist';

interface PaymentCreateDialogProps {
  open: boolean;
  onClose: () => void;
  opportunityId: string | null;
  /** Display-only — shown in the header so the user sees what Opp they're
   *  creating a payment for without cross-referencing. */
  opportunityName?: string | null;
  /** Called after a successful create so the parent can refresh its list. */
  onCreated?: (paymentId: string) => void;
}

const PaymentCreateDialog: React.FC<PaymentCreateDialogProps> = ({
  open,
  onClose,
  opportunityId,
  opportunityName,
  onCreated,
}) => {
  const { can, isAdmin } = usePermissions();
  const canEdit = isAdmin || can('edit_payments');

  const [amount, setAmount] = useState<string>('');
  const [scheduledDate, setScheduledDate] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // PR #164: unmounted-component guard. The parent Opp drawer can close mid-save
  // (user clicks outside the drawer while createSfPayment is in flight). When
  // the dialog unmounts, we skip the final setState + onCreated calls so we
  // don't trigger React's "state update on an unmounted component" warning or
  // try to mutate parent state that's already gone. The SF POST still lands —
  // just the UI follow-up is suppressed.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Reset form state each time the dialog opens so a stale prior-create doesn't
  // leak into the next one.
  useEffect(() => {
    if (open) {
      setAmount('');
      setScheduledDate('');
      setPaymentMethod('');
      setSaving(false);
      setErrors({});
    }
  }, [open]);

  // Schema-driven Payment Method picklist (same pattern as PaymentEditDialog).
  const paymentMethodPicklist = useSchemaPicklist(
    'npe01__OppPayment__c',
    'npe01__Payment_Method__c',
  );

  const handleSave = async () => {
    if (!opportunityId) return;

    const newErrors: Record<string, string> = {};
    const parsedAmount = parseFloat(amount);
    if (!amount || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      newErrors.amount = 'Amount must be greater than 0';
    }
    if (!scheduledDate) {
      newErrors.scheduledDate = 'Scheduled date is required';
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setSaving(true);
    try {
      const res = await apiService.createSfPayment({
        opportunity_id: opportunityId,
        amount: parsedAmount,
        scheduled_date: scheduledDate,
        payment_method: paymentMethod || null,
      });
      const newId = res.data?.data?.id ?? res.data?.id;
      // Unmounted-guard: if the parent drawer closed while the POST was in
      // flight, skip the success-path side effects. The SF record was still
      // created — just the UI follow-up is suppressed.
      if (!isMountedRef.current) return;
      toast.success('Payment created!');
      if (onCreated && typeof newId === 'string') {
        onCreated(newId);
      }
      onClose();
    } catch (error: any) {
      if (!isMountedRef.current) return;
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to create payment';
      toast.error(detail);
    } finally {
      // setSaving is only meaningful if we're still mounted.
      if (isMountedRef.current) {
        setSaving(false);
      }
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        Add Payment
        {opportunityName && (
          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 0.25 }}>
            {opportunityName}
          </Typography>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {!canEdit && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You don't have permission to create payments.
          </Alert>
        )}

        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Amount"
              fullWidth
              size="small"
              type="number"
              required
              disabled={!canEdit}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                if (errors.amount) {
                  setErrors((prev) => ({ ...prev, amount: '' }));
                }
              }}
              InputProps={{
                startAdornment: <InputAdornment position="start">$</InputAdornment>,
              }}
              error={!!errors.amount}
              helperText={errors.amount}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              label="Scheduled Date"
              fullWidth
              size="small"
              type="date"
              required
              disabled={!canEdit}
              value={scheduledDate}
              onChange={(e) => {
                setScheduledDate(e.target.value);
                if (errors.scheduledDate) {
                  setErrors((prev) => ({ ...prev, scheduledDate: '' }));
                }
              }}
              InputLabelProps={{ shrink: true }}
              error={!!errors.scheduledDate}
              helperText={errors.scheduledDate}
            />
          </Grid>
          <Grid item xs={12} sm={6}>
            {paymentMethodPicklist.options.length > 0 ? (
              <TextField
                label="Payment Method"
                fullWidth
                size="small"
                select
                disabled={!canEdit}
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
              >
                <MenuItem value="">None</MenuItem>
                {paymentMethodPicklist.options.map((v) => (
                  <MenuItem key={v} value={v}>{v}</MenuItem>
                ))}
              </TextField>
            ) : (
              <TextField
                label="Payment Method"
                fullWidth
                size="small"
                disabled
                value=""
                helperText={paymentMethodPicklist.error
                  ? 'Payment Method list unavailable'
                  : 'No active payment methods available'}
              />
            )}
          </Grid>
        </Grid>

        <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
          Additional fields (Department, GL Account, Reconciled, etc.) can be edited
          from the payment row after creation.
        </Typography>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <ConfirmSaveButton
          onConfirm={handleSave}
          loading={saving}
          disabled={!canEdit || !opportunityId}
          confirmTitle="Create Payment?"
          confirmMessage="This creates a new payment record in Salesforce on this opportunity."
          confirmLabel="Create"
        >
          Create
        </ConfirmSaveButton>
      </DialogActions>
    </Dialog>
  );
};

export default PaymentCreateDialog;
