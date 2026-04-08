import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Typography,
  InputAdornment,
} from '@mui/material';
import { useOwnerGoals } from '../hooks/useOwnerGoals';
import { DEFAULT_GOAL } from '../config/goals';

interface EditOwnerGoalDialogProps {
  open: boolean;
  onClose: () => void;
  sfUserId: string;
  ownerName: string;
  fiscalYear: number;
  /** Current effective amount (from backend OR DEFAULT_GOAL fallback) */
  currentAmount: number;
  /** Whether the current amount is from a backend row (true) or the default fallback (false) */
  hasBackendGoal: boolean;
}

const MAX_GOAL = 100_000_000;

const EditOwnerGoalDialog: React.FC<EditOwnerGoalDialogProps> = ({
  open,
  onClose,
  sfUserId,
  ownerName,
  fiscalYear,
  currentAmount,
  hasBackendGoal,
}) => {
  const { upsertGoal, deleteGoal, isMutating } = useOwnerGoals(fiscalYear);
  const [amountText, setAmountText] = useState<string>(String(currentAmount));
  const [notes, setNotes] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setAmountText(String(currentAmount));
      setNotes('');
      setError(null);
    }
  }, [open, currentAmount]);

  const handleSave = async () => {
    const parsed = Number(amountText.replace(/,/g, ''));
    if (Number.isNaN(parsed) || parsed < 0) {
      setError('Goal amount must be a non-negative number.');
      return;
    }
    if (parsed > MAX_GOAL) {
      setError(`Goal amount cannot exceed $${MAX_GOAL.toLocaleString()}.`);
      return;
    }
    try {
      await upsertGoal(sfUserId, parsed, notes.trim() || undefined);
      onClose();
    } catch {
      // toast is shown by the hook; keep dialog open so user can retry
    }
  };

  const handleResetToDefault = async () => {
    try {
      await deleteGoal(sfUserId);
      onClose();
    } catch {
      // toast handled
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Edit Goal — {ownerName}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            FY{fiscalYear} annual revenue target
          </Typography>
          <TextField
            label="Goal amount"
            value={amountText}
            onChange={(e) => {
              setAmountText(e.target.value);
              setError(null);
            }}
            fullWidth
            autoFocus
            error={Boolean(error)}
            helperText={error || `Default if unset: $${DEFAULT_GOAL.toLocaleString()}`}
            InputProps={{
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            }}
            disabled={isMutating}
          />
          <TextField
            label="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            fullWidth
            multiline
            rows={2}
            disabled={isMutating}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, justifyContent: 'space-between' }}>
        <Button
          onClick={handleResetToDefault}
          disabled={isMutating || !hasBackendGoal}
          color="warning"
          size="small"
        >
          Reset to default
        </Button>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose} disabled={isMutating}>
            Cancel
          </Button>
          <Button onClick={handleSave} variant="contained" disabled={isMutating}>
            Save
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};

export default EditOwnerGoalDialog;
