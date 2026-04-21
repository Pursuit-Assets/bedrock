import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  TextField,
  IconButton,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Paper,
  CircularProgress,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import { toast } from 'react-hot-toast';
import { apiService } from '../services/api';
import PaymentEditDialog from '../components/PaymentEditDialog';

interface PaymentRow {
  amount: number;
  scheduled_date: string;
  /** Salesforce Id — present when the row was loaded from SF, absent for drafts
   *  the user is still adding (those get persisted via the bulk savePaymentSchedule). */
  Id?: string;
}

export default function PaymentSchedule() {
  const { opportunityId } = useParams<{ opportunityId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  
  // Check if we came from a stage change
  const fromStageChange = location.state?.fromStageChange;
  const targetStage = location.state?.targetStage;
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [opportunity, setOpportunity] = useState<any>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([
    { amount: 0, scheduled_date: '' }
  ]);

  // ── Payment detail dialog (Edit Details clickthrough) ────────────────────
  // When the user clicks Edit Details on a saved payment row, we lazy-fetch
  // the full SF record via getSfOpportunityPayments (the /api/opportunities/
  // :id/payment-schedule response is a simplified 5-field projection that
  // PaymentEditDialog can't render from). Then open PaymentEditDialog with
  // that full record as initialData.
  const [detailPaymentId, setDetailPaymentId] = useState<string | null>(null);
  const [detailPaymentData, setDetailPaymentData] = useState<Record<string, any> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    loadPaymentSchedule();
  }, [opportunityId]);

  const loadPaymentSchedule = async () => {
    try {
      setLoading(true);
      const response = await apiService.getPaymentSchedule(opportunityId!);
      const data = response.data;
      
      setOpportunity(data.opportunity);
      
      if (data.payments && data.payments.length > 0) {
        // Load existing payments. Retain Salesforce `Id` so rows persisted in
        // SF can be opened in the PaymentEditDialog via Edit Details — drafts
        // (added client-side but not yet bulk-saved) will lack an Id and
        // therefore won't show the Edit Details button.
        setPayments(data.payments.map((p: any) => ({
          amount: p.Amount,
          scheduled_date: p.ScheduledDate,
          Id: p.Id,
        })));
      } else {
        // Default: single payment for full amount
        setPayments([{
          amount: data.opportunity.Amount || 0,
          scheduled_date: ''
        }]);
      }
    } catch (error: any) {
      toast.error('Failed to load opportunity details');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const addPayment = () => {
    setPayments([...payments, { amount: 0, scheduled_date: '' }]);
  };

  const removePayment = (index: number) => {
    if (payments.length > 1) {
      setPayments(payments.filter((_, i) => i !== index));
    }
  };

  /**
   * Lazy-fetch the full Salesforce Payment record (29 native SF fields via
   * PAYMENT_SOQL_FIELDS on the backend) and open PaymentEditDialog with it as
   * initialData. Runs per-click; the backend endpoint is cached at 5min so
   * repeated clicks within that window are cheap. Surfaces detailed errors
   * from the API response so the user sees a meaningful toast on failure.
   */
  const handleEditDetails = async (paymentId: string) => {
    setDetailLoading(true);
    try {
      const res = await apiService.getSfOpportunityPayments(opportunityId!);
      // Backend returns the records array directly (main.py `return records`).
      const records: any[] = Array.isArray(res.data) ? res.data : [];
      const full = records.find((p) => p.Id === paymentId);
      if (!full) {
        toast.error('Payment not found');
        return;
      }
      setDetailPaymentData(full);
      setDetailPaymentId(paymentId);
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.response?.data?.error ||
        err?.message ||
        'Failed to load payment details';
      toast.error(detail);
      // eslint-disable-next-line no-console
      console.error('getSfOpportunityPayments failed:', err);
    } finally {
      setDetailLoading(false);
    }
  };

  // Wired to both onSaved and onDeleted — PaymentEditDialog's save and delete
  // flows have identical parent-side semantics (close the detail dialog,
  // refresh the schedule table). Renamed from `handleDetailSaved` in PR #164
  // per adversarial-review feedback: `onDeleted={handleDetailSaved}` was
  // semantically misleading in the caller wiring.
  const handleDetailClosed = () => {
    // PaymentEditDialog hits /api/salesforce/payments/{id} directly, which
    // doesn't share a react-query cache key with getPaymentSchedule — so we
    // explicitly refresh. If the refresh fails the schedule table retains
    // stale data; the toast from the child dialog already indicated success.
    setDetailPaymentId(null);
    setDetailPaymentData(null);
    loadPaymentSchedule();
  };

  // Separate from handleDetailClosed because cancel/close doesn't require a
  // refresh (nothing changed).
  const handleDetailClose = () => {
    setDetailPaymentId(null);
    setDetailPaymentData(null);
  };

  const updatePayment = (index: number, field: keyof PaymentRow, value: any) => {
    const updated = [...payments];
    updated[index] = { ...updated[index], [field]: value };
    setPayments(updated);
  };

  const calculateTotal = () => {
    return payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  };

  const getDifference = () => {
    if (!opportunity) return 0;
    return calculateTotal() - opportunity.Amount;
  };

  const isValid = () => {
    if (!opportunity) return false;
    const total = calculateTotal();
    const diff = Math.abs(total - opportunity.Amount);
    
    // Check all payments have amount and date
    const allComplete = payments.every(p => 
      p.amount > 0 && p.scheduled_date !== ''
    );
    
    return diff < 0.01 && allComplete;
  };

  const handleSave = async () => {
    if (!isValid()) {
      toast.error('Please ensure all payments have amounts and dates, and total matches opportunity amount');
      return;
    }

    try {
      setSaving(true);
      
      // Save payment schedule
      await apiService.savePaymentSchedule(opportunityId!, payments);
      
      // Update opportunity stage if we came from a stage change
      if (fromStageChange && targetStage) {
        await apiService.updateOpportunityStage(opportunityId!, targetStage);
        toast.success(`Payment schedule saved and opportunity moved to ${targetStage}!`);
      } else {
        // Default behavior - move to Collecting / In Effect
        await apiService.updateOpportunityStage(opportunityId!, 'Collecting / In Effect');
        toast.success('Payment schedule created and opportunity moved to Collecting / In Effect!');
      }
      
      // Redirect back to opportunities or revenue page
      setTimeout(() => {
        navigate(fromStageChange ? '/opportunities' : '/revenue');
      }, 1500);
      
    } catch (error: any) {
      const errorMsg = error.response?.data?.detail?.message || error.response?.data?.detail || 'Failed to save payment schedule';
      toast.error(errorMsg);
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    navigate('/finance-dashboard');
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  if (!opportunity) {
    return (
      <Box p={3}>
        <Alert severity="error">Opportunity not found</Alert>
      </Box>
    );
  }

  const total = calculateTotal();
  const difference = getDifference();
  const diffAbs = Math.abs(difference);

  return (
    <Box p={3}>
      <Typography variant="h4" gutterBottom fontWeight="bold">
        {fromStageChange ? 'Review Payment Schedule' : 'Create Payment Schedule'}
      </Typography>

      {fromStageChange && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Please review and confirm the payment schedule before moving to "{targetStage}"
        </Alert>
      )}

      {/* Opportunity Info */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            {opportunity.Name}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Opportunity Amount: <strong>${opportunity.Amount?.toLocaleString()}</strong>
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Current Stage: {opportunity.StageName}
          </Typography>
        </CardContent>
      </Card>

      {/* Instructions */}
      <Alert severity="info" sx={{ mb: 3 }}>
        Create a payment schedule for this opportunity. The total of all payments must equal the opportunity amount.
        Once saved, the opportunity will move to "Collecting / In Effect" stage.
      </Alert>

      {/* Payment Schedule Table */}
      <Paper sx={{ mb: 3 }}>
        <Box p={2}>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">Payment Schedule</Typography>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={addPayment}
            >
              Add Payment
            </Button>
          </Box>

          <Table>
            <TableHead>
              <TableRow>
                <TableCell width="50px">#</TableCell>
                <TableCell>Amount</TableCell>
                <TableCell>Scheduled Date</TableCell>
                <TableCell width="100px">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {payments.map((payment, index) => (
                <TableRow key={index}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell>
                    <TextField
                      type="number"
                      value={payment.amount || ''}
                      onChange={(e) => updatePayment(index, 'amount', parseFloat(e.target.value) || 0)}
                      placeholder="0.00"
                      InputProps={{
                        startAdornment: <Typography sx={{ mr: 1 }}>$</Typography>,
                      }}
                      fullWidth
                      size="small"
                    />
                  </TableCell>
                  <TableCell>
                    <TextField
                      type="date"
                      value={payment.scheduled_date}
                      onChange={(e) => updatePayment(index, 'scheduled_date', e.target.value)}
                      fullWidth
                      size="small"
                      InputLabelProps={{ shrink: true }}
                    />
                  </TableCell>
                  <TableCell>
                    {/* Edit Details opens PaymentEditDialog for a saved row
                        (one with a Salesforce Id). Drafts the user just
                        added don't have an Id yet — only bulk-save via
                        savePaymentSchedule persists them, so there's
                        nothing to drill into. */}
                    {payment.Id && (
                      <IconButton
                        onClick={() => handleEditDetails(payment.Id!)}
                        disabled={detailLoading}
                        title="Edit payment details"
                        size="small"
                      >
                        <EditIcon />
                      </IconButton>
                    )}
                    <IconButton
                      onClick={() => removePayment(index)}
                      disabled={payments.length === 1}
                      color="error"
                      size="small"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Total Summary */}
          <Box mt={3} p={2} bgcolor="grey.100" borderRadius={1}>
            <Box display="flex" justifyContent="space-between" mb={1}>
              <Typography variant="body1">
                <strong>Opportunity Amount:</strong>
              </Typography>
              <Typography variant="body1">
                ${opportunity.Amount?.toLocaleString()}
              </Typography>
            </Box>
            <Box display="flex" justifyContent="space-between" mb={1}>
              <Typography variant="body1">
                <strong>Payment Total:</strong>
              </Typography>
              <Typography variant="body1" color={diffAbs < 0.01 ? 'success.main' : 'error.main'}>
                ${total.toLocaleString()}
              </Typography>
            </Box>
            {diffAbs >= 0.01 && (
              <Box display="flex" justifyContent="space-between">
                <Typography variant="body1">
                  <strong>Difference:</strong>
                </Typography>
                <Typography variant="body1" color="error">
                  {difference > 0 ? '+' : ''}{difference < 0 ? '' : ''}${diffAbs.toLocaleString()}
                </Typography>
              </Box>
            )}
          </Box>

          {/* Validation Message */}
          {diffAbs >= 0.01 && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Payment total must equal opportunity amount. 
              {difference > 0 ? ` Reduce by $${diffAbs.toLocaleString()}` : ` Add $${diffAbs.toLocaleString()}`}
            </Alert>
          )}

          {!payments.every(p => p.amount > 0 && p.scheduled_date) && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              All payments must have an amount and scheduled date.
            </Alert>
          )}
        </Box>
      </Paper>

      {/* Action Buttons */}
      <Box display="flex" gap={2} justifyContent="flex-end">
        <Button
          variant="outlined"
          onClick={handleCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress size={20} /> : <SaveIcon />}
          onClick={handleSave}
          disabled={!isValid() || saving}
        >
          {saving ? 'Saving...' : 'Save & Move to Collecting'}
        </Button>
      </Box>

      {/* PaymentEditDialog — opened by the Edit Details button per row.
          PaymentEditDialog hits /api/salesforce/payments/{id} (not the
          opp-scoped payment_schedules.py endpoint), so we call
          loadPaymentSchedule() in onSaved to keep the schedule table in sync. */}
      <PaymentEditDialog
        open={detailPaymentId !== null}
        onClose={handleDetailClose}
        paymentId={detailPaymentId}
        initialData={detailPaymentData ?? undefined}
        onSaved={handleDetailClosed}
        onDeleted={handleDetailClosed}
      />
    </Box>
  );
}

