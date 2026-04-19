import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Drawer,
  TextField,
  MenuItem,
  Grid,
  Typography,
  Divider,
  Alert,
  Autocomplete,
  Box,
  Button,
  FormControlLabel,
  Switch,
  Chip,
  IconButton,
  Tooltip,
  Tabs,
  Tab,
} from '@mui/material';
import {
  OpenInNew as OpenInNewIcon,
  History as HistoryIcon,
  Edit as EditIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import ActivityTimeline from './ActivityTimeline';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';

// ── Types ───────────────────────────────────────────────────────────────────

interface ContactEditDialogProps {
  open: boolean;
  onClose: () => void;
  contactId: string | null;
  initialData?: Record<string, any>;
  onSaved?: (contactId: string, updates: Record<string, any>) => void;
  /** When provided, shows "Open" icons next to lookup fields for stacked dialog navigation. */
  onOpenRelated?: (type: 'opportunity' | 'account' | 'contact', id: string) => void;
}

interface UserOption {
  Id: string;
  Name: string;
}

interface AccountOption {
  Id: string;
  Name: string;
}

interface PicklistValue {
  value: string;
  label: string;
  active: boolean;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Nested relationship objects that must never be sent to the update API. */
const SKIP_FIELDS = new Set([
  'Account', 'Owner', 'RecordType', 'npsp__Primary_Affiliation__r', 'attributes',
]);

/** Formula/calculated fields — display only, never send in updates. */
const FORMULA_FIELDS = new Set([
  'Last_Activity_Date__c',
  'Days_Since_Last_Activity__c',
  'Primary_Affiliation_Entity__c',
  'Primary_Affiliation_Name__c',
  'GW_Volunteers__Volunteer_Hours__c',
  'GW_Volunteers__Last_Volunteer_Date__c',
  'Name', // Name is a composite formula (FirstName + LastName) in Salesforce
]);

/** Non-updateable system fields. */
const READONLY_FIELDS = new Set([
  'Id', 'CreatedDate', 'LastModifiedDate', 'LastActivityDate',
  'RecordTypeId', 'IsDeleted', 'SystemModstamp',
]);

// Hardcoded fallback picklist values
const FALLBACK_SALUTATIONS = ['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.'];

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function extractPicklistValues(fields: any[], fieldName: string): string[] {
  const field = fields.find((f: any) => f.name === fieldName);
  if (!field?.picklistValues) return [];
  return field.picklistValues
    .filter((pv: PicklistValue) => pv.active)
    .map((pv: PicklistValue) => pv.value);
}

// ── Component ───────────────────────────────────────────────────────────────

const ContactEditDialog: React.FC<ContactEditDialogProps> = ({
  open,
  onClose,
  contactId,
  initialData,
  onSaved,
  onOpenRelated,
}) => {
  const queryClient = useQueryClient();
  const { can, isAdmin } = usePermissions();

  // ── Local state ─────────────────────────────────────────────────────────
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [originalRecord, setOriginalRecord] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dialogTab, setDialogTab] = useState(0);

  const [users, setUsers] = useState<UserOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);

  // Picklist values from SF schema
  const [salutationValues, setSalutationValues] = useState<string[]>(FALLBACK_SALUTATIONS);
  const [genderValues, setGenderValues] = useState<string[]>([]);
  const [preferredPhoneValues, setPreferredPhoneValues] = useState<string[]>([]);
  const [preferredEmailValues, setPreferredEmailValues] = useState<string[]>([]);
  const [leadSourceValues, setLeadSourceValues] = useState<string[]>([]);

  // ── Drawer resize ───────────────────────────────────────────────────────
  const MIN_WIDTH = 480;
  const MAX_WIDTH = 900;
  const [width, setWidth] = useState(680);
  const resizeRef = useRef({ active: false, startX: 0, startWidth: 0 });

  useEffect(() => {
    const onMouseMove = (e: globalThis.MouseEvent) => {
      if (!resizeRef.current.active) return;
      const dx = e.clientX - resizeRef.current.startX;
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeRef.current.startWidth + dx));
      setWidth(newWidth);
    };
    const onMouseUp = () => { resizeRef.current.active = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeRef.current = { active: true, startX: e.clientX, startWidth: width };
  }, [width]);

  // ── Permission checks ───────────────────────────────────────────────────
  const canEdit = isAdmin || can('edit_contacts');

  // ── Resolve contact data on open ────────────────────────────────────────
  useEffect(() => {
    if (!open || !contactId) {
      setOriginalRecord(null);
      setEditForm({});
      setErrors({});
      setDialogTab(0);
      return;
    }
    setDialogTab(0);

    let resolved: Record<string, any> | null = null;

    if (initialData && initialData.Id === contactId) {
      resolved = initialData;
    }

    if (!resolved) {
      const cached = queryClient.getQueryData('all-contacts');
      if (Array.isArray(cached)) {
        resolved = cached.find((c: any) => c.Id === contactId) || null;
      }
    }

    if (resolved) {
      setOriginalRecord({ ...resolved });
      setEditForm({ ...resolved });
    } else {
      setOriginalRecord(null);
      setEditForm({});
    }
  }, [open, contactId, initialData, queryClient]);

  // ── Fetch users, accounts, and picklists when dialog opens ─────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setUsersLoading(true);
    apiService.getUsers()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.users || res.data || [];
        setUsers(Array.isArray(data) ? data : []);
      })
      .catch(() => { if (!cancelled) setUsers([]); })
      .finally(() => { if (!cancelled) setUsersLoading(false); });

    setAccountsLoading(true);
    apiService.getAccounts()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.accounts || res.data || [];
        setAccounts(Array.isArray(data) ? data : []);
      })
      .catch(() => { if (!cancelled) setAccounts([]); })
      .finally(() => { if (!cancelled) setAccountsLoading(false); });

    // Load picklist values from SF schema
    apiService.getSchemaDescribe('Contact')
      .then((res) => {
        if (cancelled) return;
        const fields = res.data?.fields || [];
        const extract = (name: string) => extractPicklistValues(fields, name);
        const salutations = extract('Salutation');
        if (salutations.length) setSalutationValues(salutations);
        const genders = extract('Gender__c');
        if (genders.length) setGenderValues(genders);
        const prefPhone = extract('npe01__PreferredPhone__c');
        if (prefPhone.length) setPreferredPhoneValues(prefPhone);
        const prefEmail = extract('npe01__Preferred_Email__c');
        if (prefEmail.length) setPreferredEmailValues(prefEmail);
        const leads = extract('LeadSource');
        if (leads.length) setLeadSourceValues(leads);
      })
      .catch(() => { /* Use fallback values */ });

    return () => { cancelled = true; };
  }, [open]);

  // ── Derived values for Autocomplete ─────────────────────────────────────
  const selectedOwner = useMemo(
    () => users.find((u) => u.Id === editForm.OwnerId) || null,
    [users, editForm.OwnerId],
  );

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.Id === editForm.AccountId) || null,
    [accounts, editForm.AccountId],
  );

  const selectedAffiliation = useMemo(
    () => accounts.find((a) => a.Id === editForm.npsp__Primary_Affiliation__c) || null,
    [accounts, editForm.npsp__Primary_Affiliation__c],
  );

  // ── Field change handler ────────────────────────────────────────────────
  const handleFieldChange = (field: string, value: any) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!contactId || !originalRecord) return;

    // Required field validation
    const newErrors: Record<string, string> = {};
    if (!editForm.LastName?.trim()) {
      newErrors.LastName = 'Last Name is required';
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
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

    if (Object.keys(updates).length === 0) {
      toast('No changes detected');
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiService.updateContact(contactId, updates);
      toast.success('Contact saved!');
      queryClient.invalidateQueries('all-contacts');
      // Also invalidate account-specific contact queries
      if (originalRecord.AccountId) {
        queryClient.invalidateQueries(['account-contacts', originalRecord.AccountId]);
      }
      if (onSaved) onSaved(contactId, updates);
      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to save contact';
      toast.error(detail);
    } finally {
      setSaving(false);
    }
  };

  // ── Not-found state ─────────────────────────────────────────────────────
  const notFound = open && contactId && !originalRecord;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: { xs: '100%', sm: width },
          p: 0,
          display: 'flex',
          flexDirection: 'column',
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
      <Box sx={{ px: 3, py: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <Box>
          <Typography variant="h6">Edit Contact</Typography>
          {originalRecord && (
            <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 0.25 }}>
              {originalRecord.FirstName} {originalRecord.LastName}
            </Typography>
          )}
        </Box>
        <IconButton onClick={onClose} size="small" sx={{ mt: 0.5 }}>
          <CloseIcon />
        </IconButton>
      </Box>

      {/* Scrollable content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
        {notFound && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Contact not found. It may have been deleted or you may not have access.
          </Alert>
        )}

        {!canEdit && originalRecord && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You don't have permission to edit contacts.
          </Alert>
        )}

        {originalRecord && (
          <>
            {/* ── Tab navigation ─────────────────────────────────────── */}
            <Tabs
              value={dialogTab}
              onChange={(_, v) => setDialogTab(v)}
              sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
            >
              <Tab label="Details" icon={<EditIcon />} iconPosition="start" sx={{ textTransform: 'none' }} />
              <Tab label="Activities" icon={<HistoryIcon />} iconPosition="start" sx={{ textTransform: 'none' }} />
            </Tabs>

            {/* ── Tab 0: Details (existing form) ─────────────────────── */}
            {dialogTab === 0 && (
            <>
            {/* ── Section 1: Identity ──────────────────────────────── */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={3}>
                <TextField
                  label="Salutation"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.Salutation || ''}
                  onChange={(e) => handleFieldChange('Salutation', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  {salutationValues.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={4.5}>
                <TextField
                  label="First Name"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.FirstName || ''}
                  onChange={(e) => handleFieldChange('FirstName', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4.5}>
                <TextField
                  label="Last Name"
                  fullWidth
                  size="small"
                  required
                  disabled={!canEdit}
                  value={editForm.LastName || ''}
                  onChange={(e) => handleFieldChange('LastName', e.target.value)}
                  error={!!errors.LastName}
                  helperText={errors.LastName}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="Preferred Name"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Preferred_Name__c || ''}
                  onChange={(e) => handleFieldChange('Preferred_Name__c', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="Pronouns"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Pronouns__c || ''}
                  onChange={(e) => handleFieldChange('Pronouns__c', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                {genderValues.length > 0 ? (
                  <TextField
                    label="Gender"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.Gender__c || ''}
                    onChange={(e) => handleFieldChange('Gender__c', e.target.value)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {genderValues.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                  </TextField>
                ) : (
                  <TextField
                    label="Gender"
                    fullWidth
                    size="small"
                    disabled={!canEdit}
                    value={editForm.Gender__c || ''}
                    onChange={(e) => handleFieldChange('Gender__c', e.target.value)}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="Birthdate"
                  fullWidth
                  size="small"
                  type="date"
                  disabled={!canEdit}
                  value={editForm.Birthdate || ''}
                  onChange={(e) => handleFieldChange('Birthdate', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
            </Grid>

            {/* ── Section 2: Organization & Role ───────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Organization & Role
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <Autocomplete
                  options={accounts}
                  loading={accountsLoading}
                  getOptionLabel={(option: AccountOption) => option.Name || ''}
                  value={selectedAffiliation}
                  onChange={(_e, newValue) =>
                    handleFieldChange('npsp__Primary_Affiliation__c', newValue?.Id || null)
                  }
                  isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                  disabled={!canEdit}
                  renderInput={(params) => (
                    <TextField {...params} label="Primary Affiliation" size="small" />
                  )}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Title"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Title || ''}
                  onChange={(e) => handleFieldChange('Title', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Department"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Department || ''}
                  onChange={(e) => handleFieldChange('Department', e.target.value)}
                />
              </Grid>
            </Grid>

            {/* ── Section 3: Contact Info ──────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Contact Info
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Email"
                  fullWidth
                  size="small"
                  type="email"
                  disabled={!canEdit}
                  value={editForm.Email || ''}
                  onChange={(e) => handleFieldChange('Email', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Work Email"
                  fullWidth
                  size="small"
                  type="email"
                  disabled={!canEdit}
                  value={editForm.npe01__WorkEmail__c || ''}
                  onChange={(e) => handleFieldChange('npe01__WorkEmail__c', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Personal Email"
                  fullWidth
                  size="small"
                  type="email"
                  disabled={!canEdit}
                  value={editForm.npe01__HomeEmail__c || ''}
                  onChange={(e) => handleFieldChange('npe01__HomeEmail__c', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                {preferredEmailValues.length > 0 ? (
                  <TextField
                    label="Preferred Email"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.npe01__Preferred_Email__c || ''}
                    onChange={(e) => handleFieldChange('npe01__Preferred_Email__c', e.target.value)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {preferredEmailValues.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                  </TextField>
                ) : (
                  <TextField
                    label="Preferred Email"
                    fullWidth
                    size="small"
                    disabled={!canEdit}
                    value={editForm.npe01__Preferred_Email__c || ''}
                    onChange={(e) => handleFieldChange('npe01__Preferred_Email__c', e.target.value)}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="Phone"
                  fullWidth
                  size="small"
                  type="tel"
                  disabled={!canEdit}
                  value={editForm.Phone || ''}
                  onChange={(e) => handleFieldChange('Phone', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="Mobile"
                  fullWidth
                  size="small"
                  type="tel"
                  disabled={!canEdit}
                  value={editForm.MobilePhone || ''}
                  onChange={(e) => handleFieldChange('MobilePhone', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="Work Phone"
                  fullWidth
                  size="small"
                  type="tel"
                  disabled={!canEdit}
                  value={editForm.npe01__WorkPhone__c || ''}
                  onChange={(e) => handleFieldChange('npe01__WorkPhone__c', e.target.value)}
                />
              </Grid>
              {preferredPhoneValues.length > 0 && (
                <Grid item xs={12} sm={4}>
                  <TextField
                    label="Preferred Phone"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.npe01__PreferredPhone__c || ''}
                    onChange={(e) => handleFieldChange('npe01__PreferredPhone__c', e.target.value)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {preferredPhoneValues.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                  </TextField>
                </Grid>
              )}
            </Grid>

            {/* ── Section 4: Address ──────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Address
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <TextField
                  label="Street"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.MailingStreet || ''}
                  onChange={(e) => handleFieldChange('MailingStreet', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="City"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.MailingCity || ''}
                  onChange={(e) => handleFieldChange('MailingCity', e.target.value)}
                />
              </Grid>
              <Grid item xs={6} sm={4}>
                <TextField
                  label="State"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.MailingState || ''}
                  onChange={(e) => handleFieldChange('MailingState', e.target.value)}
                />
              </Grid>
              <Grid item xs={6} sm={4}>
                <TextField
                  label="Zip"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.MailingPostalCode || ''}
                  onChange={(e) => handleFieldChange('MailingPostalCode', e.target.value)}
                />
              </Grid>
            </Grid>

            {/* ── Section 5: Fundraising ──────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Fundraising
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={6} sm={3}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Philanthropic_Contact__c}
                      onChange={(e) => handleFieldChange('Philanthropic_Contact__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label={<Typography variant="body2">Philanthropic</Typography>}
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Philanthropy__c}
                      onChange={(e) => handleFieldChange('Philanthropy__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label={<Typography variant="body2">Philanthropy</Typography>}
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Volunteer__c}
                      onChange={(e) => handleFieldChange('Volunteer__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label={<Typography variant="body2">Volunteer</Typography>}
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Added_to_Slack__c}
                      onChange={(e) => handleFieldChange('Added_to_Slack__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label={<Typography variant="body2">Added to Slack</Typography>}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Board Status"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Board_Status__c || ''}
                  onChange={(e) => handleFieldChange('Board_Status__c', e.target.value)}
                />
              </Grid>
              {leadSourceValues.length > 0 && (
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Lead Source"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.LeadSource || ''}
                    onChange={(e) => handleFieldChange('LeadSource', e.target.value)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {leadSourceValues.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                  </TextField>
                </Grid>
              )}
              <Grid item xs={12} sm={6}>
                <TextField
                  label="LinkedIn URL"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.LinkedIn_URL__c || ''}
                  onChange={(e) => handleFieldChange('LinkedIn_URL__c', e.target.value)}
                />
              </Grid>
            </Grid>

            {/* ── Section 6: Communication Preferences ────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Communication Preferences
            </Typography>
            <Grid container spacing={1}>
              {[
                { field: 'DoNotCall', label: 'Do Not Call' },
                { field: 'HasOptedOutOfEmail', label: 'Email Opt Out' },
                { field: 'npsp__Do_Not_Contact__c', label: 'Do Not Contact' },
                { field: 'npsp__Deceased__c', label: 'Deceased' },
              ].map(({ field, label }) => (
                <Grid item xs={6} sm={3} key={field}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={!!editForm[field]}
                        onChange={(e) => handleFieldChange(field, e.target.checked)}
                        size="small"
                        disabled={!canEdit}
                      />
                    }
                    label={<Typography variant="body2">{label}</Typography>}
                  />
                </Grid>
              ))}
            </Grid>

            {/* ── Section 7: Ownership & Metadata ────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Ownership
            </Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Autocomplete
                    options={accounts}
                    loading={accountsLoading}
                    getOptionLabel={(option: AccountOption) => option.Name || ''}
                    value={selectedAccount}
                    onChange={(_e, newValue) =>
                      handleFieldChange('AccountId', newValue?.Id || null)
                    }
                    isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                    disabled={!canEdit}
                    sx={{ flex: 1 }}
                    renderInput={(params) => (
                      <TextField {...params} label="Account" size="small" />
                    )}
                  />
                  {onOpenRelated && editForm.AccountId && (
                    <Tooltip title="Open account">
                      <IconButton
                        size="small"
                        onClick={() => onOpenRelated('account', editForm.AccountId)}
                      >
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Grid>
              <Grid item xs={12} sm={6}>
                <Autocomplete
                  options={users}
                  loading={usersLoading}
                  getOptionLabel={(option: UserOption) => option.Name || ''}
                  value={selectedOwner}
                  onChange={(_e, newValue) =>
                    handleFieldChange('OwnerId', newValue?.Id || editForm.OwnerId)
                  }
                  isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                  disabled={!canEdit}
                  renderInput={(params) => (
                    <TextField {...params} label="Owner" size="small" />
                  )}
                />
              </Grid>
            </Grid>

            {/* ── Read-only footer ────────────────────────────────── */}
            <Box sx={{ mt: 2.5, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                Record Type: {originalRecord.RecordType?.Name || '—'}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Created: {formatDate(originalRecord.CreatedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Modified: {formatDate(originalRecord.LastModifiedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Activity: {formatDate(originalRecord.Last_Activity_Date__c || originalRecord.LastActivityDate)}
              </Typography>
              {originalRecord.Days_Since_Last_Activity__c != null && (
                <Chip
                  label={`${originalRecord.Days_Since_Last_Activity__c}d since activity`}
                  size="small"
                  color={originalRecord.Days_Since_Last_Activity__c > 90 ? 'warning' : 'default'}
                  variant="outlined"
                />
              )}
              {originalRecord.GW_Volunteers__Volunteer_Hours__c != null &&
                originalRecord.GW_Volunteers__Volunteer_Hours__c > 0 && (
                <Typography variant="caption" color="text.secondary">
                  Volunteer Hours: {originalRecord.GW_Volunteers__Volunteer_Hours__c}
                </Typography>
              )}
            </Box>

            {/* Description at the bottom */}
            {(editForm.Description || canEdit) && (
              <>
                <Divider sx={{ my: 2 }} />
                <TextField
                  label="Description"
                  fullWidth
                  size="small"
                  multiline
                  rows={3}
                  disabled={!canEdit}
                  value={editForm.Description || ''}
                  onChange={(e) => handleFieldChange('Description', e.target.value)}
                />
              </>
            )}
            </>
            )}

            {/* ── Tab 1: Activities ──────────────────────────────────── */}
            {dialogTab === 1 && contactId && (
              <ActivityTimeline contactId={contactId} maxHeight={500} />
            )}
          </>
        )}
      </Box>

      {/* Sticky footer */}
      <Box sx={{ px: 3, py: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose}>{dialogTab === 0 ? 'Cancel' : 'Close'}</Button>
        {dialogTab === 0 && (
          <ConfirmSaveButton
            onConfirm={handleSave}
            loading={saving}
            disabled={!canEdit || !originalRecord}
          >
            Save
          </ConfirmSaveButton>
        )}
      </Box>
    </Drawer>
  );
};

export default ContactEditDialog;
