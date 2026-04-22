import React, { useState } from 'react';
import {
  Box, Chip, Autocomplete, TextField, IconButton, Tooltip, Typography,
  Dialog, DialogTitle, DialogContent, DialogActions, Button, MenuItem, Menu,
} from '@mui/material';
import {
  Star as OwnerIcon,
  PersonAdd as AddIcon,
  SwapHoriz as TransferIcon,
} from '@mui/icons-material';
import { useAuth } from '../../contexts/AuthContext';
import { usePermissions } from '../../contexts/PermissionsContext';
import type { ActiveUser, ProjectContributor } from './types';
import { useActiveUsers } from './useActiveUsers';

interface ProjectTeamProps {
  projectId: string;
  ownerEmail: string | null;
  contributors: ProjectContributor[];
  onAddContributor: (projectId: string, userEmail: string) => void;
  onRemoveContributor: (projectId: string, userEmail: string) => void;
  onTransferOwnership: (projectId: string, newOwnerEmail: string) => void;
}

function displayName(email: string, users: ActiveUser[]): string {
  const u = users.find((p) => p.email === email);
  if (u?.display_name) return u.display_name;
  // Fallback: show part before @
  return email.split('@')[0];
}

const ProjectTeam: React.FC<ProjectTeamProps> = ({
  projectId, ownerEmail, contributors,
  onAddContributor, onRemoveContributor, onTransferOwnership,
}) => {
  const { user } = useAuth();
  const { isAdmin } = usePermissions();
  const [addOpen, setAddOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [ownerMenuAnchor, setOwnerMenuAnchor] = useState<null | HTMLElement>(null);

  const currentEmail = user?.email || '';
  const canManage = currentEmail === ownerEmail || isAdmin;

  // All active staff are pickable. Edit capability on the project is still
  // gated by each user's permission profile — a contributor without
  // edit_projects can view but not mutate.
  const { activeUsers } = useActiveUsers();

  // Filter out owner and existing contributors from the add picker
  const contributorEmails = new Set(contributors.map((c) => c.user_email));
  const addCandidates = activeUsers.filter(
    (u) => u.email !== ownerEmail && !contributorEmails.has(u.email)
  );
  const transferCandidates = activeUsers.filter(
    (u) => u.email !== ownerEmail
  );

  const handleAddSelect = (_: any, value: ActiveUser | null) => {
    if (value) {
      onAddContributor(projectId, value.email);
      setAddOpen(false);
    }
  };

  const handleTransferConfirm = () => {
    if (transferTarget) {
      onTransferOwnership(projectId, transferTarget);
      setTransferTarget(null);
    }
  };

  if (!ownerEmail && !contributors.length) {
    return null;
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5, fontSize: '0.7rem' }}>
        Team:
      </Typography>

      {/* Owner chip */}
      {ownerEmail && (
        <>
          <Chip
            icon={<OwnerIcon sx={{ fontSize: 14 }} />}
            label={displayName(ownerEmail, activeUsers)}
            size="small"
            color="primary"
            variant="outlined"
            onClick={canManage ? (e) => setOwnerMenuAnchor(e.currentTarget) : undefined}
            sx={{ height: 24, fontSize: '0.75rem', '& .MuiChip-icon': { ml: 0.5 } }}
          />
          <Menu
            anchorEl={ownerMenuAnchor}
            open={!!ownerMenuAnchor}
            onClose={() => setOwnerMenuAnchor(null)}
          >
            <MenuItem
              onClick={() => {
                setOwnerMenuAnchor(null);
                setTransferTarget('');
              }}
              sx={{ fontSize: '0.8rem' }}
            >
              <TransferIcon sx={{ fontSize: 16, mr: 1 }} /> Transfer ownership
            </MenuItem>
          </Menu>
        </>
      )}

      {!ownerEmail && canManage && (
        <Chip
          label="No owner — assign"
          size="small"
          variant="outlined"
          color="warning"
          onClick={() => setTransferTarget('')}
          sx={{ height: 24, fontSize: '0.75rem', cursor: 'pointer' }}
        />
      )}

      {!ownerEmail && !canManage && (
        <Chip
          label="No owner"
          size="small"
          variant="outlined"
          color="warning"
          sx={{ height: 24, fontSize: '0.75rem' }}
        />
      )}

      {/* Editor chips */}
      {contributors.map((c) => (
        <Chip
          key={c.user_email}
          label={displayName(c.user_email, activeUsers)}
          size="small"
          variant="outlined"
          onDelete={canManage ? () => onRemoveContributor(projectId, c.user_email) : undefined}
          sx={{ height: 24, fontSize: '0.75rem' }}
        />
      ))}

      {/* Add button */}
      {canManage && !addOpen && (
        <Tooltip title="Add contributor">
          <IconButton size="small" onClick={() => setAddOpen(true)} sx={{ p: 0.25 }}>
            <AddIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}

      {/* Inline autocomplete for adding */}
      {addOpen && (
        <Autocomplete
          autoFocus
          openOnFocus
          size="small"
          options={addCandidates}
          getOptionLabel={(o) => o.display_name ? `${o.display_name} (${o.email})` : o.email}
          onChange={handleAddSelect}
          onClose={() => setAddOpen(false)}
          renderInput={(params) => (
            <TextField
              {...params}
              placeholder="Add..."
              sx={{ width: 180, '& .MuiInputBase-root': { height: 28, fontSize: '0.75rem' } }}
            />
          )}
          sx={{ '& .MuiAutocomplete-listbox': { fontSize: '0.8rem' } }}
        />
      )}

      {/* Transfer / assign ownership dialog */}
      <Dialog open={transferTarget !== null} onClose={() => setTransferTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{ownerEmail ? 'Transfer Ownership' : 'Assign Owner'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {ownerEmail
              ? 'The current owner will become an editor. Select the new owner:'
              : 'This project has no owner. Select an owner:'}
          </Typography>
          <Autocomplete
            autoFocus
            openOnFocus
            size="small"
            options={transferCandidates}
            getOptionLabel={(o) => o.display_name ? `${o.display_name} (${o.email})` : o.email}
            onChange={(_, value) => setTransferTarget(value?.email || '')}
            renderInput={(params) => (
              <TextField {...params} placeholder="Select new owner..." />
            )}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTransferTarget(null)}>Cancel</Button>
          <Button
            onClick={handleTransferConfirm}
            variant="contained"
            disabled={!transferTarget}
          >
            Transfer
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ProjectTeam;
