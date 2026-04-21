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
  InputAdornment,
  Box,
  Button,
  FormControlLabel,
  Switch,
  IconButton,
  Tooltip,
  Tabs,
  Tab,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  CircularProgress,
} from '@mui/material';
import {
  OpenInNew as OpenInNewIcon,
  History as HistoryIcon,
  Edit as EditIcon,
  Close as CloseIcon,
  ExpandMore as ExpandMoreIcon,
  Add as AddIcon,
} from '@mui/icons-material';
import { useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import ActivityTimeline from './ActivityTimeline';
import PaymentEditDialog from './PaymentEditDialog';
import PaymentCreateDialog from './PaymentCreateDialog';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { COLLECTING_STAGES, CLOSED_STAGES } from '../types/salesforce';
import { useOpportunityRecordTypes } from '../hooks/useOpportunityRecordTypes';
import { useSchemaPicklist } from '../hooks/useSchemaPicklist';

// ── Types ───────────────────────────────────────────────────────────────────

interface OpportunityEditDialogProps {
  open: boolean;
  onClose: () => void;
  opportunityId: string | null;
  initialData?: Record<string, any>;
  onSaved?: (oppId: string, updates: Record<string, any>) => void;
  onStageClosedCompleted?: (opp: { Id: string; Name: string; Amount: number }) => void;
  /** When provided, shows "Open" icons next to lookup fields for stacked dialog navigation. */
  onOpenRelated?: (type: 'opportunity' | 'account' | 'contact', id: string) => void;
}

interface UserOption {
  Id: string;
  Name: string;
  IsActive?: boolean;
}

interface AccountOption {
  Id: string;
  Name: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

/** Stages where the Payment Summary section is shown (Collecting + all Closed). */
const PAYMENT_SUMMARY_STAGES = new Set<string>([
  ...COLLECTING_STAGES,
  ...CLOSED_STAGES,
]);

/** Nested relationship objects that must never be sent to the update API. */
const SKIP_FIELDS = new Set(['Account', 'Owner', 'RecordType', 'attributes']);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the opportunities array from the react-query cache (handles varying shapes). */
function extractOppsArray(cached: unknown): Record<string, any>[] {
  if (Array.isArray(cached)) return cached;
  if (cached && typeof cached === 'object') {
    const obj = cached as Record<string, any>;
    return obj.opportunities || obj.data || [];
  }
  return [];
}

/** Format an ISO date string to a readable locale string. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Short "MMM d, yyyy" — used in the drawer's sticky metadata header where
 * a locale-string ('M/D/YYYY, H:MM:SS AM') is too visually heavy. */
function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

function formatCurrency(val: number | null | undefined): string {
  if (val == null) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

/** Shared drawer header gradient — matches TaskPanel so the four drawers
 * (Opp, Account, Contact, Task) all read as the same visual family. */
const DRAWER_HEADER_GRADIENT = 'linear-gradient(135deg, #1976d2 0%, #1565c0 100%)';

// ── Component ───────────────────────────────────────────────────────────────

const OpportunityEditDialog: React.FC<OpportunityEditDialogProps> = ({
  open,
  onClose,
  opportunityId,
  initialData,
  onSaved,
  onStageClosedCompleted,
  onOpenRelated,
}) => {
  const queryClient = useQueryClient();
  const { can, isAdmin, sfUserId } = usePermissions();

  // Available Opportunity Record Types. Shares the same SF describe() network
  // call as other callers via react-query cache dedupe. See BUG-UI-9: the
  // previous "Type" dropdown was bound to Opportunity.Type, which duplicates
  // the Renewal/Repeat field below — what RMs actually want to classify is the
  // Record Type (Philanthropy / Employer Service / etc).
  const recordTypes = useOpportunityRecordTypes();

  // Schema-driven picklists for StageName and RenewalRepeat__c. Each hook owns
  // its own react-query cache key ((sobject, fieldName)) and fetches schema
  // independently — the underlying endpoint is the same one record-types hits,
  // so the browser coalesces subsequent opens within the 30-min stale window.
  // Empty options → disabled fallback with distinguished helper text
  // (error vs empty) per feedback_sf_stages_sacred.
  const stages = useSchemaPicklist('Opportunity', 'StageName');
  const renewalRepeat = useSchemaPicklist('Opportunity', 'RenewalRepeat__c');

  // Payment Schedule inline accordion. Read-first UX per JP direction:
  // show the list when the user expands, and only enter edit mode when the
  // per-row EditIcon is clicked (PaymentEditDialog stacks on this drawer).
  // Lazy-fetch: `enabled: expanded` so we don't pay the SF round-trip when
  // the user never cares about payments on this opp.
  const [scheduleExpanded, setScheduleExpanded] = useState(false);
  const [detailPayment, setDetailPayment] = useState<Record<string, any> | null>(null);
  const [createPaymentOpen, setCreatePaymentOpen] = useState(false);
  const paymentListQuery = useQuery(
    ['opp-payment-list', opportunityId],
    async () => {
      const res = await apiService.getSfOpportunityPayments(opportunityId!);
      return (Array.isArray(res.data) ? res.data : []) as Record<string, any>[];
    },
    {
      enabled: !!opportunityId && scheduleExpanded,
      staleTime: 30 * 1000, // 30s — payment rollups can change after a save
    },
  );

  // ── Local state ─────────────────────────────────────────────────────────
  const [editForm, setEditForm] = useState<Record<string, any>>({});
  const [originalOpp, setOriginalOpp] = useState<Record<string, any> | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dialogTab, setDialogTab] = useState(0);

  const [users, setUsers] = useState<UserOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);

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
  const isOwner = originalOpp?.OwnerId === sfUserId;
  const canEditOwner =
    isAdmin ||
    (can('edit_all_opportunities') && can('reassign_opportunities')) ||
    (isOwner && can('reassign_opportunities'));
  const canEdit =
    isAdmin ||
    can('edit_all_opportunities') ||
    (isOwner && can('edit_own_opportunities'));

  // ── Resolve opportunity data on open ────────────────────────────────────
  useEffect(() => {
    if (!open || !opportunityId) {
      setOriginalOpp(null);
      setEditForm({});
      setErrors({});
      setDialogTab(0);
      return;
    }
    setDialogTab(0);

    let resolved: Record<string, any> | null = null;

    // 1. Use initialData if provided
    if (initialData && initialData.Id === opportunityId) {
      resolved = initialData;
    }

    // 2. Fallback: look in the react-query cache
    if (!resolved) {
      const cached = queryClient.getQueryData('opportunities');
      const opps = extractOppsArray(cached);
      resolved = opps.find((o) => o.Id === opportunityId) || null;
    }

    if (resolved) {
      setOriginalOpp({ ...resolved });
      setEditForm({ ...resolved });
    } else {
      setOriginalOpp(null);
      setEditForm({});
    }
  }, [open, opportunityId, initialData, queryClient]);

  // ── Fetch users & accounts when dialog opens ───────────────────────────
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    setUsersLoading(true);
    apiService
      .getUsers()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.users || res.data || [];
        setUsers(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      })
      .finally(() => {
        if (!cancelled) setUsersLoading(false);
      });

    setAccountsLoading(true);
    apiService
      .getAccounts()
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data?.accounts || res.data || [];
        setAccounts(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setAccounts([]);
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Derived values for Autocomplete ─────────────────────────────────────
  const selectedOwner = useMemo(
    () => users.find((u) => u.Id === editForm.OwnerId) || null,
    [users, editForm.OwnerId],
  );

  // Prefer the account from the loaded list (which carries richer fields
  // the Autocomplete may surface later). If the opp's linked Account.Id
  // isn't in the list — transient states like pre-load or fetch failure —
  // synthesize a minimal option from the opp's SOQL-joined Account.Name
  // so the field displays correctly instead of appearing empty. The id
  // stays stable, so saving without touching the field does not reassign.
  const selectedAccount = useMemo(() => {
    if (!editForm.AccountId) return null;
    const fromList = accounts.find((a) => a.Id === editForm.AccountId);
    if (fromList) return fromList;
    const joinedName = originalOpp?.Account?.Name;
    if (joinedName) {
      return { Id: editForm.AccountId, Name: joinedName } as AccountOption;
    }
    return null;
  }, [accounts, editForm.AccountId, originalOpp]);

  // ── Field change handler ────────────────────────────────────────────────
  const handleFieldChange = (field: string, value: any) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors((prev) => { const next = { ...prev }; delete next[field]; return next; });
    }
  };

  // ── Save handler ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!opportunityId || !originalOpp) return;

    // Validate SF-required fields before saving
    const newErrors: Record<string, string> = {};
    if (!editForm.Name?.toString().trim()) {
      newErrors.Name = 'Opportunity name is required';
    }
    if (!editForm.CloseDate) {
      newErrors.CloseDate = 'Close date is required';
    }
    if (!editForm.StageName) {
      newErrors.StageName = 'Stage is required';
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    // Diff: only send changed fields (skip nested relationship objects)
    const updates: Record<string, any> = {};
    for (const key of Object.keys(editForm)) {
      if (SKIP_FIELDS.has(key)) continue;
      const newVal = editForm[key];
      const oldVal = originalOpp[key];
      if (newVal !== oldVal) {
        updates[key] = newVal;
      }
    }

    // Special numeric parsing
    if ('Amount' in updates) {
      updates.Amount = parseFloat(updates.Amount) || 0;
    }
    if ('Probability' in updates) {
      updates.Probability = parseInt(updates.Probability, 10) || 0;
    }

    if (Object.keys(updates).length === 0) {
      toast('No changes detected');
      onClose();
      return;
    }

    setSaving(true);
    try {
      await apiService.updateOpportunity(opportunityId, updates);
      toast.success('Saved!');
      queryClient.invalidateQueries('opportunities');

      if (onSaved) {
        onSaved(opportunityId, updates);
      }

      // Check if stage transitioned to "Closed / Completed"
      const newStage = editForm.StageName;
      const oldStage = originalOpp.StageName;
      if (
        newStage !== oldStage &&
        newStage === 'Closed / Completed' &&
        onStageClosedCompleted
      ) {
        onStageClosedCompleted({
          Id: opportunityId,
          Name: editForm.Name || originalOpp.Name,
          Amount: parseFloat(editForm.Amount) || originalOpp.Amount || 0,
        });
      }

      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to save opportunity';
      toast.error(detail);
    } finally {
      setSaving(false);
    }
  };

  // ── Not-found state ─────────────────────────────────────────────────────
  const notFound = open && opportunityId && !originalOpp;

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

      {/* Header — matches TaskPanel's gradient + metadata-chip style so the
          four drawers (Opp / Account / Contact / Task) read as one family. */}
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
              {originalOpp?.Name || 'Edit Opportunity'}
            </Typography>
            <Typography variant="body2" sx={{ opacity: 0.85, wordBreak: 'break-word' }}>
              {originalOpp?.Account?.Name || 'No Account'}
            </Typography>
          </Box>
          <IconButton onClick={onClose} size="small" sx={{ color: 'white', mt: -0.5 }}>
            <CloseIcon />
          </IconButton>
        </Box>

        {originalOpp && (
          <Box sx={{ display: 'flex', gap: 1.5, mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
            {originalOpp.StageName && (
              <Chip
                label={originalOpp.StageName}
                size="small"
                sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: 'white', fontWeight: 600, fontSize: '0.75rem' }}
              />
            )}
            {originalOpp.Amount != null && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                {formatCurrency(originalOpp.Amount)}
              </Typography>
            )}
            {originalOpp.CloseDate && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                Close: {formatDateShort(originalOpp.CloseDate)}
              </Typography>
            )}
            {originalOpp.Owner?.Name && (
              <Typography variant="body2" sx={{ opacity: 0.9 }}>
                Owner: {originalOpp.Owner.Name}
              </Typography>
            )}
          </Box>
        )}
      </Box>

      {/* Scrollable content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 3, py: 2 }}>
        {notFound && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Opportunity not found. It may have been deleted or you may not have access.
          </Alert>
        )}

        {!canEdit && originalOpp && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You can only edit opportunities you own.
          </Alert>
        )}

        {originalOpp && (
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
            {/* ── Section 1: Core Fields ──────────────────────────────── */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Name"
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
                {/* Stage — schema-driven (replaces hardcoded OPPORTUNITY_STAGES
                    which silently drifted from SF). Disabled fallback shows
                    the stored value so a picklist deactivation never hides
                    data, per feedback_sf_stages_sacred. */}
                {stages.options.length > 0 ? (
                  <TextField
                    label="Stage"
                    fullWidth
                    size="small"
                    select
                    required
                    disabled={!canEdit}
                    value={editForm.StageName || ''}
                    onChange={(e) => handleFieldChange('StageName', e.target.value)}
                    error={!!errors.StageName}
                    helperText={errors.StageName}
                  >
                    {stages.options.map((stage) => (
                      <MenuItem key={stage} value={stage}>
                        {stage}
                      </MenuItem>
                    ))}
                    {/* Preserve a stored stage SF deactivated since the record
                        was saved (picklist drift). */}
                    {editForm.StageName
                      && !stages.options.some((s) => s === editForm.StageName) && (
                      <MenuItem value={editForm.StageName} disabled>
                        {editForm.StageName} (inactive)
                      </MenuItem>
                    )}
                  </TextField>
                ) : (
                  <TextField
                    label="Stage"
                    fullWidth
                    size="small"
                    required
                    disabled
                    value={editForm.StageName || ''}
                    error={!!errors.StageName}
                    helperText={errors.StageName
                      || (stages.error
                        ? 'Stage list unavailable'
                        : 'No active stages available')}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Amount"
                  fullWidth
                  size="small"
                  type="number"
                  disabled={!canEdit}
                  value={editForm.Amount ?? ''}
                  onChange={(e) => handleFieldChange('Amount', e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start">$</InputAdornment>,
                  }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Probability (%)"
                  fullWidth
                  size="small"
                  type="number"
                  disabled={!canEdit}
                  value={editForm.Probability ?? ''}
                  onChange={(e) => handleFieldChange('Probability', e.target.value)}
                  inputProps={{ min: 0, max: 100 }}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Close Date"
                  fullWidth
                  size="small"
                  type="date"
                  required
                  disabled={!canEdit}
                  value={editForm.CloseDate || ''}
                  onChange={(e) => handleFieldChange('CloseDate', e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  error={!!errors.CloseDate}
                  helperText={errors.CloseDate}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                {/* Record Type — lets RMs reclassify an opportunity (e.g.
                    Philanthropy → Employer Service). Falls back to a
                    read-only display if the describe endpoint is unavailable
                    or the user's profile has no assignable record types, so
                    we never silently drop the classification. */}
                {recordTypes.options.length > 0 ? (
                  <TextField
                    label="Record Type"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.RecordTypeId || ''}
                    onChange={(e) => handleFieldChange('RecordTypeId', e.target.value)}
                  >
                    {recordTypes.options.map((rt) => (
                      <MenuItem key={rt.id} value={rt.id}>{rt.name}</MenuItem>
                    ))}
                    {/* If the record's current RecordType isn't in the user's
                        assignable list (common for legacy data or cross-team
                        opps), still show it so the selection stays stable. */}
                    {editForm.RecordTypeId
                      && !recordTypes.options.some((rt) => rt.id === editForm.RecordTypeId) && (
                      <MenuItem value={editForm.RecordTypeId} disabled>
                        {originalOpp.RecordType?.Name || 'Current'} (not assignable)
                      </MenuItem>
                    )}
                  </TextField>
                ) : (
                  <TextField
                    label="Record Type"
                    fullWidth
                    size="small"
                    disabled
                    value={originalOpp.RecordType?.Name || ''}
                    helperText={recordTypes.error ? 'Record Type list unavailable' : undefined}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={6}>
                {/* Renewal / Repeat — schema-driven (was hardcoded
                    None/New/Renewal/Upsell). Nullable field, so the
                    editable branch always prepends an explicit "None" option
                    users can re-select to clear. */}
                {renewalRepeat.options.length > 0 ? (
                  <TextField
                    label="Renewal / Repeat"
                    fullWidth
                    size="small"
                    select
                    disabled={!canEdit}
                    value={editForm.RenewalRepeat__c || ''}
                    onChange={(e) => handleFieldChange('RenewalRepeat__c', e.target.value)}
                  >
                    <MenuItem value="">None</MenuItem>
                    {renewalRepeat.options.map((v) => (
                      <MenuItem key={v} value={v}>{v}</MenuItem>
                    ))}
                    {editForm.RenewalRepeat__c
                      && !renewalRepeat.options.some((v) => v === editForm.RenewalRepeat__c) && (
                      <MenuItem value={editForm.RenewalRepeat__c} disabled>
                        {editForm.RenewalRepeat__c} (inactive)
                      </MenuItem>
                    )}
                  </TextField>
                ) : (
                  <TextField
                    label="Renewal / Repeat"
                    fullWidth
                    size="small"
                    disabled
                    value={editForm.RenewalRepeat__c || ''}
                    helperText={renewalRepeat.error
                      ? 'Renewal / Repeat list unavailable'
                      : 'No active Renewal / Repeat values available'}
                  />
                )}
              </Grid>
              <Grid item xs={12} sm={6}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={!!editForm.Active_Opportunity__c}
                      onChange={(e) =>
                        handleFieldChange('Active_Opportunity__c', e.target.checked)
                      }
                      size="small"
                      disabled={!canEdit}
                    />
                  }
                  label="Active Opportunity"
                />
              </Grid>
            </Grid>

            {/* ── Section 2: Details ──────────────────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Details
            </Typography>

            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Lead Source"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.LeadSource || ''}
                  onChange={(e) => handleFieldChange('LeadSource', e.target.value)}
                />
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  label="Next Step"
                  fullWidth
                  size="small"
                  disabled={!canEdit}
                  value={editForm.NextStep || ''}
                  onChange={(e) => handleFieldChange('NextStep', e.target.value)}
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
              <Grid item xs={12}>
                <Box sx={{ display: 'flex', gap: 3 }}>
                  <Typography variant="body2" color="text.secondary">
                    <strong>Forecast Category:</strong>{' '}
                    {editForm.ForecastCategory || '—'}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    <strong>Expected Revenue:</strong>{' '}
                    {editForm.ExpectedRevenue != null
                      ? `$${Number(editForm.ExpectedRevenue).toLocaleString()}`
                      : '—'}
                  </Typography>
                </Box>
              </Grid>
            </Grid>

            {/* ── Section 3: Payment Summary (Collecting+ stages only) ── */}
            {PAYMENT_SUMMARY_STAGES.has(originalOpp.StageName) && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                  Payment Summary
                </Typography>
                <Grid container spacing={1.5}>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Payments Received:</strong>{' '}
                      {editForm.npe01__Payments_Made__c != null
                        ? `$${Number(editForm.npe01__Payments_Made__c).toLocaleString()}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Outstanding:</strong>{' '}
                      {editForm.Outstanding_Payments__c != null
                        ? `$${Number(editForm.Outstanding_Payments__c).toLocaleString()}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Payment Count:</strong>{' '}
                      {editForm.Number_of_Payments_Received__c != null ||
                      editForm.npe01__Number_of_Payments__c != null
                        ? `${editForm.Number_of_Payments_Received__c ?? 0} / ${editForm.npe01__Number_of_Payments__c ?? 0}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Last Payment:</strong>{' '}
                      {editForm.Last_Actual_Payment__c != null
                        ? `$${Number(editForm.Last_Actual_Payment__c).toLocaleString()}`
                        : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>Most Recent Payment:</strong>{' '}
                      {formatDate(editForm.Most_Recent_Payment_Date__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="body2" color="text.secondary">
                      <strong>First Payment:</strong>{' '}
                      {formatDate(editForm.PaymentDate__c)}
                    </Typography>
                  </Grid>
                  <Grid item xs={6}>
                    {/* Next Scheduled — editable date picker (was read-only
                        display). Mirrors the Close Date / Contract Start /
                        Contract End pattern: TextField type="date" with
                        InputLabelProps={{shrink:true}}. Stays inside the
                        stage-gated Payment Summary block per JP direction. */}
                    <TextField
                      label="Next Scheduled Payment"
                      fullWidth
                      size="small"
                      type="date"
                      disabled={!canEdit}
                      value={editForm.Earliest_Scheduled_Payment__c || ''}
                      onChange={(e) =>
                        handleFieldChange('Earliest_Scheduled_Payment__c', e.target.value)
                      }
                      InputLabelProps={{ shrink: true }}
                    />
                  </Grid>
                </Grid>
              </>
            )}

            {/* ── Section 3b: Payment Schedule (always visible) ────────
                Pulled out of the Payment Summary stage-gate per JP 2026-04-21
                post-smoke feedback: early-stage Opps (e.g. Qualifying, New
                Lead) need a place to schedule payments before the Opp reaches
                Collecting. The Payment Summary rollups above stay gated
                because they're meaningful only once money is moving. */}
            <Divider sx={{ my: 2 }} />
            <Accordion
              elevation={0}
              disableGutters
              expanded={scheduleExpanded}
              onChange={(_, isExpanded) => setScheduleExpanded(isExpanded)}
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                '&:before': { display: 'none' },
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon fontSize="small" />}
                sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0.5, alignItems: 'center' } }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1, pr: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, flexGrow: 1 }}>
                    Payment Schedule
                    {paymentListQuery.data != null && (
                      <Chip
                        label={paymentListQuery.data.length}
                        size="small"
                        sx={{ ml: 1, height: 18, fontSize: 11 }}
                      />
                    )}
                  </Typography>
                  {canEdit && (
                    <Tooltip title="Add payment">
                      <IconButton
                        size="small"
                        aria-label="Add payment"
                        onClick={(e) => {
                          // Don't toggle the accordion when clicking the button
                          // that sits inside the AccordionSummary.
                          e.stopPropagation();
                          setCreatePaymentOpen(true);
                        }}
                      >
                        <AddIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 0 }}>
                {paymentListQuery.isLoading && (
                  <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
                    <CircularProgress size={20} />
                  </Box>
                )}
                {paymentListQuery.error != null && (
                  <Alert severity="error" sx={{ m: 1 }}>
                    Could not load payments for this opportunity.
                  </Alert>
                )}
                {paymentListQuery.data != null
                  && paymentListQuery.data.length === 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                    No payments on file for this opportunity yet.
                    {canEdit && ' Use the + button above to add one.'}
                  </Typography>
                )}
                {paymentListQuery.data != null
                  && paymentListQuery.data.length > 0 && (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 600 }}>Amount</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>Scheduled</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>Payment Date</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>Status</TableCell>
                        <TableCell width={40} />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {paymentListQuery.data.map((p) => (
                        <TableRow key={p.Id} hover>
                          <TableCell>
                            {p.npe01__Payment_Amount__c != null
                              ? `$${Number(p.npe01__Payment_Amount__c).toLocaleString()}`
                              : '—'}
                          </TableCell>
                          <TableCell>{formatDate(p.npe01__Scheduled_Date__c)}</TableCell>
                          <TableCell>{formatDate(p.npe01__Payment_Date__c)}</TableCell>
                          <TableCell>
                            {p.npe01__Paid__c ? (
                              <Chip label="Paid" size="small" color="success" variant="outlined" />
                            ) : p.Payment_Status__c ? (
                              <Chip label={p.Payment_Status__c} size="small" variant="outlined" />
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell>
                            <Tooltip title="Edit payment details">
                              <IconButton
                                size="small"
                                onClick={() => setDetailPayment(p)}
                                aria-label={`Edit payment ${p.Name || p.Id}`}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </AccordionDetails>
            </Accordion>

            {/* ── Section 4: Ownership & Contract ─────────────────────── */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Ownership & Contract
            </Typography>

            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <Autocomplete
                  options={[...users].sort((a, b) => {
                    const aActive = a.IsActive !== false ? 0 : 1;
                    const bActive = b.IsActive !== false ? 0 : 1;
                    return aActive !== bActive ? aActive - bActive : (a.Name || '').localeCompare(b.Name || '');
                  })}
                  groupBy={(option: UserOption) => option.IsActive === false ? 'Inactive' : 'Active'}
                  loading={usersLoading}
                  getOptionLabel={(option: UserOption) => option.Name || ''}
                  value={selectedOwner}
                  onChange={(_e, newValue) =>
                    handleFieldChange('OwnerId', newValue?.Id || editForm.OwnerId)
                  }
                  isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                  disabled={!canEditOwner}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Owner"
                      size="small"
                      helperText={
                        !canEditOwner
                          ? 'Reassigning requires the Reassign Opportunities permission'
                          : undefined
                      }
                    />
                  )}
                />
              </Grid>
              {canEditOwner && selectedOwner && originalOpp?.OwnerId !== selectedOwner?.Id
                && selectedOwner?.Id !== sfUserId && !can('edit_all_opportunities') && (
                <Grid item xs={12}>
                  <Alert severity="warning" variant="outlined">
                    <strong>Heads up:</strong> Reassigning to {selectedOwner.Name} means you won't be
                    able to edit this opportunity afterward.
                  </Alert>
                </Grid>
              )}
              <Grid item xs={12} sm={6}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Autocomplete
                    // When the current account isn't in the loaded list
                    // (2000-row cap), inject the synthesized selected
                    // option into `options` too so MUI doesn't warn
                    // "value is not in options" and the item renders in
                    // the listbox if the user opens the dropdown.
                    options={
                      selectedAccount
                      && !accounts.some((a) => a.Id === selectedAccount.Id)
                        ? [selectedAccount, ...accounts]
                        : accounts
                    }
                    loading={accountsLoading}
                    getOptionLabel={(option: AccountOption) => option.Name || ''}
                    value={selectedAccount}
                    onChange={(_e, newValue) =>
                      handleFieldChange('AccountId', newValue?.Id || editForm.AccountId)
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
              {/* Contract_Start_Date__c / Contract_End_Date__c /
                  Payment_Terms__c / Billing_Frequency__c removed
                  2026-04-21 (PR #167 hotfix cause-analysis + #168
                  cleanup). These were declared on the TypeScript
                  interface and bound here, but the underlying custom
                  fields don't exist on the Opportunity object in
                  Pursuit's live SF org (confirmed by Jac when adding
                  them to the SOQL broke get_opportunities in prod).
                  Re-add when/if the fields are actually created in SF.
                  The forecasting engine still references Payment_Terms__c
                  — left untouched here; separate investigation tracks
                  whether that code path is live or dead. */}
            </Grid>

            {/* ── Read-only footer ────────────────────────────────────── */}
            {/* Record Type is intentionally omitted here — it's now editable
                in the main form (BUG-UI-9). */}
            <Box sx={{ mt: 2.5, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary">
                Created: {formatDate(originalOpp.CreatedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Modified: {formatDate(originalOpp.LastModifiedDate)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last Activity: {formatDate(originalOpp.LastActivityDate)}
              </Typography>
            </Box>
            </>
            )}

            {/* ── Tab 1: Activities ──────────────────────────────────── */}
            {dialogTab === 1 && opportunityId && (
              <ActivityTimeline opportunityId={opportunityId} maxHeight={500} />
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
            disabled={!canEdit || !originalOpp}
          >
            Save
          </ConfirmSaveButton>
        )}
      </Box>

      {/*
        PaymentEditDialog stacks on top of this Opp drawer when the user
        clicks the edit icon on a row in the inline Payment Schedule
        accordion. Mounting it inside the Drawer keeps it visually tied
        to the Opp context. On save we refetch the inline list so the
        user sees the updated row without closing the drawer. Mounted
        unconditionally (`open` drives visibility) so MUI's Dialog
        handles enter/exit transitions cleanly.
      */}
      <PaymentEditDialog
        open={detailPayment !== null}
        onClose={() => setDetailPayment(null)}
        paymentId={detailPayment?.Id ?? null}
        initialData={detailPayment ?? undefined}
        onSaved={() => {
          setDetailPayment(null);
          paymentListQuery.refetch();
        }}
        onDeleted={() => {
          // Same refresh semantics as onSaved — the record is now gone, the
          // inline accordion needs a re-fetch to drop it from the list.
          setDetailPayment(null);
          paymentListQuery.refetch();
        }}
      />

      {/*
        PaymentCreateDialog — opens when the user clicks the "+" button in
        the Payment Schedule accordion summary. On success: expand the
        accordion (in case it was collapsed) and refetch so the new row
        shows immediately; drawer stays open so the user can continue
        editing the Opp.
      */}
      <PaymentCreateDialog
        open={createPaymentOpen}
        onClose={() => setCreatePaymentOpen(false)}
        opportunityId={opportunityId}
        opportunityName={originalOpp?.Name ?? null}
        onCreated={() => {
          setCreatePaymentOpen(false);
          setScheduleExpanded(true);
          paymentListQuery.refetch();
        }}
      />
    </Drawer>
  );
};

export default OpportunityEditDialog;
