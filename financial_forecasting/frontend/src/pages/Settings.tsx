import React, { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Button,
  Chip,
  Avatar,
  Divider,
  Alert,
  CircularProgress,
  Stack,
  Tabs,
  Tab,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Select,
  MenuItem,
  FormControl,
  Switch,
  IconButton,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Checkbox,
  FormControlLabel,
  Autocomplete,
} from '@mui/material';
import {
  Cloud as CloudIcon,
  CloudOff as CloudOffIcon,
  Link as LinkIcon,
  LinkOff as LinkOffIcon,
  Person as PersonIcon,
  CheckCircle as CheckCircleIcon,
  Error as ErrorIcon,
  Refresh as RefreshIcon,
  CalendarMonth as CalendarIcon,
  Chat as ChatIcon,
  Info as InfoIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  Save as SaveIcon,
  LockOutlined as LockOutlinedIcon,
} from '@mui/icons-material';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../contexts/PermissionsContext';
import { apiService } from '../services/api';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { useOwnerGoals } from '../hooks/useOwnerGoals';
import EditOwnerGoalDialog from '../components/EditOwnerGoalDialog';

// Permission keys grouped by category for the checkbox grid
const PERMISSION_GROUPS = [
  {
    label: 'CRM \u2014 Opportunities',
    keys: [
      { key: 'view_opportunities', label: 'View Opportunities' },
      { key: 'edit_own_opportunities', label: 'Edit Own Opportunities' },
      { key: 'edit_all_opportunities', label: 'Edit All Opportunities' },
      { key: 'create_opportunities', label: 'Create Opportunities' },
      { key: 'bulk_update_opportunities', label: 'Bulk Update Opportunities' },
      { key: 'lock_own_opportunities', label: 'Lock/Unlock Own Opportunities' },
      { key: 'reassign_opportunities', label: 'Reassign Opportunities' },
    ],
  },
  {
    label: 'CRM \u2014 Tasks',
    keys: [
      { key: 'view_tasks', label: 'View Tasks' },
      { key: 'edit_own_tasks', label: 'Edit Own Tasks' },
      { key: 'edit_all_tasks', label: 'Edit All Tasks' },
      { key: 'create_tasks', label: 'Create Tasks' },
    ],
  },
  {
    label: 'Finance',
    keys: [
      { key: 'view_revenue_dashboard', label: 'View Revenue Dashboard' },
      { key: 'view_cashflow_forecasts', label: 'View Cash Flow & Forecasts' },
      { key: 'view_sage_invoices_payments', label: 'View Invoices & Payments (Sage)' },
      { key: 'create_sage_invoices', label: 'Create Invoices in Sage' },
      { key: 'match_invoices', label: 'Match Invoices to Opportunities' },
      { key: 'manage_payment_schedules', label: 'Manage Payment Schedules' },
      { key: 'generate_financial_reports', label: 'Generate Financial Reports' },
    ],
  },
  {
    label: 'Pebble',
    keys: [
      { key: 'use_pebble_chat', label: 'Use Ask Pebble (Chat)' },
      { key: 'use_pebble_research', label: 'Use Pebble Research (Tiered & Batch)' },
      { key: 'pebble_crm_write', label: 'Pebble CRM Write (via Chat)' },
    ],
  },
  {
    label: 'Projects',
    keys: [
      { key: 'view_projects', label: 'View Projects' },
      { key: 'edit_projects', label: 'Create / Edit / Delete Projects' },
    ],
  },
  {
    label: 'System',
    keys: [
      { key: 'trigger_data_sync', label: 'Trigger Data Sync' },
      { key: 'manage_users_roles', label: 'Manage Users & Roles (Admin)' },
      { key: 'edit_permission_profiles', label: 'Edit Permission Profiles' },
      { key: 'manage_owner_goals', label: 'Manage Revenue Targets (Exec)' },
    ],
  },
];

// System-level keys only admins can toggle (matches backend SYSTEM_KEYS)
const SYSTEM_KEYS = new Set([
  'manage_users_roles', 'edit_permission_profiles',
  'trigger_data_sync', 'pebble_crm_write',
]);

interface SFStatus {
  connected: boolean;
  user_id?: string;
  user_name?: string;
  instance_url?: string;
  message?: string;
  needs_reconnect?: boolean;
  refreshed?: boolean;
}

const Settings: React.FC = () => {
  const { user, connectSalesforce, disconnectSalesforce, refetch } = useAuth();
  const [sfStatus, setSfStatus] = useState<SFStatus | null>(null);
  const [sfLoading, setSfLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();

  const fetchSfStatus = async () => {
    setSfLoading(true);
    try {
      const response = await apiService.getSalesforceStatus();
      setSfStatus(response.data);
    } catch (error) {
      setSfStatus({ connected: false, message: 'Failed to check status' });
    } finally {
      setSfLoading(false);
    }
  };

  useEffect(() => {
    fetchSfStatus();

    // Handle redirect params from SF OAuth callback
    const sfConnected = searchParams.get('sf_connected');
    const sfError = searchParams.get('sf_error');

    if (sfConnected === 'true') {
      toast.success('Salesforce connected successfully!');
      refetch(); // Refresh user data to get new SF status
      // Clean up URL params
      setSearchParams({});
    } else if (sfError) {
      toast.error(`Salesforce connection failed: ${sfError}`);
      setSearchParams({});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDisconnect = async () => {
    await disconnectSalesforce();
    await fetchSfStatus();
    toast.success('Salesforce disconnected');
  };

  const handleClearCache = async () => {
    try {
      await apiService.clearCache();
      toast.success('Cache cleared — data will refresh on next load');
    } catch {
      toast.error('Failed to clear cache');
    }
  };

  const { can: canDo } = usePermissions();
  const isAdmin = canDo('manage_users_roles');
  const canEditProfiles = canDo('edit_permission_profiles') || isAdmin;
  const canManageTargets = isAdmin || canDo('manage_owner_goals');
  const queryClient = useQueryClient();
  const [settingsTab, setSettingsTab] = useState(() => {
    const tab = searchParams.get('tab');
    if (
      tab === 'users' || tab === 'profiles' || tab === 'connections' ||
      tab === 'goals' || tab === 'targets'
    ) return tab;
    return 'connections';
  });

  // Admin data queries (only fetch if admin)
  const { data: appUsersData } = useQuery('app-users', async () => {
    const res = await apiService.getAppUsers();
    return res.data?.data || [];
  }, { enabled: isAdmin });
  const { data: profilesData } = useQuery('permission-profiles', async () => {
    const res = await apiService.getPermissionProfiles();
    return res.data?.data || [];
  }, { enabled: canEditProfiles });

  const appUsers: any[] = appUsersData || [];
  const profiles: any[] = profilesData || [];

  // Mutations
  const updateUserMutation = useMutation(
    async ({ userId, data }: { userId: string; data: any }) => apiService.updateAppUser(userId, data),
    { onSuccess: () => { queryClient.invalidateQueries('app-users'); toast.success('User updated'); } }
  );

  const createProfileMutation = useMutation(
    async (data: any) => apiService.createPermissionProfile(data),
    { onSuccess: () => { queryClient.invalidateQueries('permission-profiles'); toast.success('Profile created'); } }
  );
  const updateProfileMutation = useMutation(
    async ({ id, data }: { id: string; data: any }) => apiService.updatePermissionProfile(id, data),
    { onSuccess: () => { queryClient.invalidateQueries('permission-profiles'); toast.success('Profile updated'); } }
  );
  const deleteProfileMutation = useMutation(
    async (id: string) => apiService.deletePermissionProfile(id),
    {
      onSuccess: () => { queryClient.invalidateQueries('permission-profiles'); toast.success('Profile deleted'); },
      onError: (err: any) => { toast.error(err.response?.data?.detail || 'Failed to delete'); },
    }
  );

  // Targets tab state
  const currentFiscalYear = new Date().getFullYear();
  const [targetsFiscalYear, setTargetsFiscalYear] = useState(currentFiscalYear);
  const { goals: ownerGoals, isLoading: goalsLoading, upsertGoal, deleteGoal } = useOwnerGoals(targetsFiscalYear);
  const { data: sfUsersData } = useQuery('sf-users', async () => {
    const res = await apiService.getUsers({ limit: 1000 });
    return res.data?.data || res.data?.users || res.data || [];
  }, { enabled: canManageTargets && settingsTab === 'targets' });
  const sfUsers: any[] = sfUsersData || [];
  const [addingTarget, setAddingTarget] = useState(false);
  const [newTargetOwner, setNewTargetOwner] = useState<any>(null);
  const [newTargetAmount, setNewTargetAmount] = useState('');
  const [newTargetNotes, setNewTargetNotes] = useState('');
  const [newTargetSaving, setNewTargetSaving] = useState(false);
  const [editGoalUser, setEditGoalUser] = useState<{ sfUserId: string; name: string } | null>(null);

  // Profile edit dialog state
  const [editProfile, setEditProfile] = useState<any>(null);
  const [editPerms, setEditPerms] = useState<Record<string, boolean>>({});
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editDefault, setEditDefault] = useState(false);
  const [createMode, setCreateMode] = useState(false);

  // Unlock request queries and mutations
  const { data: pendingRequests } = useQuery(
    ['unlock-requests', editProfile?.id],
    async () => {
      const res = await apiService.getUnlockRequests({ status: 'pending' });
      return res.data?.data || [];
    },
    { enabled: canEditProfiles && !!editProfile }
  );

  const createUnlockMutation = useMutation(
    async (data: { profile_id: string; permission_key: string }) => {
      const res = await apiService.createUnlockRequest(data);
      return res.data;
    },
    {
      onSuccess: () => {
        queryClient.invalidateQueries('unlock-requests');
        toast.success('Unlock request sent to admin');
      },
      onError: (err: any) => {
        toast.error(err.response?.data?.detail || 'Failed to send request');
      },
    }
  );

  const handleRequestUnlock = (key: string) => {
    if (editProfile?.id) {
      createUnlockMutation.mutate({ profile_id: editProfile.id, permission_key: key });
    }
  };

  const openEditProfile = (profile: any) => {
    setEditProfile(profile);
    setEditName(profile.name);
    setEditDesc(profile.description || '');
    setEditDefault(profile.is_default || false);
    setEditPerms(profile.permissions || {});
    setCreateMode(false);
  };
  const openCreateProfile = () => {
    setEditProfile({});
    setEditName('');
    setEditDesc('');
    setEditDefault(false);
    setEditPerms({});
    setCreateMode(true);
  };
  const handleSaveProfile = () => {
    const data = { name: editName, description: editDesc, is_default: editDefault, permissions: editPerms };
    if (createMode) {
      createProfileMutation.mutate(data, { onSuccess: () => setEditProfile(null) });
    } else {
      updateProfileMutation.mutate({ id: editProfile.id, data }, { onSuccess: () => setEditProfile(null) });
    }
  };

  return (
    <Box sx={{ maxWidth: 1000, mx: 'auto' }}>
      {/* "Settings" H5 removed (PR126-5) — duplicated the toolbar title. */}
      <Tabs value={settingsTab} onChange={(_, v) => setSettingsTab(v)} sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}>
        <Tab label="Connections" value="connections" />
        {isAdmin && <Tab label="Users" value="users" />}
        {canEditProfiles && <Tab label="Permission Profiles" value="profiles" />}
        {canManageTargets && <Tab label="Targets" value="targets" />}
      </Tabs>

      {/* ── Connections Tab ── */}
      {settingsTab === 'connections' && (
      <Box>
      {/* User Profile */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }}>
            <Avatar src={user?.picture} sx={{ width: 48, height: 48 }}>
              {user?.name?.charAt(0)}
            </Avatar>
            <Box>
              <Typography variant="h6">{user?.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {user?.email}
              </Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {/* Salesforce Connection */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CloudIcon color="primary" />
            Salesforce Connection
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Connect your Salesforce account so that all changes you make (creating opportunities, 
            updating stages, adding tasks) are attributed to you in Salesforce — not a shared service account.
          </Typography>

          <Divider sx={{ mb: 3 }} />

          {sfLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2 }}>
              <CircularProgress size={24} />
              <Typography>Checking Salesforce connection...</Typography>
            </Box>
          ) : sfStatus?.connected ? (
            <Box>
              <Alert severity="success" sx={{ mb: 2 }} icon={<CheckCircleIcon />}>
                Connected to Salesforce
              </Alert>

              <Stack spacing={1.5} sx={{ mb: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <PersonIcon fontSize="small" color="action" />
                  <Typography variant="body2">
                    <strong>Salesforce User:</strong> {sfStatus.user_name || 'Unknown'}
                  </Typography>
                </Stack>
                {sfStatus.instance_url && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <LinkIcon fontSize="small" color="action" />
                    <Typography variant="body2">
                      <strong>Instance:</strong> {sfStatus.instance_url.replace('https://', '')}
                    </Typography>
                  </Stack>
                )}
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    label="Authenticated"
                    color="success"
                    size="small"
                    variant="outlined"
                  />
                  {sfStatus.refreshed && (
                    <Chip
                      label="Token refreshed"
                      color="info"
                      size="small"
                      variant="outlined"
                    />
                  )}
                </Stack>
              </Stack>

              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                All your actions in Revenue Hub will be tracked under your Salesforce identity.
              </Typography>

              <Stack direction="row" spacing={2}>
                <Button
                  variant="outlined"
                  color="primary"
                  startIcon={<RefreshIcon />}
                  onClick={() => { fetchSfStatus(); }}
                  size="small"
                >
                  Refresh Status
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<LinkOffIcon />}
                  onClick={handleDisconnect}
                  size="small"
                >
                  Disconnect
                </Button>
              </Stack>
            </Box>
          ) : (
            <Box>
              <Alert severity="warning" sx={{ mb: 2 }} icon={<CloudOffIcon />}>
                {sfStatus?.needs_reconnect
                  ? 'Your Salesforce session has expired. Please reconnect.'
                  : 'Salesforce not connected'}
              </Alert>

              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                {user?.salesforce_user_name 
                  ? `We found a matching Salesforce account for your email (${user.salesforce_user_name}). 
                     Connect to authenticate with your own credentials.`
                  : 'Connect your Salesforce account to attribute changes to you.'}
              </Typography>

              <Button
                variant="contained"
                color="primary"
                startIcon={<LinkIcon />}
                onClick={connectSalesforce}
                size="large"
                sx={{ textTransform: 'none' }}
              >
                Connect Salesforce Account
              </Button>

              {!user?.salesforce_user_name && (
                <Alert severity="info" sx={{ mt: 2 }}>
                  Note: Your Google email ({user?.email}) doesn't match any active Salesforce user.
                  Make sure you log in with the same email you use for Salesforce.
                </Alert>
              )}
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Google Calendar Connection */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CalendarIcon color="primary" />
            Google Calendar
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Calendar access is included with your Google login. Only the PBD shared calendar is synced.
          </Typography>
          <Divider sx={{ mb: 3 }} />
          {user?.google_connected ? (
            <Box>
              <Alert severity="success" sx={{ mb: 2 }} icon={<CheckCircleIcon />}>
                Connected via Google login
              </Alert>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <CalendarIcon fontSize="small" color="action" />
                  <Typography variant="body2">
                    <strong>Active Calendar:</strong> PBD Shared Calendar
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label="Read-only" color="info" size="small" variant="outlined" />
                </Stack>
              </Stack>
              <Alert severity="info" sx={{ mt: 2 }} icon={<InfoIcon />}>
                Personal calendars are not synced. Calendar selection coming soon.
              </Alert>
            </Box>
          ) : (
            <Box>
              <Alert severity="warning" sx={{ mb: 2 }} icon={<CloudOffIcon />}>
                Google Calendar not connected. Re-authenticate to enable PBD calendar sync.
              </Alert>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Calendar access is tied to your Google login. Sign in again to refresh tokens.
              </Typography>
              <Button
                variant="contained"
                color="primary"
                startIcon={<LinkIcon />}
                onClick={() => {
                  const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8000';
                  window.location.href = `${apiUrl}/auth/google`;
                }}
                sx={{ textTransform: 'none' }}
              >
                Sign in with Google again
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Slack Connection */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ChatIcon color="primary" />
            Slack Integration
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Slack is configured at the organization level via a bot token. Messages from #pipeline-updates
            are automatically parsed and queued for review.
          </Typography>
          <Divider sx={{ mb: 3 }} />
          {user?.slack_configured ? (
            <Box>
              <Alert severity="success" sx={{ mb: 2 }} icon={<CheckCircleIcon />}>
                Bot connected to workspace
              </Alert>
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <ChatIcon fontSize="small" color="action" />
                  <Typography variant="body2">
                    <strong>Workspace:</strong> {user.slack_workspace || 'Connected'}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label="Bot connected to #pipeline-updates" color="success" size="small" variant="outlined" />
                </Stack>
              </Stack>
            </Box>
          ) : (
            <Alert severity="warning" icon={<CloudOffIcon />}>
              Slack not configured — contact admin to set up the SLACK_BOT_TOKEN.
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Data Management */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Data Management
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The app caches data from Salesforce and Sage Intacct for performance. 
            Clear the cache if you've made changes directly in Salesforce and want to see them immediately.
          </Typography>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={handleClearCache}
          >
            Clear Cache & Refresh Data
          </Button>
        </CardContent>
      </Card>

      {/* Service Status */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Service Connections
          </Typography>
          <Stack spacing={1}>
            <Stack direction="row" spacing={1} alignItems="center">
              {sfStatus?.connected ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <ErrorIcon color="warning" fontSize="small" />
              )}
              <Typography variant="body2">
                Salesforce: {sfStatus?.connected ? 'Connected (your account)' : 'Using service account'}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              {user?.google_connected ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <ErrorIcon color="warning" fontSize="small" />
              )}
              <Typography variant="body2">
                Google Calendar: {user?.google_connected ? 'Connected (PBD calendar)' : 'Not connected'}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              {user?.slack_configured ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <ErrorIcon color="warning" fontSize="small" />
              )}
              <Typography variant="body2">
                Slack: {user?.slack_configured ? `Connected (${user.slack_workspace || 'workspace'})` : 'Not configured'}
              </Typography>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Box>
    )}

    {/* ── Users Tab (Admin only) ── */}
    {settingsTab === 'users' && isAdmin && (
      <Card>
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 2 }}>User Management</Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Email</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>SF User ID</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Profile</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Active</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {appUsers.map((u: any) => (
                <TableRow key={u.id}>
                  <TableCell>{u.name || '\u2014'}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>{u.sf_user_id || '\u2014'}</TableCell>
                  <TableCell>
                    <FormControl size="small" sx={{ minWidth: 140 }}>
                      <Select
                        value={u.profile_id || ''}
                        onChange={(e) => updateUserMutation.mutate({ userId: u.id, data: { profile_id: e.target.value } })}
                        sx={{ fontSize: '0.85rem' }}
                      >
                        {profiles.map((p: any) => (
                          <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={u.is_active}
                      onChange={(e) => updateUserMutation.mutate({ userId: u.id, data: { is_active: e.target.checked } })}
                      size="small"
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )}

    {/* ── Permission Profiles Tab (Admin only) ── */}
    {settingsTab === 'profiles' && canEditProfiles && (
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Permission Profiles</Typography>
            {isAdmin && (
              <Button startIcon={<AddIcon />} variant="outlined" size="small" onClick={openCreateProfile}>
                New Profile
              </Button>
            )}
          </Box>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Description</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Default</TableCell>
                <TableCell sx={{ fontWeight: 600 }}>Users</TableCell>
                <TableCell sx={{ fontWeight: 600 }} align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {profiles.map((p: any) => {
                const userCount = appUsers.filter((u: any) => u.profile_id === p.id).length;
                return (
                  <TableRow key={p.id}>
                    <TableCell sx={{ fontWeight: 600 }}>{p.name}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: '0.85rem' }}>{p.description}</TableCell>
                    <TableCell>{p.is_default && <Chip label="Default" size="small" color="primary" />}</TableCell>
                    <TableCell>{userCount}</TableCell>
                    <TableCell align="right">
                      <IconButton size="small" onClick={() => openEditProfile(p)} title="Edit"><EditIcon fontSize="small" /></IconButton>
                      {isAdmin && (
                        <IconButton
                          size="small" color="error"
                          onClick={() => { if (window.confirm(`Delete "${p.name}"?`)) deleteProfileMutation.mutate(p.id); }}
                          title="Delete" disabled={userCount > 0}
                        ><DeleteIcon fontSize="small" /></IconButton>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    )}

    {/* ── Targets Tab (Admin only) ── */}
    {settingsTab === 'targets' && canManageTargets && (
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Revenue Targets</Typography>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <FormControl size="small" sx={{ minWidth: 120 }}>
                <Select
                  value={targetsFiscalYear}
                  onChange={(e) => setTargetsFiscalYear(Number(e.target.value))}
                >
                  <MenuItem value={currentFiscalYear - 1}>FY{currentFiscalYear - 1}</MenuItem>
                  <MenuItem value={currentFiscalYear}>FY{currentFiscalYear}</MenuItem>
                  <MenuItem value={currentFiscalYear + 1}>FY{currentFiscalYear + 1}</MenuItem>
                </Select>
              </FormControl>
              {!addingTarget && (
                <Button startIcon={<AddIcon />} variant="outlined" size="small" onClick={() => setAddingTarget(true)}>
                  Add Target
                </Button>
              )}
            </Box>
          </Box>

          {goalsLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>Owner</TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">Target Amount</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Period</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Notes</TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {/* Inline add row */}
                {addingTarget && (
                  <TableRow sx={{ bgcolor: 'action.hover' }}>
                    <TableCell>
                      <Autocomplete
                        size="small"
                        options={sfUsers.filter((u: any) => u.IsActive !== false && !ownerGoals[u.Id])}
                        getOptionLabel={(option: any) => option.Name || ''}
                        value={newTargetOwner}
                        onChange={(_e, val) => setNewTargetOwner(val)}
                        renderInput={(params) => <TextField {...params} placeholder="Select owner..." variant="standard" />}
                        sx={{ minWidth: 160 }}
                      />
                    </TableCell>
                    <TableCell align="right">
                      <TextField
                        size="small"
                        variant="standard"
                        placeholder="Amount"
                        value={newTargetAmount}
                        onChange={(e) => setNewTargetAmount(e.target.value)}
                        InputProps={{ startAdornment: <Typography variant="body2" sx={{ mr: 0.5, color: 'text.secondary' }}>$</Typography> }}
                        sx={{ width: 120 }}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setAddingTarget(false); setNewTargetOwner(null); setNewTargetAmount(''); setNewTargetNotes(''); }
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip label={`FY${targetsFiscalYear}`} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.75rem' }} />
                    </TableCell>
                    <TableCell>
                      <TextField
                        size="small"
                        variant="standard"
                        placeholder="Notes (optional)"
                        value={newTargetNotes}
                        onChange={(e) => setNewTargetNotes(e.target.value)}
                        sx={{ width: '100%' }}
                      />
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Button
                        size="small"
                        variant="contained"
                        disabled={newTargetSaving}
                        sx={{ mr: 0.5, minWidth: 0, px: 1.5, textTransform: 'none', fontSize: '0.75rem' }}
                        onClick={async () => {
                          if (!newTargetOwner) { toast.error('Select an owner'); return; }
                          const amount = parseFloat(newTargetAmount.replace(/[,$]/g, ''));
                          if (isNaN(amount) || amount <= 0) { toast.error('Enter a valid amount'); return; }
                          setNewTargetSaving(true);
                          try {
                            await upsertGoal(newTargetOwner.Id, amount, newTargetNotes.trim() || undefined);
                            setAddingTarget(false);
                            setNewTargetOwner(null);
                            setNewTargetAmount('');
                            setNewTargetNotes('');
                          } catch { /* toast handled by hook */ }
                          finally { setNewTargetSaving(false); }
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        size="small"
                        sx={{ minWidth: 0, px: 1, textTransform: 'none', fontSize: '0.75rem' }}
                        onClick={() => { setAddingTarget(false); setNewTargetOwner(null); setNewTargetAmount(''); setNewTargetNotes(''); }}
                      >
                        Cancel
                      </Button>
                    </TableCell>
                  </TableRow>
                )}

                {/* Existing targets */}
                {Object.entries(ownerGoals).length === 0 && !addingTarget && (
                  <TableRow>
                    <TableCell colSpan={5} sx={{ textAlign: 'center', py: 3 }}>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        No revenue targets set for FY{targetsFiscalYear}.
                      </Typography>
                      <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={() => setAddingTarget(true)}>
                        Add Target
                      </Button>
                    </TableCell>
                  </TableRow>
                )}
                {Object.entries(ownerGoals)
                  .sort(([, a], [, b]) => (b.goal_amount || 0) - (a.goal_amount || 0))
                  .map(([sfId, goal]) => {
                    const ownerName = sfUsers.find((u: any) => u.Id === sfId)?.Name || sfId;
                    return (
                      <TableRow key={sfId}>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>{ownerName}</Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            ${goal.goal_amount.toLocaleString()}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Chip label={`FY${goal.fiscal_year}`} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.75rem' }} />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.85rem' }}>
                            {goal.notes || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                          <IconButton
                            size="small"
                            onClick={() => setEditGoalUser({ sfUserId: sfId, name: ownerName })}
                            title="Edit target"
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => { if (window.confirm(`Remove target for ${ownerName}?`)) deleteGoal(sfId); }}
                            title="Remove target"
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    )}

    {/* Edit Target Dialog */}
    {editGoalUser && (
      <EditOwnerGoalDialog
        open
        onClose={() => setEditGoalUser(null)}
        sfUserId={editGoalUser.sfUserId}
        ownerName={editGoalUser.name}
        fiscalYear={targetsFiscalYear}
        currentAmount={ownerGoals[editGoalUser.sfUserId]?.goal_amount ?? 0}
        hasBackendGoal={!!ownerGoals[editGoalUser.sfUserId]}
      />
    )}

    {/* ── Profile Edit Dialog ── */}
    <Dialog open={!!editProfile} onClose={() => setEditProfile(null)} maxWidth="md" fullWidth>
      <DialogTitle>{createMode ? 'Create Permission Profile' : `Edit: ${editName}`}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', gap: 2, mb: 3, mt: 1 }}>
          <TextField label="Profile Name" value={editName} onChange={(e) => setEditName(e.target.value)} size="small" sx={{ flex: 1 }} />
          <TextField label="Description" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} size="small" sx={{ flex: 2 }} />
          <FormControlLabel
            control={<Checkbox checked={editDefault} onChange={(e) => setEditDefault(e.target.checked)} size="small" />}
            label="Default"
          />
        </Box>
        <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              const all: Record<string, boolean> = {};
              PERMISSION_GROUPS.forEach((g) => g.keys.forEach(({ key }) => { all[key] = true; }));
              setEditPerms(all);
            }}
          >
            Select All
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() => {
              const none: Record<string, boolean> = {};
              PERMISSION_GROUPS.forEach((g) => g.keys.forEach(({ key }) => { none[key] = false; }));
              setEditPerms(none);
            }}
          >
            Deselect All
          </Button>
        </Box>
        {PERMISSION_GROUPS.map((group) => (
          <Box key={group.label} sx={{ mb: 2 }}>
            <Typography variant="overline" sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 0.5 }}>
              {group.label}
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 0.5 }}>
              {group.keys.map(({ key, label }) => {
                const isSystemKey = SYSTEM_KEYS.has(key);
                const isLocked = isSystemKey && !isAdmin;
                const hasPendingRequest = isLocked && pendingRequests?.some(
                  (r: any) => r.permission_key === key && r.profile_id === editProfile?.id
                );
                return isLocked ? (
                  <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
                    <Checkbox checked={editPerms[key] || false} disabled size="small" />
                    <Typography variant="body2" color="text.disabled">{label}</Typography>
                    <LockOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                    {hasPendingRequest ? (
                      <Chip label="Requested" size="small" color="info" variant="outlined" />
                    ) : (
                      <Button size="small" variant="text" sx={{ textTransform: 'none', minWidth: 0 }} onClick={() => handleRequestUnlock(key)}>
                        Request Unlock
                      </Button>
                    )}
                  </Box>
                ) : (
                  <FormControlLabel
                    key={key}
                    control={
                      <Checkbox
                        checked={editPerms[key] || false}
                        onChange={(e) => setEditPerms({ ...editPerms, [key]: e.target.checked })}
                        size="small"
                      />
                    }
                    label={
                      <Typography variant="body2" color="text.primary">
                        {label}
                      </Typography>
                    }
                  />
                );
              })}
            </Box>
            <Divider sx={{ mt: 1 }} />
          </Box>
        ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setEditProfile(null)}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handleSaveProfile}
          disabled={!editName.trim() || createProfileMutation.isLoading || updateProfileMutation.isLoading}
          startIcon={<SaveIcon />}
        >
          {createMode ? 'Create' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
    </Box>
  );
};

export default Settings;
