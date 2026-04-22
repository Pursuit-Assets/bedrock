import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Chip,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  FormHelperText,
  InputLabel,
  Divider,
  CircularProgress,
  Tooltip,
  Collapse,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Autocomplete,
} from '@mui/material';
import {
  Close as CloseIcon,
  Add as AddIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  CheckCircle as CheckCircleIcon,
  RadioButtonUnchecked as UncheckedIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Flag as FlagIcon,
  CalendarToday as CalendarIcon,
  Person as PersonIcon,
  Save as SaveIcon,
  Cancel as CancelIcon,
  Sort as SortIcon,
  ContentCopy as DuplicateIcon,
  Link as LinkIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { useSchemaPicklist } from '../hooks/useSchemaPicklist';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import SaveStatusIndicator from './SaveStatusIndicator';
import { fieldStatusProps, getFieldLoadStatus, findMissingFields } from '../utils/fieldLoadStatus';
import SaveBlockedDialog from './SaveBlockedDialog';

// Task fields the inline edit form can save. WhoId added PR #169 for the
// new Contact autocomplete. DriveLink is a UI-only stub (tracked for
// removal in Lane B13 `pr-drivelink-stub-fix`), so it's excluded — no SF
// field to compare against.
const TASK_EDITABLE_FIELDS: readonly string[] = [
  'Subject',
  'Status',
  'Priority',
  'ActivityDate',
  'OwnerId',
  'WhatId',
  'WhoId',
  'Description',
] as const;

interface Task {
  Id: string;
  Subject: string;
  Status: string;
  Priority: string;
  ActivityDate: string | null;
  Description: string | null;
  OwnerId: string;
  OwnerName: string | null;
  WhoId?: string | null;
  WhoName?: string | null;
  CreatedById?: string | null;
  CreatedByName?: string | null;
  CreatedDate: string;
  LastModifiedDate: string;
  Type: string | null;
  TaskSubtype: string | null;
  WhatId?: string | null;
}

interface Opportunity {
  Id: string;
  Name: string;
  Account?: { Name: string } | null;
  StageName: string;
  Amount: number | null;
  Probability: number | null;
  CloseDate: string | null;
  Owner?: { Name: string } | null;
}

interface OrphanTask {
  Id: string;
  Subject: string;
  Status: string;
  Priority: string;
  ActivityDate: string | null;
  Description: string | null;
  OwnerId: string;
  OwnerName?: string | null;
  WhatId?: string | null;
}

interface TaskPanelProps {
  open: boolean;
  onClose: () => void;
  opportunity: Opportunity | null;
  users?: Array<{ Id: string; Name: string }>;
  selectedTaskId?: string | null;
  editOnOpen?: boolean;
  orphanTask?: OrphanTask | null;
  opportunities?: Array<{ Id: string; Name: string }>;
}

const STATUS_COLORS: Record<string, string> = {
  'Not Started': '#9e9e9e',
  'In Progress': '#1565c0',
  'Completed': '#4caf50',
  'Deferred': '#bdbdbd',
  'No Status': '#bdbdbd',
};

const PRIORITY_COLORS: Record<string, string> = {
  'High': '#d32f2f',
  'Normal': '#e57373',
  'Low': '#9e9e9e',
};

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatCurrency = (value: number | null) => {
  if (value === null || value === undefined) return '$0';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
};

const isOverdue = (dateStr: string | null, status: string) => {
  if (!dateStr || status === 'Completed') return false;
  return new Date(dateStr) < new Date();
};

const TASK_PANEL_PREFS_KEY = 'pursuit-task-panel-prefs';
const DEFAULT_WIDTH = 680;
const MIN_WIDTH = 480;
const MAX_WIDTH = 900;

function loadTaskPanelWidth(): number {
  try {
    const raw = localStorage.getItem(TASK_PANEL_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const w = parsed?.width ?? DEFAULT_WIDTH;
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));
    }
  } catch {}
  return DEFAULT_WIDTH;
}

function saveTaskPanelWidth(width: number) {
  localStorage.setItem(TASK_PANEL_PREFS_KEY, JSON.stringify({ width }));
}

const TaskPanel: React.FC<TaskPanelProps> = ({ open, onClose, opportunity, users, selectedTaskId, editOnOpen, orphanTask, opportunities }) => {
  const queryClient = useQueryClient();
  const { sfUserId, isAdmin } = usePermissions();

  // Fetch opportunity locks to determine if current opp is locked
  const { data: locksData } = useQuery('opportunity-locks', async () => {
    const res = await apiService.getOpportunityLocks();
    return res.data?.data || [];
  }, { enabled: open, staleTime: 30_000 });

  const oppLock = useMemo(() => {
    if (!opportunity?.Id || !locksData) return null;
    return locksData.find((l: any) => l.sf_opportunity_id === opportunity.Id) || null;
  }, [opportunity?.Id, locksData]);

  const isOppLocked = !!oppLock;
  const isLockOwner = oppLock?.locked_by === sfUserId;
  const canEditLockedOpp = isLockOwner || isAdmin;
  const [width, setWidth] = useState(loadTaskPanelWidth);
  const widthRef = useRef(width);
  const resizeRef = useRef<{ active: boolean; startX: number; startWidth: number }>({ active: false, startX: 0, startWidth: 0 });

  widthRef.current = width;

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { active: true, startX: e.clientX, startWidth: widthRef.current };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: globalThis.MouseEvent) => {
      if (!resizeRef.current.active) return;
      const dx = e.clientX - resizeRef.current.startX; // drag right = wider, drag left = narrower
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeRef.current.startWidth + dx));
      setWidth(newWidth);
    };
    const onMouseUp = () => {
      if (resizeRef.current.active) {
        saveTaskPanelWidth(widthRef.current);
        resizeRef.current.active = false;
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [taskSort, setTaskSort] = useState<'asc' | 'desc'>('asc');
  const [saveBlockedMissing, setSaveBlockedMissing] = useState<string[]>([]);

  // Schema-driven Status + Priority picklists (PR #169 / B6). Each hook
  // shares the 30-min react-query cache keyed on (sobject, fieldName).
  // Empty options → fall back to the prior hardcoded MenuItems below.
  const statusPicklist = useSchemaPicklist('Task', 'Status');
  const priorityPicklist = useSchemaPicklist('Task', 'Priority');

  // Contact autocomplete options (PR #169 / B5 — new Contact link via WhoId).
  // Reuse the existing /api/salesforce/contacts list endpoint; small list at
  // Pursuit's scale, fits inside an Autocomplete without server-side search.
  const { data: contactOptionsData } = useQuery(
    'taskpanel-contacts',
    async () => {
      const res = await apiService.getContacts();
      const data = res.data?.data || res.data || [];
      return Array.isArray(data) ? data : [];
    },
    { enabled: open, staleTime: 5 * 60 * 1000 }
  );
  const contactOptions: Array<{ Id: string; Name: string }> = useMemo(
    () => (contactOptionsData ?? []).map((c: any) => ({ Id: c.Id, Name: c.Name })),
    [contactOptionsData],
  );

  // New task form state
  const [newTask, setNewTask] = useState({
    Subject: '',
    Status: 'Not Started',
    Priority: 'Normal',
    ActivityDate: '',
    Description: '',
    OwnerId: '',
    WhoId: '',
    DriveLink: '',
  });

  // Edit task form state
  const [editTask, setEditTask] = useState({
    Subject: '',
    Status: '',
    Priority: '',
    ActivityDate: '',
    Description: '',
    OwnerId: '',
    WhoId: '',
    DriveLink: '',
    WhatId: '',
  });

  // Fetch tasks for the selected opportunity
  const { data: tasksData, isLoading: tasksLoading } = useQuery(
    ['opportunity-tasks', opportunity?.Id],
    async () => {
      if (!opportunity?.Id) return null;
      const response = await apiService.getOpportunityTasks(opportunity.Id);
      return response.data;
    },
    {
      enabled: !!opportunity?.Id && open,
    }
  );

  const tasks: Task[] = tasksData?.data || tasksData?.tasks || [];

  // Track which task was already auto-edited to prevent re-triggers
  const autoEditedRef = useRef<string | null>(null);

  // Auto-expand selected task and optionally enter edit mode
  useEffect(() => {
    if (selectedTaskId && tasks.length > 0) {
      setExpandedTaskId(selectedTaskId);
      // Enter edit mode directly if editOnOpen is set (from "Edit Task" click)
      if (editOnOpen && autoEditedRef.current !== selectedTaskId) {
        const task = tasks.find(t => t.Id === selectedTaskId);
        if (task) {
          autoEditedRef.current = selectedTaskId;
          startEditing(task);
        }
      }
      // Scroll into view after render
      requestAnimationFrame(() => {
        const el = document.getElementById(`task-item-${selectedTaskId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }, [selectedTaskId, editOnOpen, tasks.length]);

  // Reset auto-edit tracking when panel closes
  useEffect(() => {
    if (!open) {
      autoEditedRef.current = null;
    }
  }, [open]);

  // Fetch available projects for "Assign to Project" dropdown
  const { data: projectsData } = useQuery(
    ['projects-list'],
    async () => {
      const response = await apiService.getProjects();
      return response.data?.data || [];
    },
    { enabled: open, staleTime: 60_000 }
  );
  const projects: Array<{ id: string; name: string }> = projectsData || [];

  // Fetch task dependencies scoped to this opportunity's tasks
  const taskIds = useMemo(() => tasks.map(t => t.Id), [tasks]);
  const { data: depsData } = useQuery(
    ['sf-task-deps', taskIds.join(',')],
    async () => {
      if (taskIds.length === 0) return [];
      const response = await apiService.getTaskDependenciesForOpp(taskIds);
      return response.data?.data || [];
    },
    { enabled: open && taskIds.length > 0, staleTime: 30_000 }
  );

  // Build dependency map: taskId -> array of { depId, dependsOnId }
  const depMap = useMemo(() => {
    const map = new Map<string, Array<{ depId: string; dependsOnId: string }>>();
    for (const dep of (depsData || [])) {
      const existing = map.get(dep.task_id) || [];
      existing.push({ depId: dep.id, dependsOnId: dep.depends_on_id });
      map.set(dep.task_id, existing);
    }
    return map;
  }, [depsData]);

  // Add/remove dependency mutations
  const addDepMutation = useMutation(
    async ({ taskId, dependsOnId }: { taskId: string; dependsOnId: string }) => {
      return apiService.addTaskDependency(taskId, dependsOnId);
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['sf-task-deps']);
        toast.success('Dependency added');
      },
      onError: (err: any) => { toast.error(`Failed to add dependency: ${err.message || 'Unknown error'}`); },
    }
  );

  const removeDepMutation = useMutation(
    async (depId: string) => {
      return apiService.removeTaskDependency(depId);
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['sf-task-deps']);
        toast.success('Dependency removed');
      },
      onError: (err: any) => { toast.error(`Failed to remove dependency: ${err.message || 'Unknown error'}`); },
    }
  );

  // Link/unlink task to project mutations
  const linkToProjectMutation = useMutation(
    async ({ sfTaskId, projectId }: { sfTaskId: string; projectId: string }) => {
      return apiService.linkSfTaskToProject(projectId, { sf_task_id: sfTaskId });
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['sf-task-project-links']);
        toast.success('Task assigned to project');
      },
      onError: (err: any) => { toast.error(`Failed to assign to project: ${err.message || 'Unknown error'}`); },
    }
  );

  const unlinkFromProjectMutation = useMutation(
    async (linkId: string) => {
      return apiService.unlinkSfTaskFromProject(linkId);
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['sf-task-project-links']);
        toast.success('Task removed from project');
      },
      onError: (err: any) => { toast.error(`Failed to remove from project: ${err.message || 'Unknown error'}`); },
    }
  );

  // Create task mutation
  const createTaskMutation = useMutation(
    async (taskData: typeof newTask) => {
      if (!opportunity?.Id) throw new Error('No opportunity selected');
      // Build the payload explicitly instead of spreading `taskData` so that
      //   (a) DriveLink (UI-only stub) doesn't leak into the request, and
      //   (b) empty strings coerce to undefined → TaskCreateRequest's
      //       `model_dump(exclude_none=True)` drops them instead of SF
      //       rejecting '' for date/Id fields (B8 failure mode).
      const response = await apiService.createTask(opportunity.Id, {
        Subject: taskData.Subject,
        Status: taskData.Status || undefined,
        Priority: taskData.Priority || undefined,
        ActivityDate: taskData.ActivityDate || undefined,
        Description: taskData.Description || undefined,
        OwnerId: taskData.OwnerId || undefined,
        WhoId: taskData.WhoId || undefined,
      });
      return response.data;
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['opportunity-tasks', opportunity?.Id]);
        queryClient.invalidateQueries(['my-tasks']);
        toast.success('Task created!');
        setShowAddForm(false);
        setNewTask({ Subject: '', Status: 'Not Started', Priority: 'Normal', ActivityDate: '', Description: '', OwnerId: '', WhoId: '', DriveLink: '' });
      },
      onError: (error: any) => {
        toast.error(`Failed to create task: ${error.message}`);
      },
    }
  );

  // Update task mutation
  const updateTaskMutation = useMutation(
    async ({ taskId, updates }: { taskId: string; updates: any }) => {
      const response = await apiService.updateTask(taskId, updates);
      return response.data;
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['opportunity-tasks', opportunity?.Id]);
        toast.success('Task updated!');
        setEditingTaskId(null);
      },
      onError: (error: any) => {
        toast.error(`Failed to update task: ${error.message}`);
      },
    }
  );

  // Delete task mutation
  const deleteTaskMutation = useMutation(
    async (taskId: string) => {
      const response = await apiService.deleteTask(taskId);
      return response.data;
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['opportunity-tasks', opportunity?.Id]);
        toast.success('Task deleted');
      },
      onError: (error: any) => {
        toast.error(`Failed to delete task: ${error.message}`);
      },
    }
  );

  // Quick toggle task status
  const toggleTaskStatus = (task: Task) => {
    const newStatus = task.Status === 'Completed' ? 'Not Started' : 'Completed';
    updateTaskMutation.mutate({ taskId: task.Id, updates: { Status: newStatus } });
  };

  const startEditing = (task: Task) => {
    setEditingTaskId(task.Id);
    setEditTask({
      Subject: task.Subject || '',
      Status: task.Status || 'Not Started',
      Priority: task.Priority || 'Normal',
      ActivityDate: task.ActivityDate || '',
      Description: task.Description || '',
      OwnerId: task.OwnerId || '',
      WhoId: task.WhoId || '',
      DriveLink: '',
      WhatId: task.WhatId || opportunity?.Id || '',
    });
  };

  const saveEdit = () => {
    if (!editingTaskId) return;
    // Block save if the task record is missing any editable field that the
    // form binds. Prevents silent overwrite of SF data the dialog can't see.
    const originalTask = tasks.find(t => t.Id === editingTaskId) || (orphanTask && orphanTask.Id === editingTaskId ? orphanTask : null);
    if (originalTask) {
      const missing = findMissingFields(TASK_EDITABLE_FIELDS, originalTask as unknown as Record<string, any>);
      if (missing.length > 0) {
        setSaveBlockedMissing(missing);
        return;
      }
    }
    // Diff-based update (B8 fix, PR #169). Previously TaskPanel sent the
    // entire `editTask` object verbatim — including `ActivityDate: ''` /
    // `OwnerId: ''` / `WhoId: ''` for unchanged optional fields — and SF
    // rejected empty-string dates + ids with 400. Compute a diff against
    // the originalTask and only send changed fields. Normalize '' → null
    // so an intentional clear can still propagate (backend treats None
    // specially via exclude_none, so explicit null goes through).
    const updates: Record<string, any> = {};
    const candidates: Record<string, any> = {
      Subject: editTask.Subject,
      Status: editTask.Status,
      Priority: editTask.Priority,
      ActivityDate: editTask.ActivityDate,
      Description: editTask.Description,
      OwnerId: editTask.OwnerId,
      WhatId: editTask.WhatId,
      WhoId: editTask.WhoId,
    };
    for (const [key, rawNew] of Object.entries(candidates)) {
      const rawOld = (originalTask as any)?.[key] ?? null;
      // Treat '' and null as equivalent for comparison — SF returns null
      // for unset fields; form state holds ''.
      const newNorm = rawNew === '' ? null : rawNew;
      const oldNorm = rawOld === '' ? null : rawOld;
      if (newNorm !== oldNorm) {
        updates[key] = newNorm;
      }
    }
    if (Object.keys(updates).length === 0) {
      toast('No changes detected');
      setEditingTaskId(null);
      return;
    }
    updateTaskMutation.mutate({ taskId: editingTaskId, updates });
  };

  const handleCreateTask = () => {
    if (!newTask.Subject.trim()) {
      toast.error('Subject is required');
      return;
    }
    createTaskMutation.mutate(newTask);
  };

  // --- Orphan task state (no opportunity) ---
  const isOrphanMode = !opportunity && !!orphanTask;
  const [linkOppId, setLinkOppId] = useState('');
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkAction, setLinkAction] = useState<'link' | 'duplicate'>('link');

  const linkToOpportunityMutation = useMutation(
    async ({ taskId, whatId }: { taskId: string; whatId: string }) => {
      return apiService.updateTask(taskId, { WhatId: whatId });
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['my-tasks']);
        toast.success('Task linked to opportunity');
        onClose();
      },
      onError: (err: any) => {
        toast.error(`Failed to link task: ${err.message || 'Unknown error'}`);
      },
    }
  );

  const duplicateAndLinkMutation = useMutation(
    async ({ taskId, whatId }: { taskId: string; whatId: string }) => {
      return apiService.duplicateTask(taskId, whatId);
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries(['my-tasks']);
        toast.success('Task duplicated and linked to opportunity');
        onClose();
      },
      onError: (err: any) => {
        toast.error(`Failed to duplicate task: ${err.message || 'Unknown error'}`);
      },
    }
  );

  const handleLinkConfirm = () => {
    if (!orphanTask || !linkOppId) return;
    setShowLinkDialog(false);
    if (linkAction === 'link') {
      linkToOpportunityMutation.mutate({ taskId: orphanTask.Id, whatId: linkOppId });
    } else {
      duplicateAndLinkMutation.mutate({ taskId: orphanTask.Id, whatId: linkOppId });
    }
  };

  // Convert orphan task to Task interface for rendering in edit form
  const orphanAsTask: Task | null = orphanTask ? {
    Id: orphanTask.Id,
    Subject: orphanTask.Subject,
    Status: orphanTask.Status,
    Priority: orphanTask.Priority,
    ActivityDate: orphanTask.ActivityDate,
    Description: orphanTask.Description,
    OwnerId: orphanTask.OwnerId,
    OwnerName: orphanTask.OwnerName || null,
    CreatedDate: '',
    LastModifiedDate: '',
    Type: null,
    TaskSubtype: null,
    WhatId: orphanTask.WhatId || null,
  } : null;

  // Auto-enter edit mode for orphan tasks — inline to avoid stale closure on startEditing
  useEffect(() => {
    if (isOrphanMode && orphanTask && open && editingTaskId !== orphanTask.Id) {
      setEditingTaskId(orphanTask.Id);
      setEditTask({
        Subject: orphanTask.Subject || '',
        Status: orphanTask.Status || 'Not Started',
        Priority: orphanTask.Priority || 'Normal',
        ActivityDate: orphanTask.ActivityDate || '',
        Description: orphanTask.Description || '',
        OwnerId: orphanTask.OwnerId || '',
        WhoId: '', // OrphanTask doesn't carry WhoId through the orphan-mode contract
        DriveLink: '',
        WhatId: orphanTask.WhatId || '',
      });
      setExpandedTaskId(orphanTask.Id);
    }
  }, [isOrphanMode, orphanTask?.Id, open, editingTaskId]);

  if (!opportunity && !isOrphanMode) return null;

  const sortByDueDate = (a: Task, b: Task) => {
    const aDate = a.ActivityDate || '9999-12-31';
    const bDate = b.ActivityDate || '9999-12-31';
    return taskSort === 'asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
  };

  const openTasks = tasks.filter(t => t.Status !== 'Completed').sort(sortByDueDate);
  const completedTasks = tasks.filter(t => t.Status === 'Completed').sort(sortByDueDate);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: { xs: '100%', sm: width },
          p: 0,
        },
      }}
    >
      {/* Resize handle on left edge (sm+ only) */}
      <Box
        onMouseDown={handleResizeStart}
        sx={{
          display: { xs: 'none', sm: 'block' },
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 8,
          cursor: 'col-resize',
          zIndex: 20,
          '&:hover::after': {
            content: '""',
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: 4,
            height: 48,
            borderRadius: 2,
            bgcolor: 'primary.main',
            opacity: 0.4,
          },
        }}
      />
      {/* Header */}
      {isOrphanMode ? (
        /* Orphan task header — grey, with link-to-opportunity option */
        <Box sx={{
          p: 2.5,
          background: 'linear-gradient(135deg, #616161 0%, #424242 100%)',
          color: 'white',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Box sx={{ flex: 1, mr: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3, mb: 0.5 }}>
                Unlinked Task
              </Typography>
              <Typography variant="body2" sx={{ opacity: 0.85 }}>
                {orphanTask?.Subject || 'No Subject'}
              </Typography>
            </Box>
            <IconButton onClick={onClose} size="small" sx={{ color: 'white', mt: -0.5 }}>
              <CloseIcon />
            </IconButton>
          </Box>

          {/* Link to Opportunity section */}
          {opportunities && opportunities.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="caption" sx={{ opacity: 0.85, display: 'block', mb: 1 }}>
                Assign to an Opportunity
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <FormControl size="small" sx={{ flex: 1 }}>
                  <Select
                    value={linkOppId}
                    onChange={(e) => setLinkOppId(e.target.value)}
                    displayEmpty
                    sx={{ bgcolor: 'rgba(255,255,255,0.15)', color: 'white', fontSize: '0.85rem',
                      '& .MuiSelect-icon': { color: 'rgba(255,255,255,0.7)' },
                      '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.3)' },
                    }}
                  >
                    <MenuItem value="" disabled>Select Opportunity...</MenuItem>
                    {opportunities.map(opp => (
                      <MenuItem key={opp.Id} value={opp.Id}>{opp.Name}</MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Tooltip title="Move task to this opportunity">
                  <span>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={!linkOppId}
                      onClick={() => { setLinkAction('link'); setShowLinkDialog(true); }}
                      sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: 'white', minWidth: 'auto', px: 1.5,
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.3)' } }}
                      startIcon={<LinkIcon sx={{ fontSize: 16 }} />}
                    >
                      Link
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title="Create a copy linked to this opportunity (safer)">
                  <span>
                    <Button
                      size="small"
                      variant="contained"
                      disabled={!linkOppId}
                      onClick={() => { setLinkAction('duplicate'); setShowLinkDialog(true); }}
                      sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: 'white', minWidth: 'auto', px: 1.5,
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.3)' } }}
                      startIcon={<DuplicateIcon sx={{ fontSize: 16 }} />}
                    >
                      Duplicate & Link
                    </Button>
                  </span>
                </Tooltip>
              </Box>
            </Box>
          )}
        </Box>
      ) : opportunity ? (
        /* Normal opportunity header */
        <Box sx={{
          p: 2.5,
          background: 'linear-gradient(135deg, #1976d2 0%, #1565c0 100%)',
          color: 'white',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Box sx={{ flex: 1, mr: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3, mb: 0.5 }}>
                {opportunity.Name}
              </Typography>
              <Typography variant="body2" sx={{ opacity: 0.85 }}>
                {opportunity.Account?.Name || 'No Account'}
              </Typography>
            </Box>
            <IconButton onClick={onClose} size="small" sx={{ color: 'white', mt: -0.5 }}>
              <CloseIcon />
            </IconButton>
          </Box>

          <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, flexWrap: 'wrap' }}>
            <Chip
              label={opportunity.StageName}
              size="small"
              sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: 'white', fontWeight: 600, fontSize: '0.75rem' }}
            />
            <Typography variant="body2" sx={{ opacity: 0.9 }}>
              {formatCurrency(opportunity.Amount)}
            </Typography>
            {opportunity.CloseDate && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                Close: {formatDate(opportunity.CloseDate)}
              </Typography>
            )}
            {opportunity.Owner?.Name && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                Owner: {opportunity.Owner.Name}
              </Typography>
            )}
          </Box>

          {/* Task count summary */}
          <Box sx={{ display: 'flex', gap: 2, mt: 1.5 }}>
            <Typography variant="caption" sx={{
              bgcolor: 'rgba(255,255,255,0.15)', px: 1.5, py: 0.3, borderRadius: 1, fontWeight: 600
            }}>
              {openTasks.length} open
            </Typography>
            <Typography variant="caption" sx={{
              bgcolor: 'rgba(255,255,255,0.15)', px: 1.5, py: 0.3, borderRadius: 1, fontWeight: 600
            }}>
              {completedTasks.length} completed
            </Typography>
          </Box>
        </Box>
      ) : null}

      {/* Task Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
        {isOrphanMode && orphanAsTask ? (
          /* Orphan mode: show just the single task in edit form */
          <TaskItem
            key={orphanAsTask.Id}
            task={orphanAsTask}
            isEditing={editingTaskId === orphanAsTask.Id}
            editTask={editTask}
            setEditTask={setEditTask}
            expandedTaskId={expandedTaskId}
            setExpandedTaskId={setExpandedTaskId}
            onToggleStatus={toggleTaskStatus}
            onStartEdit={startEditing}
            onSaveEdit={saveEdit}
            onCancelEdit={() => { setEditingTaskId(null); }}
            onDelete={(id) => { deleteTaskMutation.mutate(id); onClose(); }}
            users={users}
            isSaving={updateTaskMutation.isLoading}
            opportunities={opportunities}
            statusOptions={statusPicklist.options}
            priorityOptions={priorityPicklist.options}
            contactOptions={contactOptions}
            dependencies={depMap.get(orphanAsTask.Id) || []}
            siblingTasks={[]}
            onAddDep={(taskId, depId) => addDepMutation.mutate({ taskId, dependsOnId: depId })}
            onRemoveDep={(depId) => removeDepMutation.mutate(depId)}
            projects={projects}
            onLinkToProject={(sfTaskId, projectId) => linkToProjectMutation.mutate({ sfTaskId, projectId })}
            isOppLocked={isOppLocked}
            canEditLockedOpp={canEditLockedOpp}
            isTaskOwner={orphanAsTask?.OwnerId === sfUserId}
          />
        ) : (
        <>
        {/* Add Task Button / Form */}
        {!showAddForm ? (
          <Button
            startIcon={<AddIcon />}
            onClick={() => setShowAddForm(true)}
            variant="outlined"
            fullWidth
            sx={{
              mb: 2, py: 1.2, borderStyle: 'dashed', borderColor: '#bdbdbd',
              color: '#666', '&:hover': { borderColor: '#1976d2', color: '#1976d2', bgcolor: '#e3f2fd' }
            }}
          >
            Add Task
          </Button>
        ) : (
          <Box sx={{ 
            mb: 2, p: 2, border: '1px solid #e0e0e0', borderRadius: 2, bgcolor: '#fafafa' 
          }}>
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>New Task</Typography>
            
            <TextField
              label="Subject"
              value={newTask.Subject}
              onChange={(e) => setNewTask({ ...newTask, Subject: e.target.value })}
              fullWidth
              size="small"
              sx={{ mb: 1.5 }}
              autoFocus
            />
            
            <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
              {/* Status: schema-driven via useSchemaPicklist('Task', 'Status').
                  Fall back to the four common SF defaults (Not Started /
                  In Progress / Completed / Deferred) when the schema
                  describe is unavailable. id/labelId wire the InputLabel
                  to the Select's aria-labelledby so screen readers + tests
                  can resolve the field's accessible name. */}
              <FormControl size="small" sx={{ flex: 1 }}>
                <InputLabel id="task-create-status-label">Status</InputLabel>
                <Select
                  labelId="task-create-status-label"
                  value={newTask.Status}
                  label="Status"
                  onChange={(e) => setNewTask({ ...newTask, Status: e.target.value })}
                >
                  {statusPicklist.options.length > 0
                    ? statusPicklist.options.map((v) => (
                        <MenuItem key={v} value={v}>{v}</MenuItem>
                      ))
                    : ['Not Started', 'In Progress', 'Completed', 'Deferred'].map((v) => (
                        <MenuItem key={v} value={v}>{v}</MenuItem>
                      ))}
                </Select>
              </FormControl>
              {/* Priority: schema-driven. Fall back to SF defaults. Dropped
                  the emoji prefixes — SF doesn't store them, and they'd
                  break if SF ever adds a new priority value. */}
              <FormControl size="small" sx={{ flex: 1 }}>
                <InputLabel id="task-create-priority-label">Priority</InputLabel>
                <Select
                  labelId="task-create-priority-label"
                  value={newTask.Priority}
                  label="Priority"
                  onChange={(e) => setNewTask({ ...newTask, Priority: e.target.value })}
                >
                  {priorityPicklist.options.length > 0
                    ? priorityPicklist.options.map((v) => (
                        <MenuItem key={v} value={v}>{v}</MenuItem>
                      ))
                    : ['High', 'Normal', 'Low'].map((v) => (
                        <MenuItem key={v} value={v}>{v}</MenuItem>
                      ))}
                </Select>
              </FormControl>
            </Box>

            <TextField
              label="Due Date"
              type="date"
              value={newTask.ActivityDate}
              onChange={(e) => setNewTask({ ...newTask, ActivityDate: e.target.value })}
              fullWidth
              size="small"
              InputLabelProps={{ shrink: true }}
              sx={{ mb: 1.5 }}
            />

            {users && users.length > 0 && (
              <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
                <InputLabel>Assign To</InputLabel>
                <Select
                  value={newTask.OwnerId}
                  label="Assign To"
                  onChange={(e) => setNewTask({ ...newTask, OwnerId: e.target.value })}
                >
                  <MenuItem value="">Unassigned</MenuItem>
                  {users.map(user => (
                    <MenuItem key={user.Id} value={user.Id}>{user.Name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            {/* Contact link (WhoId) — PR #169 / B5 per cheat-sheet RM bullet
                "assign tasks to collaborators". Mirrors the existing Account
                autocomplete pattern elsewhere in the codebase. */}
            <Autocomplete
              options={contactOptions}
              getOptionLabel={(c) => c.Name || ''}
              value={contactOptions.find((c) => c.Id === newTask.WhoId) || null}
              onChange={(_e, newValue) =>
                setNewTask({ ...newTask, WhoId: newValue?.Id || '' })
              }
              isOptionEqualToValue={(option, value) => option.Id === value?.Id}
              renderInput={(params) => (
                <TextField {...params} label="Contact (optional)" size="small" />
              )}
              sx={{ mb: 1.5 }}
            />

            <TextField
              label="Description"
              value={newTask.Description}
              onChange={(e) => setNewTask({ ...newTask, Description: e.target.value })}
              fullWidth
              size="small"
              multiline
              rows={2}
              sx={{ mb: 1.5 }}
            />

            <TextField
              label="Drive Link"
              placeholder="https://drive.google.com/..."
              value={newTask.DriveLink}
              onChange={(e) => setNewTask({ ...newTask, DriveLink: e.target.value })}
              fullWidth
              size="small"
              type="url"
              sx={{ mb: 1.5 }}
            />

            <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
              <Button
                size="small"
                onClick={() => { setShowAddForm(false); setNewTask({ Subject: '', Status: 'Not Started', Priority: 'Normal', ActivityDate: '', Description: '', OwnerId: '', WhoId: '', DriveLink: '' }); }}
                startIcon={<CancelIcon />}
              >
                Cancel
              </Button>
              <ConfirmSaveButton
                onConfirm={handleCreateTask}
                loading={createTaskMutation.isLoading}
                disabled={!newTask.Subject.trim()}
                startIcon={<SaveIcon />}
                confirmTitle="Create in Salesforce?"
                confirmMessage="This will create a new task in Salesforce. Changes are tracked in field history."
              >
                Create
              </ConfirmSaveButton>
            </Box>
          </Box>
        )}

        {/* Loading */}
        {tasksLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={32} />
          </Box>
        )}

        {/* No tasks */}
        {!tasksLoading && tasks.length === 0 && (
          <Alert severity="info" sx={{ mt: 1 }}>
            No tasks yet for this opportunity. Click "Add Task" to get started!
          </Alert>
        )}

        {/* Open Tasks */}
        {openTasks.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="overline" sx={{ color: '#666', fontWeight: 700 }}>
                Open Tasks ({openTasks.length})
              </Typography>
              <Tooltip title={taskSort === 'asc' ? 'Earliest due first' : 'Latest due first'}>
                <IconButton size="small" onClick={() => setTaskSort(s => s === 'asc' ? 'desc' : 'asc')}>
                  <SortIcon sx={{ fontSize: 18 }} />
                </IconButton>
              </Tooltip>
            </Box>
            {openTasks.map((task) => (
              <TaskItem
                key={task.Id}
                task={task}
                isEditing={editingTaskId === task.Id}
                editTask={editTask}
                setEditTask={setEditTask}
                expandedTaskId={expandedTaskId}
                setExpandedTaskId={setExpandedTaskId}
                onToggleStatus={toggleTaskStatus}
                onStartEdit={startEditing}
                onSaveEdit={saveEdit}
                onCancelEdit={() => setEditingTaskId(null)}
                onDelete={(id) => deleteTaskMutation.mutate(id)}
                users={users}
                isSaving={updateTaskMutation.isLoading}
                opportunities={opportunities}
                statusOptions={statusPicklist.options}
                priorityOptions={priorityPicklist.options}
                contactOptions={contactOptions}
                dependencies={depMap.get(task.Id) || []}
                siblingTasks={tasks}
                onAddDep={(taskId, depId) => addDepMutation.mutate({ taskId, dependsOnId: depId })}
                onRemoveDep={(depId) => removeDepMutation.mutate(depId)}
                projects={projects}
                onLinkToProject={(sfTaskId, projectId) => linkToProjectMutation.mutate({ sfTaskId, projectId })}
                isOppLocked={isOppLocked}
                canEditLockedOpp={canEditLockedOpp}
                isTaskOwner={task.OwnerId === sfUserId}
              />
            ))}
          </Box>
        )}

        {/* Completed Tasks */}
        {completedTasks.length > 0 && (
          <Box>
            <Typography variant="overline" sx={{ color: '#666', fontWeight: 700, display: 'block', mb: 1 }}>
              Completed ({completedTasks.length})
            </Typography>
            {completedTasks.map((task) => (
              <TaskItem
                key={task.Id}
                task={task}
                isEditing={editingTaskId === task.Id}
                editTask={editTask}
                setEditTask={setEditTask}
                expandedTaskId={expandedTaskId}
                setExpandedTaskId={setExpandedTaskId}
                onToggleStatus={toggleTaskStatus}
                onStartEdit={startEditing}
                onSaveEdit={saveEdit}
                onCancelEdit={() => setEditingTaskId(null)}
                onDelete={(id) => deleteTaskMutation.mutate(id)}
                users={users}
                isSaving={updateTaskMutation.isLoading}
                opportunities={opportunities}
                statusOptions={statusPicklist.options}
                priorityOptions={priorityPicklist.options}
                contactOptions={contactOptions}
                dependencies={depMap.get(task.Id) || []}
                siblingTasks={tasks}
                onAddDep={(taskId, depId) => addDepMutation.mutate({ taskId, dependsOnId: depId })}
                onRemoveDep={(depId) => removeDepMutation.mutate(depId)}
                projects={projects}
                onLinkToProject={(sfTaskId, projectId) => linkToProjectMutation.mutate({ sfTaskId, projectId })}
                isOppLocked={isOppLocked}
                canEditLockedOpp={canEditLockedOpp}
                isTaskOwner={task.OwnerId === sfUserId}
              />
            ))}
          </Box>
        )}
        </>
        )}
      </Box>

      {/* Link/Duplicate confirmation dialog */}
      <Dialog open={showLinkDialog} onClose={() => setShowLinkDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningIcon color="warning" />
          {linkAction === 'link' ? 'Link Task to Opportunity' : 'Duplicate & Link Task'}
        </DialogTitle>
        <DialogContent>
          {linkAction === 'link' ? (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <strong>This saves to Salesforce.</strong> It will move the task to the selected
              opportunity's task list. Changes are tracked in field history. Consider using{' '}
              <strong>"Duplicate & Link"</strong> instead — it creates a copy linked to the
              opportunity while keeping the original task unchanged.
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              <strong>This saves to Salesforce.</strong> It will create a copy of this task linked
              to the selected opportunity. The original task will remain unlinked. Changes are
              tracked in field history.
            </Alert>
          )}
          <Typography variant="body2" color="text.secondary">
            Opportunity: <strong>{opportunities?.find(o => o.Id === linkOppId)?.Name || 'Unknown'}</strong>
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowLinkDialog(false)}>Cancel</Button>
          {linkAction === 'link' && (
            <Button
              variant="outlined"
              startIcon={<DuplicateIcon />}
              onClick={() => { setLinkAction('duplicate'); }}
            >
              Duplicate Instead
            </Button>
          )}
          <Button
            variant="contained"
            color={linkAction === 'link' ? 'warning' : 'primary'}
            onClick={handleLinkConfirm}
            disabled={linkToOpportunityMutation.isLoading || duplicateAndLinkMutation.isLoading}
            startIcon={(linkToOpportunityMutation.isLoading || duplicateAndLinkMutation.isLoading) ?
              <CircularProgress size={16} /> : (linkAction === 'link' ? <LinkIcon /> : <DuplicateIcon />)}
          >
            {linkAction === 'link' ? 'Link Task' : 'Duplicate & Link'}
          </Button>
        </DialogActions>
      </Dialog>

      <SaveBlockedDialog
        open={saveBlockedMissing.length > 0}
        onClose={() => setSaveBlockedMissing([])}
        missingFields={saveBlockedMissing}
        recordLabel="task"
      />
    </Drawer>
  );
};

// Individual Task Item Component
interface TaskItemProps {
  task: Task;
  isEditing: boolean;
  editTask: any;
  setEditTask: (val: any) => void;
  expandedTaskId: string | null;
  opportunities?: Array<{ Id: string; Name: string }>;
  setExpandedTaskId: (id: string | null) => void;
  onToggleStatus: (task: Task) => void;
  onStartEdit: (task: Task) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  users?: Array<{ Id: string; Name: string }>;
  isSaving: boolean;
  // Schema-driven picklists for Status + Priority (PR #169 / B6). Empty
  // array → TaskItem falls back to the hardcoded defaults.
  statusOptions?: string[];
  priorityOptions?: string[];
  // Contact autocomplete options for WhoId (PR #169 / B5).
  contactOptions?: Array<{ Id: string; Name: string }>;
  // Dependencies
  dependencies?: Array<{ depId: string; dependsOnId: string }>;
  siblingTasks?: Task[];
  allInboxTasks?: Array<{ Id: string; Subject: string }>;
  onAddDep?: (taskId: string, dependsOnId: string) => void;
  onRemoveDep?: (depId: string) => void;
  // Project assignment
  projects?: Array<{ id: string; name: string }>;
  onLinkToProject?: (sfTaskId: string, projectId: string) => void;
  // Lock state
  isOppLocked?: boolean;
  canEditLockedOpp?: boolean;  // lock owner or admin
  isTaskOwner?: boolean;       // task.OwnerId === current user
}

const TaskItem: React.FC<TaskItemProps> = ({
  task, isEditing, editTask, setEditTask, expandedTaskId, setExpandedTaskId,
  onToggleStatus, onStartEdit, onSaveEdit, onCancelEdit, onDelete, users, isSaving, opportunities,
  statusOptions, priorityOptions, contactOptions,
  dependencies, siblingTasks, allInboxTasks, onAddDep, onRemoveDep,
  projects, onLinkToProject,
  isOppLocked, canEditLockedOpp, isTaskOwner,
}) => {
  const isCompleted = task.Status === 'Completed';
  const isExpanded = expandedTaskId === task.Id;
  const overdue = isOverdue(task.ActivityDate, task.Status);

  if (isEditing) {
    return (
      <Box id={`task-item-${task.Id}`} sx={{
        mb: 1, p: 2, border: '1px solid #1976d2', borderRadius: 2, bgcolor: '#f5f9ff'
      }}>
        <TextField
          label="Subject"
          value={editTask.Subject}
          onChange={(e) => setEditTask({ ...editTask, Subject: e.target.value })}
          fullWidth
          size="small"
          sx={{ mb: 1.5 }}
          {...fieldStatusProps('Subject', task as unknown as Record<string, any>)}
        />

        <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
          {(() => {
            const statusLoad = getFieldLoadStatus('Status', task as unknown as Record<string, any>);
            const opts = statusOptions && statusOptions.length > 0
              ? statusOptions
              : ['Not Started', 'In Progress', 'Completed', 'Deferred'];
            const currentValue = editTask.Status;
            const showInactive = currentValue && !opts.includes(currentValue);
            return (
              <FormControl size="small" sx={{ flex: 1 }}>
                <InputLabel id={`task-edit-status-label-${task.Id}`}>Status</InputLabel>
                <Select
                  labelId={`task-edit-status-label-${task.Id}`}
                  value={currentValue}
                  label="Status"
                  onChange={(e) => setEditTask({ ...editTask, Status: e.target.value })}
                >
                  {showInactive && (
                    <MenuItem value={currentValue}>{currentValue} (inactive)</MenuItem>
                  )}
                  {opts.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </Select>
                {statusLoad.helperText && (
                  <FormHelperText sx={statusLoad.isWarning ? { color: 'warning.main' } : undefined}>
                    {statusLoad.helperText}
                  </FormHelperText>
                )}
              </FormControl>
            );
          })()}
          {(() => {
            const priorityLoad = getFieldLoadStatus('Priority', task as unknown as Record<string, any>);
            const opts = priorityOptions && priorityOptions.length > 0
              ? priorityOptions
              : ['High', 'Normal', 'Low'];
            const currentValue = editTask.Priority;
            const showInactive = currentValue && !opts.includes(currentValue);
            return (
              <FormControl size="small" sx={{ flex: 1 }}>
                <InputLabel id={`task-edit-priority-label-${task.Id}`}>Priority</InputLabel>
                <Select
                  labelId={`task-edit-priority-label-${task.Id}`}
                  value={currentValue}
                  label="Priority"
                  onChange={(e) => setEditTask({ ...editTask, Priority: e.target.value })}
                >
                  {showInactive && (
                    <MenuItem value={currentValue}>{currentValue} (inactive)</MenuItem>
                  )}
                  {opts.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </Select>
                {priorityLoad.helperText && (
                  <FormHelperText sx={priorityLoad.isWarning ? { color: 'warning.main' } : undefined}>
                    {priorityLoad.helperText}
                  </FormHelperText>
                )}
              </FormControl>
            );
          })()}
        </Box>

        <TextField
          label="Due Date"
          type="date"
          value={editTask.ActivityDate}
          onChange={(e) => setEditTask({ ...editTask, ActivityDate: e.target.value })}
          fullWidth
          size="small"
          InputLabelProps={{ shrink: true }}
          sx={{ mb: 1.5 }}
          {...fieldStatusProps('ActivityDate', task as unknown as Record<string, any>)}
        />

        {users && users.length > 0 && (() => {
          const ownerLoad = getFieldLoadStatus('OwnerId', task as unknown as Record<string, any>);
          return (
            <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
              <InputLabel>Assign To</InputLabel>
              <Select
                value={editTask.OwnerId}
                label="Assign To"
                onChange={(e) => setEditTask({ ...editTask, OwnerId: e.target.value })}
              >
                <MenuItem value="">Unassigned</MenuItem>
                {users.map(user => (
                  <MenuItem key={user.Id} value={user.Id}>{user.Name}</MenuItem>
                ))}
              </Select>
              {ownerLoad.helperText && (
                <FormHelperText sx={ownerLoad.isWarning ? { color: 'warning.main' } : undefined}>
                  {ownerLoad.helperText}
                </FormHelperText>
              )}
            </FormControl>
          );
        })()}

        {opportunities && opportunities.length > 0 && (() => {
          const whatIdLoad = getFieldLoadStatus('WhatId', task as unknown as Record<string, any>);
          return (
            <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
              <InputLabel>{isOppLocked && !canEditLockedOpp ? 'Opportunity (Locked)' : 'Opportunity'}</InputLabel>
              <Select
                value={editTask.WhatId}
                label={isOppLocked && !canEditLockedOpp ? 'Opportunity (Locked)' : 'Opportunity'}
                onChange={(e) => setEditTask({ ...editTask, WhatId: e.target.value })}
                disabled={isOppLocked && !canEditLockedOpp}
              >
                <MenuItem value="">No Opportunity</MenuItem>
                {opportunities.map(opp => (
                  <MenuItem key={opp.Id} value={opp.Id}>{opp.Name}</MenuItem>
                ))}
              </Select>
              {whatIdLoad.helperText && (
                <FormHelperText sx={whatIdLoad.isWarning ? { color: 'warning.main' } : undefined}>
                  {whatIdLoad.helperText}
                </FormHelperText>
              )}
            </FormControl>
          );
        })()}

        {/* Contact link (WhoId) — PR #169 / B5. Mirrors the create-form
            Autocomplete above; getFieldLoadStatus surfaced via helperText
            on the internal TextField (Autocomplete can't host FormHelperText
            directly, so we piggyback on renderInput). */}
        {(() => {
          const whoIdLoad = getFieldLoadStatus('WhoId', task as unknown as Record<string, any>);
          const opts = contactOptions || [];
          return (
            <Autocomplete
              options={opts}
              getOptionLabel={(c) => c.Name || ''}
              value={opts.find((c) => c.Id === editTask.WhoId) || null}
              onChange={(_e, newValue) =>
                setEditTask({ ...editTask, WhoId: newValue?.Id || '' })
              }
              isOptionEqualToValue={(option, value) => option.Id === value?.Id}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Contact (optional)"
                  size="small"
                  helperText={whoIdLoad.helperText || undefined}
                  FormHelperTextProps={whoIdLoad.isWarning ? { sx: { color: 'warning.main' } } : undefined}
                />
              )}
              sx={{ mb: 1.5 }}
            />
          );
        })()}

        {/* Assign to Project */}
        {projects && projects.length > 0 && onLinkToProject && (
          <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
            <InputLabel>Project</InputLabel>
            <Select
              value=""
              label="Project"
              onChange={(e) => {
                if (e.target.value) onLinkToProject(task.Id, e.target.value as string);
              }}
            >
              <MenuItem value="">No Project</MenuItem>
              {projects.map(p => (
                <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        <TextField
          label="Description"
          value={editTask.Description}
          onChange={(e) => setEditTask({ ...editTask, Description: e.target.value })}
          fullWidth
          size="small"
          multiline
          rows={2}
          sx={{ mb: 1.5 }}
          {...fieldStatusProps('Description', task as unknown as Record<string, any>)}
        />

        <TextField
          label="Drive Link"
          placeholder="https://drive.google.com/..."
          value={editTask.DriveLink}
          onChange={(e) => setEditTask({ ...editTask, DriveLink: e.target.value })}
          fullWidth
          size="small"
          type="url"
          sx={{ mb: 1.5 }}
        />

        {/* Dependencies section */}
        {onAddDep && (
          <Box sx={{ mb: 1.5 }}>
            <Typography variant="caption" sx={{ fontWeight: 600, color: '#555', mb: 0.5, display: 'block' }}>
              Depends On
            </Typography>
            {/* Current dependencies */}
            {dependencies && dependencies.length > 0 && (
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
                {dependencies.map(dep => {
                  const depTask = siblingTasks?.find(t => t.Id === dep.dependsOnId)
                    || allInboxTasks?.find(t => t.Id === dep.dependsOnId);
                  return (
                    <Chip
                      key={dep.depId}
                      label={depTask ? depTask.Subject : dep.dependsOnId.slice(0, 10) + '...'}
                      size="small"
                      onDelete={onRemoveDep ? () => onRemoveDep(dep.depId) : undefined}
                      sx={{ fontSize: '0.75rem' }}
                    />
                  );
                })}
              </Box>
            )}
            {/* Add dependency dropdown — shows sibling tasks */}
            {siblingTasks && siblingTasks.filter(t => t.Id !== task.Id && !dependencies?.some(d => d.dependsOnId === t.Id)).length > 0 && (
              <FormControl size="small" fullWidth>
                <InputLabel>Add dependency...</InputLabel>
                <Select
                  value=""
                  label="Add dependency..."
                  onChange={(e) => {
                    if (e.target.value) onAddDep(task.Id, e.target.value as string);
                  }}
                >
                  {siblingTasks
                    .filter(t => t.Id !== task.Id && !dependencies?.some(d => d.dependsOnId === t.Id))
                    .map(t => (
                      <MenuItem key={t.Id} value={t.Id}>{t.Subject}</MenuItem>
                    ))}
                </Select>
              </FormControl>
            )}
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
          <Button size="small" onClick={onCancelEdit} startIcon={<CancelIcon />}>Cancel</Button>
          <ConfirmSaveButton
            onConfirm={onSaveEdit}
            loading={isSaving}
            startIcon={<SaveIcon />}
          >
            Save
          </ConfirmSaveButton>
        </Box>
      </Box>
    );
  }

  return (
    <Box id={`task-item-${task.Id}`} sx={{
      mb: 0.5,
      border: '1px solid',
      borderColor: overdue ? '#ffcdd2' : '#e0e0e0',
      borderRadius: 1.5,
      bgcolor: overdue ? '#fff8f8' : (isCompleted ? '#fafafa' : 'white'),
      transition: 'all 0.15s ease',
      '&:hover': { 
        borderColor: overdue ? '#ef9a9a' : '#bbdefb',
        boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
      },
    }}>
      {/* Main row */}
      <Box sx={{ 
        display: 'flex', alignItems: 'center', px: 1.5, py: 1,
        cursor: 'pointer',
      }}
        onClick={() => setExpandedTaskId(isExpanded ? null : task.Id)}
      >
        {/* Checkbox */}
        <Tooltip title={isCompleted ? 'Mark as open' : 'Mark as complete'}>
          <IconButton 
            size="small" 
            onClick={(e) => { e.stopPropagation(); onToggleStatus(task); }}
            sx={{ mr: 1, color: isCompleted ? '#4caf50' : '#bdbdbd' }}
          >
            {isCompleted ? <CheckCircleIcon /> : <UncheckedIcon />}
          </IconButton>
        </Tooltip>

        {/* Subject + meta */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography 
            variant="body2" 
            sx={{ 
              fontWeight: 500,
              textDecoration: isCompleted ? 'line-through' : 'none',
              color: isCompleted ? '#999' : '#333',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {task.Subject}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 0.3 }}>
            {task.ActivityDate && (
              <Typography 
                variant="caption" 
                sx={{ 
                  color: overdue ? '#e65100' : '#888',
                  fontWeight: overdue ? 600 : 400,
                  display: 'flex', alignItems: 'center', gap: 0.3,
                }}
              >
                <CalendarIcon sx={{ fontSize: 12 }} />
                {formatDate(task.ActivityDate)}
                {overdue && ' (overdue)'}
              </Typography>
            )}
            {task.OwnerName && (
              <Typography variant="caption" sx={{ color: '#888', display: 'flex', alignItems: 'center', gap: 0.3 }}>
                <PersonIcon sx={{ fontSize: 12 }} />
                {task.OwnerName}
              </Typography>
            )}
          </Box>
        </Box>

        {/* Priority flag */}
        {task.Priority === 'High' && (
          <Tooltip title="High Priority">
            <FlagIcon sx={{ fontSize: 18, color: '#d32f2f', mr: 0.5 }} />
          </Tooltip>
        )}

        {/* Status chip */}
        <Chip
          label={task.Status}
          size="small"
          sx={{
            bgcolor: STATUS_COLORS[task.Status] || '#9e9e9e',
            color: 'white',
            fontWeight: 600,
            fontSize: '0.65rem',
            height: 22,
            mr: 0.5,
          }}
        />

        {/* Expand icon */}
        {isExpanded ? <ExpandLessIcon sx={{ color: '#999', fontSize: 20 }} /> : <ExpandMoreIcon sx={{ color: '#999', fontSize: 20 }} />}
      </Box>

      {/* Expanded content */}
      <Collapse in={isExpanded}>
        <Divider />
        <Box sx={{ px: 2, py: 1.5, bgcolor: '#fafafa' }}>
          {task.Description && (
            <Typography variant="body2" sx={{ color: '#555', mb: 1, whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
              {task.Description}
            </Typography>
          )}
          
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
            <Chip label={`Priority: ${task.Priority}`} size="small" variant="outlined"
              sx={{ borderColor: PRIORITY_COLORS[task.Priority], color: PRIORITY_COLORS[task.Priority] }} />
            {task.Type && <Chip label={task.Type} size="small" variant="outlined" />}
            {task.TaskSubtype && <Chip label={task.TaskSubtype} size="small" variant="outlined" />}
            {task.WhoName && (
              <Chip label={`Contact: ${task.WhoName}`} size="small" variant="outlined"
                sx={{ borderColor: '#7c4dff', color: '#7c4dff' }} />
            )}
            {task.CreatedByName && (
              <Chip label={`Created by: ${task.CreatedByName}`} size="small" variant="outlined" sx={{ color: '#888' }} />
            )}
            <Chip label={`Created: ${formatDate(task.CreatedDate)}`} size="small" variant="outlined" sx={{ color: '#888' }} />
            {task.LastModifiedDate && (
              <Chip label={`Updated: ${formatDate(task.LastModifiedDate)}`} size="small" variant="outlined" sx={{ color: '#888' }} />
            )}
          </Box>

          {/* Dependency badges in view mode */}
          {dependencies && dependencies.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
              <Typography variant="caption" sx={{ color: '#888', mr: 0.5, lineHeight: '24px' }}>
                Depends on:
              </Typography>
              {dependencies.map(dep => {
                const depTask = siblingTasks?.find(t => t.Id === dep.dependsOnId)
                  || allInboxTasks?.find(t => t.Id === dep.dependsOnId);
                return (
                  <Chip
                    key={dep.depId}
                    label={depTask ? depTask.Subject : dep.dependsOnId.slice(0, 10) + '...'}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: '0.7rem', height: 22 }}
                  />
                );
              })}
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end' }}>
            <Button
              size="small"
              startIcon={<EditIcon />}
              onClick={() => onStartEdit(task)}
              sx={{ fontSize: '0.75rem' }}
            >
              Edit
            </Button>
            <ConfirmSaveButton
              onConfirm={() => onDelete(task.Id)}
              size="small"
              color="error"
              variant="text"
              startIcon={<DeleteIcon />}
              confirmTitle="Delete from Salesforce?"
              confirmMessage="This will permanently delete this task from Salesforce."
              confirmLabel="Delete"
              disabled={isOppLocked && !canEditLockedOpp}
              sx={{ fontSize: '0.75rem' }}
            >
              Delete
            </ConfirmSaveButton>
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
};

export default TaskPanel;
