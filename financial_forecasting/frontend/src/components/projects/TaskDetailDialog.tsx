import React, { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button,
  TextField, Select, MenuItem, FormControl, InputLabel, Box,
  Chip, Typography, IconButton,
} from '@mui/material';
import { Close as CloseIcon, Delete as DeleteIcon } from '@mui/icons-material';
import OwnerSelector, { type OwnerOption } from '../OwnerSelector';
import type { ActiveUser, FlatTask, ProjectMutations } from './types';
import { TASK_STATUSES } from './constants';

interface TaskDetailDialogProps {
  task: FlatTask | null;
  onClose: () => void;
  mutations: ProjectMutations;
  activeUsers: ActiveUser[];
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

const TaskDetailDialog: React.FC<TaskDetailDialogProps> = ({ task, onClose, mutations, activeUsers }) => {
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState('');
  const [owner, setOwner] = useState('');                 // "Other" free-text
  const [ownerIds, setOwnerIds] = useState<string[]>([]); // structured multi-owner
  const [startDate, setStartDate] = useState('');
  const [deadline, setDeadline] = useState('');
  const [description, setDescription] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setStatus(task.status);
      setOwner(task.owner || '');
      setOwnerIds(task.owner_ids || []);
      setStartDate(task.startDate || '');
      setDeadline(task.deadline || '');
      setDescription(task.description || '');
      setConfirmDelete(false);
    }
  }, [task]);

  const ownerOptions: OwnerOption[] = activeUsers.map((u) => ({ id: u.id, name: u.display_name }));

  if (!task) return null;

  const handleSave = () => {
    const changes: Record<string, any> = {};
    if (title !== task.title) changes.title = title;
    if (status !== task.status) changes.status = status;
    if (owner !== (task.owner || '')) changes.owner = owner;
    if (!arraysEqual(ownerIds, task.owner_ids || [])) changes.owner_ids = ownerIds;
    if (startDate !== (task.startDate || '')) changes.start_date = startDate || null;
    if (deadline !== (task.deadline || '')) changes.deadline = deadline || null;
    if (description !== (task.description || '')) changes.description = description;

    if (Object.keys(changes).length > 0) {
      mutations.updateTask(task.id, changes);
    }
    onClose();
  };

  const handleDelete = () => {
    mutations.deleteTask(task.id);
    onClose();
  };

  return (
    <Dialog open={!!task} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1 }}>Edit Task</Typography>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <TextField
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          fullWidth
          size="small"
          sx={{ mt: 1 }}
        />

        <FormControl size="small" fullWidth>
          <InputLabel>Status</InputLabel>
          <Select value={status} label="Status" onChange={e => setStatus(e.target.value)}>
            {TASK_STATUSES.map(s => (
              <MenuItem key={s} value={s}>{s}</MenuItem>
            ))}
          </Select>
        </FormControl>

        <OwnerSelector
          availableOwners={ownerOptions}
          value={ownerIds}
          onChange={setOwnerIds}
          label="Owners"
          placeholder="Pick one or more teammates…"
        />
        <TextField
          label="Other (external support, placeholder)"
          placeholder="e.g. McKinsey, Hudson Ferris, TBD"
          value={owner}
          onChange={e => setOwner(e.target.value)}
          size="small"
          fullWidth
          helperText="Free-text for anyone who isn't an active Pursuit teammate."
        />

        <Box sx={{ display: 'flex', gap: 2 }}>
          <TextField
            label="Start Date"
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            size="small"
            sx={{ flex: 1 }}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            label="Deadline"
            type="date"
            value={deadline}
            onChange={e => setDeadline(e.target.value)}
            size="small"
            sx={{ flex: 1 }}
            InputLabelProps={{ shrink: true }}
          />
        </Box>

        <TextField
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          multiline
          rows={3}
          fullWidth
          size="small"
        />

        {/* Context info (read-only) */}
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
          <Chip label={task.workstreamName} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} />
          <Chip label={task.milestoneTitle} size="small" variant="outlined" sx={{ fontSize: '0.7rem' }} />
          {task.dependsOn && task.dependsOn.length > 0 && (
            <Chip
              label={`${task.dependsOn.length} dependenc${task.dependsOn.length === 1 ? 'y' : 'ies'}`}
              size="small"
              variant="outlined"
              sx={{ fontSize: '0.7rem' }}
            />
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
        <Box>
          {confirmDelete ? (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Typography variant="caption" color="error">Move to trash?</Typography>
              <Button size="small" color="error" variant="contained" onClick={handleDelete}>Yes, move to trash</Button>
              <Button size="small" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </Box>
          ) : (
            <Button
              size="small"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="contained" onClick={handleSave}>Save</Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};

export default TaskDetailDialog;
