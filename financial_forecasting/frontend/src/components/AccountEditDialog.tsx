import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Drawer,
  TextField,
  MenuItem,
  Grid,
  Typography,
  Divider,
  Alert,
  Autocomplete,
  InputAdornment,
  Box,
  Button,
  FormControlLabel,
  Switch,
  Chip,
  Collapse,
  IconButton,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';

// ── Types ───────────────────────────────────────────────────────────────────

interface AccountEditDialogProps {
  open: boolean;
  onClose: () => void;
  accountId: string | null;
  initialData?: Record<string, any>;
  onSaved?: (accountId: string, updates: Record<string, any>) => void;
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
const SKIP_FIELDS = new Set(['Account', 'Owner', 'RecordType', 'Parent', 'attributes']);

/** Formula/calculated fields — display only, never send in updates. */
const FORMULA_FIELDS = new Set([
  'Last_Activity_Date__c',
  'Date_of_First_Pursuit_Hire__c',
  'X18_Character_Account_ID__c',
  // NPSP rollups are also read-only (managed by NPSP package)
  'npo02__TotalOppAmount__c', 'npo02__NumberOfClosedOpps__c',
  'npo02__AverageAmount__c', 'npo02__LargestAmount__c', 'npo02__SmallestAmount__c',
  'npo02__FirstCloseDate__c', 'npo02__LastCloseDate__c',
  'npo02__OppAmountThisYear__c', 'npo02__OppAmountLastYear__c',
  'npo02__Best_Gift_Year__c', 'npo02__Best_Gift_Year_Total__c',
  'Total_Revenue_Generated__c',
]);

/** Non-updateable system fields. */
const READONLY_FIELDS = new Set([
  'Id', 'CreatedDate', 'LastModifiedDate', 'LastActivityDate',
  'RecordTypeId', 'IsDeleted', 'SystemModstamp',
]);

// Hardcoded fallback picklist values — overwritten by live SF data on load
const FALLBACK_TYPES = [
  'Individual', 'Household', 'Corporate', 'Government',
  'Nonprofit', 'Foundation', 'Academic Institution', 'Donor Advised Fund',
];

const FALLBACK_TIERS = ['General Account', 'Strategic Account', 'Target Strategic Account'];

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

/** Short "MMM d, yyyy" — used in the sticky metadata header. */
function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function formatCurrency(val: number | null | undefined): string {
  if (val == null) return '—';
  return `$${Number(val).toLocaleString()}`;
}

/** Compact currency for header chips: "$1.2M" / "$450K" / "$7.8K". */
function formatCurrencyShort(val: number | null | undefined): string {
  if (val == null) return '';
  const n = Math.abs(val);
  if (n >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(val / 1_000)}K`;
  return `$${Math.round(val)}`;
}

/** Shared drawer header gradient — matches TaskPanel + OpportunityEditDialog
 * so the four drawers read as one visual family. */
const DRAWER_HEADER_GRADIENT = 'linear-gradient(135deg, #1976d2 0%, #1565c0 100%)';

function extractPicklistValues(fields: any[], fieldName: string): string[] {
  const field = fields.find((f: any) => f.name === fieldName);
  if (!field?.picklistValues) return [];
  return field.picklistValues
    .filter((pv: PicklistValue) => pv.active)
    .map((pv: PicklistValue) => pv.value);
}

// ── Component ───────────────────────────────────────────────────────────────

const AccountEditDialog: React.FC<AccountEditDialogProps> = ({
  open,
  onClose,
  accountId,
  initialData,
  onSaved,
}) => {
  const queryClient = useQueryClient();
  const { can, isAdmin } = usePermissions();

  // ── Local state ─────────────────────────────────────────────────────────
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [originalRecord, setOriginalRecord] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [matchingGiftExpanded, setMatchingGiftExpanded] = useState(false);

  const [users, setUsers] = useState<UserOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);

  // Picklist values from SF schema
  const [typeValues, setTypeValues] = useState<string[]>(FALLBACK_TYPES);
  const [industryValues, setIndustryValues] = useState<string[]>([]);
  const [accountSourceValues, setAccountSourceValues] = useState<string[]>([]);
  const [tierValues, setTierValues] = useState<string[]>(FALLBACK_TIERS);
  const [companySizeValues, setCompanySizeValues] = useState<string[]>([]);
  const [fundingFocusValues, setFundingFocusValues] = useState<string[]>([]);
  const [focusAreaValues, setFocusAreaValues] = useState<string[]>([]);

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
  const canEdit = isAdmin || can('edit_accounts');

  // ── Resolve account data on open ────────────────────────────────────────
  useEffect(() => {
    if (!open || !accountId) {
      setOriginalRecord(null);
      setEditForm({});
      setErrors({});
      return;
    }

    let resolved: Record<string, any> | null = null;

    if (initialData && initialData.Id === accountId) {
      resolved = initialData;
    }

    if (!resolved) {
      const cached = queryClient.getQueryData('accounts');
      if (Array.isArray(cached)) {
        resolved = cached.find((a: any) => a.Id === accountId) || null;
      }
    }

    if (resolved) {
      setOriginalRecord({ ...resolved });
      setEditForm({ ...resolved });
    } else {
      setOriginalRecord(null);
      setEditForm({});
    }
  }, [open, accountId, initialData, queryClient]);

  // ── Fetch users, accounts (for parent), and picklists when dialog opens ─
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    // Load users for Owner autocomplete
    setUsersLoading(true);
    apiService.getUsers()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.users || res.data || [];
        setUsers(Array.isArray(data) ? data : []);
      })
      .catch(() => { if (!cancelled) setUsers([]); })
      .finally(() => { if (!cancelled) setUsersLoading(false); });

    // Load accounts for Parent Account autocomplete
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
    apiService.getSchemaDescribe('Account')
      .then((res) => {
        if (cancelled) return;
        const fields = res.data?.fields || [];
        const extract = (name: string) => extractPicklistValues(fields, name);
        const types = extract('Type');
        if (types.length) setTypeValues(types);
        const industries = extract('Industry');
        if (industries.length) setIndustryValues(industries);
        const sources = extract('AccountSource');
        if (sources.length) setAccountSourceValues(sources);
        const tiers = extract('Account_Tier__c');
        if (tiers.length) setTierValues(tiers);
        const sizes = extract('Company_Size__c');
        if (sizes.length) setCompanySizeValues(sizes);
        const focus = extract('npsp__Funding_Focus__c');
        if (focus.length) setFundingFocusValues(focus);
        const areas = extract('Organization_Focus_Area_s__c');
        if (areas.length) setFocusAreaValues(areas);
      })
      .catch(() => { /* Use fallback values */ });

    return () => { cancelled = true; };
  }, [open]);

  // ── Derived values for Autocomplete ─────────────────────────────────────
  const selectedOwner = useMemo(
    () => users.find((u) => u.Id === editForm.OwnerId) || null,
    [users, editForm.OwnerId],
  );

  const selectedParent = useMemo(
    () => accounts.find((a) => a.Id === editForm.ParentId) || null,
    [accounts, editForm.ParentId],
  );

  // ── Field change handler ────────────────────────────────────────────────
  const handleFieldChange = (field: string, value: any) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

  // ── Multipicklist handler (semicolon-separated) ─────────────────────────
  const handleMultipicklistChange = useCallback((field: string, values: string[]) => {
    setEditForm((prev) => ({ ...prev, [field]: values.join(';') }));
  }, []);

  const getMultipicklistValues = useCallback((field: string): string[] => {
    const val = editForm[field];
    if (!val || typeof val !== 'string') return [];
    return val.split(';').filter(Boolean);
  }, [editForm]);

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!accountId || !originalRecord) return;

    // Required field validation
    const newErrors: Record<string, string> = {};
    if (!editForm.Name?.trim()) {
      newErrors.Name = 'Account Name is required';
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    // Diff: only send changed fields (skip relationships, formulas, read-only)
    const updates: Record<string, any> = {};
    for (const key of Object.keys(editForm)) {
      if (SKIP_FIELDS.has(key) || FORMULA_FIELDS.has(key) || READONLY_FIELDS.has(key)) continue;
      const newVal = editForm[key];
      const oldVal = originalRecord[key];
      if (newVal !== oldVal) {
        updates[key] = newVal;
      }
    }

    // Numeric parsing
    if ('AnnualRevenue' in updates) {
      updates.AnnualRevenue = parseFloat(updates.AnnualRevenue) || null;
    }
    if ('NumberOfEmployees' in updates) {
      updates.NumberOfEmployees = parseInt(updates.NumberOfEmployees, 10) || null;
    }

    if (Object.keys(updates).length === 0) {
      toast('No changes detected');
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiService.updateAccount(accountId, updates);
      toast.success('Account saved!');
      queryClient.invalidateQueries('accounts');
      queryClient.invalidateQueries('opportunities-for-accounts');
      if (onSaved) onSaved(accountId, updates);
      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to save account';
      toast.error(detail);
    } finally {
      setSaving(false);
    }
  };

  // ── Not-found state ─────────────────────────────────────────────────────
  const notFound = open && accountId && !originalRecord;

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

      {/* Header — matches TaskPanel / Opp drawer gradient style. */}
      <Box sx={{
        p: 2.5,
        background: DRAWER_HEADER_GRADIENT,
        color: 'white',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box sx={{ flex: 1, mr: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3, mb: 0.5, wordBreak: 'break-word' }}>
              {originalRecord?.Name || 'Edit Account'}
            </Typography>
            {originalRecord && (originalRecord.Industry || originalRecord.Type) && (
              <Typography variant="body2" sx={{ opacity: 0.85 }}>
                {originalRecord.Industry || originalRecord.Type}
              </Typography>
            )}
          </Box>
          <IconButton onClick={onClose} size="small" sx={{ color: 'white', mt: -0.5 }}>
            <CloseIcon />
          </IconButton>
        </Box>

        {originalRecord && (
          <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
            {originalRecord.Account_Tier__c && (
              <Chip
                label={originalRecord.Account_Tier__c}
                size="small"
                sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: 'white', fontWeight: 600, fontSize: '0.75rem' }}
              />
            )}
            {originalRecord.npo02__TotalOppAmount__c != null && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                Total Gifts: {formatCurrencyShort(originalRecord.npo02__TotalOppAmount__c)}
              </Typography>
            )}
            {originalRecord.npo02__LastCloseDate__c && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                Last Gift: {formatDateShort(originalRecord.npo02__LastCloseDate__c)}
              </Typography>
            )}
          </Box>
        )}
      </Box>

      {/* Scrollable content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
        {notFound && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Account not found. It may have been deleted or you may not have access.
          </Alert>
        )}

        {!canEdit && originalRecord && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You don't have permission to edit accounts.
          </Alert>
        )}

        {originalRecord && (
          <>
            {/* ── Section 1: Core Info ──────────────────────────────── */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Account Name"
                  fullWidth
                  size="small"
                  required
                  disabled={!canEdit}
                  value={editForm.Name || ''}
                  onChange={(e) => handleFieldChange('Name', e.target.value)}
                  error={!!errors.Name}
                  helperText={errors.Name}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Account Type"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.Type || ''}
                  onChange={(e) => handleFieldChange('Type', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  {typeValues.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Industry"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.Industry || ''}
                  onChange={(e) => handleFieldChange('Industry', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  {industryValues.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Account Source"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.AccountSource || ''}
                  onChange={(e) => handleFieldChange('AccountSource', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  {accountSourceValues.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Account Tier"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.Account_Tier__c || ''}
                  onChange={(e) => handleFieldChange('Account_Tier__c', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  {tierValues.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Company Size"
                  fullWidth
                  size="small"
                  select
                  disabled={!canEdit}
                  value={editForm.Company_Size__c || ''}
                  onChange={(e) => handleFieldChange('Company_Size__c', e.target.value)}
                >
                  <MenuItem value="">None</MenuItem>
                  {companySizeValues.map((v) => (
                    <MenuItem key={v} value={v}>{v}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
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
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Website"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.Website || ''}
                  onChange={(e) => handleFieldChange('Website', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Active__c}
                      onChange={(e) => handleFieldChange('Active__c', e.target.checked)}
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label="Active"
                />
              </Grid>
              <Grid item xs={12}>
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
              </Grid>
            </Grid>

            {/* ── Section 2: Address ──────────────────────────────── */}
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
                  value={editForm.BillingStreet || ''}
                  onChange={(e) => handleFieldChange('BillingStreet', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField
                  label="City"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.BillingCity || ''}
                  onChange={(e) => handleFieldChange('BillingCity', e.target.value)}
                />
              </Grid>
              <Grid item xs={6} sm={4}>
                <TextField
                  label="State"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.BillingState || ''}
                  onChange={(e) => handleFieldChange('BillingState', e.target.value)}
                />
              </Grid>
              <Grid item xs={6} sm={4}>
                <TextField
                  label="Zip"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.BillingPostalCode || ''}
                  onChange={(e) => handleFieldChange('BillingPostalCode', e.target.value)}
                />
              </Grid>
            </Grid>

            {/* ── Section 3: Fundraising Tags ─────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Fundraising Tags
            </Typography>
            <Grid container spacing={1}>
              {[
                { field: 'npsp__Grantmaker__c', label: 'Grantmaker' },
                { field: 'Philanthropy__c', label: 'Philanthropy' },
                { field: 'Fee_For_Service__c', label: 'Fee For Service' },
                { field: 'Hiring__c', label: 'Hiring' },
                { field: 'Investment__c', label: 'Investment' },
                { field: 'Volunteering__c', label: 'Volunteering' },
                { field: 'Fellow_Recruitment__c', label: 'Fellow Recruitment' },
                { field: 'Media_Marketing__c', label: 'Media / Marketing' },
                { field: 'Influence__c', label: 'Influence' },
                { field: 'Startup__c', label: 'Startup' },
              ].map(({ field, label }) => (
                <Grid item xs={6} sm={4} md={3} key={field}>
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

            {/* ── Section 4: Funding Focus (multipicklist chips) ──── */}
            {(fundingFocusValues.length > 0 || focusAreaValues.length > 0) && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                  Focus Areas
                </Typography>
                <Grid container spacing={2}>
                  {fundingFocusValues.length > 0 && (
                    <Grid item xs={12} sm={6}>
                      <Autocomplete
                        multiple
                        options={fundingFocusValues}
                        value={getMultipicklistValues('npsp__Funding_Focus__c')}
                        onChange={(_e, newValue) =>
                          handleMultipicklistChange('npsp__Funding_Focus__c', newValue)
                        }
                        disabled={!canEdit}
                        renderTags={(value, getTagProps) =>
                          value.map((option, index) => (
                            <Chip
                              variant="outlined"
                              label={option}
                              size="small"
                              {...getTagProps({ index })}
                              key={option}
                            />
                          ))
                        }
                        renderInput={(params) => (
                          <TextField {...params} label="Funding Focus" size="small" />
                        )}
                      />
                    </Grid>
                  )}
                  {focusAreaValues.length > 0 && (
                    <Grid item xs={12} sm={6}>
                      <Autocomplete
                        multiple
                        options={focusAreaValues}
                        value={getMultipicklistValues('Organization_Focus_Area_s__c')}
                        onChange={(_e, newValue) =>
                          handleMultipicklistChange('Organization_Focus_Area_s__c', newValue)
                        }
                        disabled={!canEdit}
                        renderTags={(value, getTagProps) =>
                          value.map((option, index) => (
                            <Chip
                              variant="outlined"
                              label={option}
                              size="small"
                              {...getTagProps({ index })}
                              key={option}
                            />
                          ))
                        }
                        renderInput={(params) => (
                          <TextField {...params} label="Focus Areas" size="small" />
                        )}
                      />
                    </Grid>
                  )}
                </Grid>
              </>
            )}

            {/* ── Section 5: Matching Gift Info (collapsible) ─────── */}
            <Divider sx={{ my: 2 }} />
            <Box
              sx={{ display: 'flex', alignItems: 'center', cursor: 'pointer', mb: 1 }}
              onClick={() => setMatchingGiftExpanded(!matchingGiftExpanded)}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Matching Gift Info
              </Typography>
              <IconButton size="small" sx={{ ml: 0.5 }}>
                <ExpandMoreIcon
                  sx={{
                    transform: matchingGiftExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s',
                  }}
                />
              </IconButton>
            </Box>
            <Collapse in={matchingGiftExpanded}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={!!editForm.npsp__Matching_Gift_Company__c}
                        onChange={(e) =>
                          handleFieldChange('npsp__Matching_Gift_Company__c', e.target.checked)
                        }
                        size="small"
                        disabled={!canEdit}
                      />
                    }
                    label="Matching Gift Company"
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Match Percent"
                    fullWidth
                    size="small"
                    type="number"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Percent__c ?? ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Percent__c', e.target.value)
                    }
                    InputProps={{
                      endAdornment: <InputAdornment position="end">%</InputAdornment>,
                    }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Max Amount"
                    fullWidth
                    size="small"
                    type="number"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Amount_Max__c ?? ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Amount_Max__c', e.target.value)
                    }
                    InputProps={{
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Min Amount"
                    fullWidth
                    size="small"
                    type="number"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Amount_Min__c ?? ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Amount_Min__c', e.target.value)
                    }
                    InputProps={{
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Annual Employee Max"
                    fullWidth
                    size="small"
                    type="number"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Annual_Employee_Max__c ?? ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Annual_Employee_Max__c', e.target.value)
                    }
                    InputProps={{
                      startAdornment: <InputAdornment position="start">$</InputAdornment>,
                    }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Administrator"
                    fullWidth
                    size="small"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Administrator_Name__c || ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Administrator_Name__c', e.target.value)
                    }
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Email"
                    fullWidth
                    size="small"
                    type="email"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Email__c || ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Email__c', e.target.value)
                    }
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Phone"
                    fullWidth
                    size="small"
                    type="tel"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Phone__c || ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Phone__c', e.target.value)
                    }
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="Deadline"
                    fullWidth
                    size="small"
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Request_Deadline__c || ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Request_Deadline__c', e.target.value)
                    }
                  />
                </Grid>
                <Grid item xs={12}>
                  <TextField
                    label="Comments"
                    fullWidth
                    size="small"
                    multiline
                    rows={2}
                    disabled={!canEdit}
                    value={editForm.npsp__Matching_Gift_Comments__c || ''}
                    onChange={(e) =>
                      handleFieldChange('npsp__Matching_Gift_Comments__c', e.target.value)
                    }
                  />
                </Grid>
              </Grid>
            </Collapse>

            {/* ── Section 6: Giving History (read-only) ───────────── */}
            {originalRecord.npo02__TotalOppAmount__c != null && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                  Giving History
                </Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Total Gifts:</strong> {formatCurrency(originalRecord.npo02__TotalOppAmount__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong># of Gifts:</strong> {originalRecord.npo02__NumberOfClosedOpps__c ?? '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Average Gift:</strong> {formatCurrency(originalRecord.npo02__AverageAmount__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Largest Gift:</strong> {formatCurrency(originalRecord.npo02__LargestAmount__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>First Gift:</strong> {formatDate(originalRecord.npo02__FirstCloseDate__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Last Gift:</strong> {formatDate(originalRecord.npo02__LastCloseDate__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>This Year:</strong> {formatCurrency(originalRecord.npo02__OppAmountThisYear__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Last Year:</strong> {formatCurrency(originalRecord.npo02__OppAmountLastYear__c)}
                    </Typography>
                  </Grid>
                </Grid>
              </>
            )}

            {/* ── Section 7: Ownership & Metadata ────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Ownership & Metadata
            </Typography>
            <Grid container spacing={2}>
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
              <Grid item xs={12} sm={6}>
                <Autocomplete
                  options={accounts}
                  loading={accountsLoading}
                  getOptionLabel={(option: AccountOption) => option.Name || ''}
                  value={selectedParent}
                  onChange={(_e, newValue) =>
                    handleFieldChange('ParentId', newValue?.Id || null)
                  }
                  isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                  disabled={!canEdit}
                  renderInput={(params) => (
                    <TextField {...params} label="Parent Account" size="small" />
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
              {originalRecord.Date_of_First_Pursuit_Hire__c && (
                <Typography variant="caption" color="text.secondary">
                  First Pursuit Hire: {formatDate(originalRecord.Date_of_First_Pursuit_Hire__c)}
                </Typography>
              )}
            </Box>
          </>
        )}
      </Box>

      {/* Sticky footer */}
      <Box sx={{ px: 3, py: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose}>Cancel</Button>
        <ConfirmSaveButton
          onConfirm={handleSave}
          loading={saving}
          disabled={!canEdit || !originalRecord}
        >
          Save
        </ConfirmSaveButton>
      </Box>
    </Drawer>
  );
};

export default AccountEditDialog;
