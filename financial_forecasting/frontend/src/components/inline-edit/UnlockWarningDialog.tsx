/**
 * UnlockWarningDialog — confirmation dialog shown when the user clicks the
 * lock icon on a sensitive or permission-gated field. The unlock applies
 * to a single edit and re-locks on save/blur.
 *
 * Used by `<InlineEditable>` (../inline-edit/InlineEditable.tsx). Not meant
 * to be used directly by feature code.
 */
import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Box,
  Typography,
} from '@mui/material';
import { LockOpen as UnlockIcon, WarningAmber as WarningIcon } from '@mui/icons-material';

interface UnlockWarningDialogProps {
  open: boolean;
  fieldLabel: string;
  reason: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const UnlockWarningDialog: React.FC<UnlockWarningDialogProps> = ({
  open,
  fieldLabel,
  reason,
  onConfirm,
  onCancel,
}) => (
  <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
    <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <WarningIcon sx={{ color: 'warning.main' }} />
      Edit sensitive field
    </DialogTitle>
    <DialogContent>
      <DialogContentText sx={{ mb: 1 }}>
        <Typography component="span" sx={{ fontWeight: 600 }}>{fieldLabel}</Typography>
      </DialogContentText>
      <DialogContentText>
        {reason}
      </DialogContentText>
      <Box sx={{ mt: 1.5, p: 1.25, bgcolor: 'grey.50', borderRadius: 1, border: '1px solid', borderColor: 'grey.200' }}>
        <Typography variant="caption" color="text.secondary">
          The field will unlock for a single edit and re-lock as soon as you save or click away.
        </Typography>
      </Box>
    </DialogContent>
    <DialogActions sx={{ px: 3, pb: 2 }}>
      <Button onClick={onCancel}>Cancel</Button>
      <Button
        onClick={onConfirm}
        variant="contained"
        color="warning"
        startIcon={<UnlockIcon />}
      >
        Unlock to edit
      </Button>
    </DialogActions>
  </Dialog>
);

export default UnlockWarningDialog;
