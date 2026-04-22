/**
 * Modal shown when an edit dialog's save handler detects that one or more
 * bound fields weren't loaded from the backend (SOQL gap). Blocks the save
 * so the user doesn't silently overwrite unseen data.
 *
 * Paired with `findMissingFields` from `utils/fieldLoadStatus.ts`. Each
 * edit dialog declares the list of fields it can save, and on save-click
 * checks whether the original record contains all of them. If not, it
 * opens this modal instead of patching SF.
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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

interface SaveBlockedDialogProps {
  open: boolean;
  onClose: () => void;
  missingFields: string[];
  /** Human-readable name of the record type, e.g. "opportunity", "contact". */
  recordLabel: string;
}

const SaveBlockedDialog: React.FC<SaveBlockedDialogProps> = ({
  open,
  onClose,
  missingFields,
  recordLabel,
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarningAmberIcon color="warning" />
        Save blocked — incomplete data
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          Bedrock couldn&rsquo;t load {missingFields.length === 1 ? 'one field' : `${missingFields.length} fields`}{' '}
          from this {recordLabel}. Saving now could silently overwrite values
          that are set in Salesforce but weren&rsquo;t fetched.
        </DialogContentText>
        <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
          Missing fields:
        </Typography>
        <Box
          component="ul"
          sx={{
            mt: 0.5,
            mb: 2,
            pl: 3,
            fontFamily: 'monospace',
            fontSize: '0.85rem',
          }}
        >
          {missingFields.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </Box>
        <DialogContentText>
          Close the dialog and reopen the record to reload. If the problem
          persists after a reload, it&rsquo;s likely a backend SOQL-field
          omission — please flag it for fixing.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SaveBlockedDialog;
