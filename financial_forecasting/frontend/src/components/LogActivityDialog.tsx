import React, { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Autocomplete,
  Box,
  CircularProgress,
} from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { parseISO } from 'date-fns';
import { apiService } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { ACTIVITY_TYPE_CONFIG } from './ActivityTimeline';
import type { Activity, ActivityType, ActivityCreatePayload, ActivityUpdatePayload } from '../types/activity';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Only these types can be created manually (slack-message & calendar-event come from syncs) */
const MANUAL_ACTIVITY_TYPES: ActivityType[] = ['call', 'email', 'meeting', 'note'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract an array from varying react-query cache shapes (matches GlobalSearch.tsx:93) */
function toArray(cached: unknown): Record<string, any>[] {
  if (Array.isArray(cached)) return cached;
  if (cached && typeof cached === 'object') {
    const obj = cached as Record<string, any>;
    return obj.opportunities || obj.data || [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LogActivityDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editActivity?: Activity | null;
  defaultOpportunityId?: string;
  defaultAccountId?: string;
  defaultContactId?: string;
}

interface FormState {
  type: ActivityType;
  subject: string;
  description: string;
  activityDate: Date | null;
  opportunityId: string | null;
  accountId: string | null;
  contactIds: string[];
}

interface FormErrors {
  subject?: string;
}

const INITIAL_FORM: FormState = {
  type: 'call',
  subject: '',
  description: '',
  activityDate: null,
  opportunityId: null,
  accountId: null,
  contactIds: [],
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const LogActivityDialog: React.FC<LogActivityDialogProps> = ({
  open,
  onClose,
  onSaved,
  editActivity,
  defaultOpportunityId,
  defaultAccountId,
  defaultContactId,
}) => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  const isEditMode = !!editActivity;

  // ── Cache reads for Autocomplete options ─────────────────────────────────
  const opportunities = useMemo(() => toArray(queryClient.getQueryData('opportunities')), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const accounts = useMemo(() => toArray(queryClient.getQueryData('accounts')), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const contacts = useMemo(() => toArray(queryClient.getQueryData('all-contacts')), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset form when dialog opens ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSaving(false);

    if (editActivity) {
      setForm({
        type: editActivity.type,
        subject: editActivity.subject,
        description: editActivity.description || '',
        activityDate: editActivity.activity_date ? parseISO(editActivity.activity_date) : new Date(),
        opportunityId: editActivity.opportunity_id,
        accountId: editActivity.account_id,
        contactIds: editActivity.contact_ids || [],
      });
    } else {
      setForm({
        ...INITIAL_FORM,
        activityDate: new Date(),
        opportunityId: defaultOpportunityId || null,
        accountId: defaultAccountId || null,
        contactIds: defaultContactId ? [defaultContactId] : [],
      });
    }
  }, [open, editActivity, defaultOpportunityId, defaultAccountId, defaultContactId]);

  // ── Resolve selected entities from cache ─────────────────────────────────
  const selectedOpp = useMemo(
    () => opportunities.find((o) => o.Id === form.opportunityId) || null,
    [opportunities, form.opportunityId],
  );
  const selectedAcct = useMemo(
    () => accounts.find((a) => a.Id === form.accountId) || null,
    [accounts, form.accountId],
  );
  const selectedContacts = useMemo(
    () => contacts.filter((c) => form.contactIds.includes(c.Id)),
    [contacts, form.contactIds],
  );

  // ── Handlers ─────────────────────────────────────────────────────────────
  const updateField = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    if (field === 'subject') setErrors((prev) => ({ ...prev, subject: undefined }));
  };

  const validate = (): boolean => {
    const newErrors: FormErrors = {};
    if (!form.subject.trim()) newErrors.subject = 'Subject is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (saving) return;
    if (!validate()) return;
    setSaving(true);

    // Build the ISO date string, preserving time for edit or using "now" for create
    let activityDateISO: string;
    if (form.activityDate) {
      // Clone to avoid mutating React state
      const d = new Date(form.activityDate.getTime());
      if (isEditMode && editActivity?.activity_date) {
        // Preserve original time, use new date
        const origTime = parseISO(editActivity.activity_date);
        d.setHours(origTime.getHours(), origTime.getMinutes(), origTime.getSeconds());
      } else {
        // Create mode: use picked date with current time
        const now = new Date();
        d.setHours(now.getHours(), now.getMinutes(), now.getSeconds());
      }
      activityDateISO = d.toISOString();
    } else {
      activityDateISO = new Date().toISOString();
    }

    try {
      if (isEditMode && editActivity) {
        // Build diff — only send changed fields
        const diff: ActivityUpdatePayload = {};
        const trimmedSubject = form.subject.trim();
        if (form.type !== editActivity.type) diff.type = form.type;
        if (trimmedSubject !== editActivity.subject) diff.subject = trimmedSubject;
        if ((form.description.trim() || '') !== (editActivity.description || '')) diff.description = form.description.trim() || undefined;
        if (activityDateISO !== editActivity.activity_date) diff.activity_date = activityDateISO;
        if (form.opportunityId !== editActivity.opportunity_id) diff.opportunity_id = form.opportunityId || undefined;
        if (form.accountId !== editActivity.account_id) diff.account_id = form.accountId || undefined;
        if (JSON.stringify(form.contactIds) !== JSON.stringify(editActivity.contact_ids || [])) diff.contact_ids = form.contactIds;

        if (Object.keys(diff).length === 0) {
          toast('No changes to save');
          setSaving(false);
          return;
        }
        await apiService.updateActivity(editActivity.id, diff);
        toast.success('Activity updated');
      } else {
        // Create
        const payload: ActivityCreatePayload = {
          type: form.type,
          subject: form.subject.trim(),
          activity_date: activityDateISO,
          source: 'manual',
          description: form.description.trim() || undefined,
          opportunity_id: form.opportunityId || undefined,
          account_id: form.accountId || undefined,
          contact_ids: form.contactIds.length > 0 ? form.contactIds : undefined,
          logged_by: user?.name || undefined,
        };
        await apiService.createActivity(payload);
        toast.success('Activity logged');
      }

      onSaved();
      onClose();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to save activity');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onClose={() => { if (!saving) onClose(); }} maxWidth="sm" fullWidth>
      <DialogTitle>{isEditMode ? 'Edit Activity' : 'Log Activity'}</DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        {/* Activity type */}
        <FormControl size="small" fullWidth>
          <InputLabel id="log-activity-type-label">Type</InputLabel>
          <Select
            labelId="log-activity-type-label"
            value={form.type}
            onChange={(e) => updateField('type', e.target.value as ActivityType)}
            label="Type"
          >
            {MANUAL_ACTIVITY_TYPES.map((t) => (
              <MenuItem key={t} value={t}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Box sx={{ color: ACTIVITY_TYPE_CONFIG[t].color, display: 'flex' }}>
                    {ACTIVITY_TYPE_CONFIG[t].icon}
                  </Box>
                  {ACTIVITY_TYPE_CONFIG[t].label}
                </Box>
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {/* Subject */}
        <TextField
          label="Subject"
          size="small"
          fullWidth
          required
          value={form.subject}
          onChange={(e) => updateField('subject', e.target.value)}
          error={!!errors.subject}
          helperText={errors.subject}
        />

        {/* Description */}
        <TextField
          label="Description"
          size="small"
          fullWidth
          multiline
          rows={3}
          value={form.description}
          onChange={(e) => updateField('description', e.target.value)}
        />

        {/* Activity Date */}
        <DatePicker
          label="Activity Date"
          value={form.activityDate}
          onChange={(val) => updateField('activityDate', val)}
          slotProps={{ textField: { size: 'small', fullWidth: true, required: true } }}
        />

        {/* Opportunity linking */}
        <Autocomplete
          size="small"
          options={opportunities}
          getOptionLabel={(opt) => opt.Name || ''}
          isOptionEqualToValue={(opt, val) => opt.Id === val?.Id}
          value={selectedOpp}
          onChange={(_e, newVal) => updateField('opportunityId', newVal?.Id || null)}
          renderInput={(params) => <TextField {...params} label="Opportunity" />}
        />

        {/* Account linking */}
        <Autocomplete
          size="small"
          options={accounts}
          getOptionLabel={(opt) => opt.Name || ''}
          isOptionEqualToValue={(opt, val) => opt.Id === val?.Id}
          value={selectedAcct}
          onChange={(_e, newVal) => updateField('accountId', newVal?.Id || null)}
          renderInput={(params) => <TextField {...params} label="Account" />}
        />

        {/* Contact linking (multiple) */}
        <Autocomplete
          size="small"
          multiple
          options={contacts}
          getOptionLabel={(opt) => opt.Name || opt.Email || ''}
          isOptionEqualToValue={(opt, val) => opt.Id === val?.Id}
          value={selectedContacts}
          onChange={(_e, newVal) => updateField('contactIds', newVal.map((c: any) => c.Id))}
          renderInput={(params) => <TextField {...params} label="Contacts" />}
        />
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} size="small" disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="contained"
          size="small"
          onClick={handleSubmit}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={16} /> : undefined}
        >
          {isEditMode ? 'Save Changes' : 'Log Activity'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default LogActivityDialog;
