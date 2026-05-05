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
  Assignment as TasksTabIcon,
  CheckCircle as CheckCircleIcon,
  RadioButtonUnchecked as UncheckedIcon,
  PersonAdd as PersonAddIcon,
} from '@mui/icons-material';
import { useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import ConfirmSaveButton from './ConfirmSaveButton';
import ActivityTimeline from './ActivityTimeline';
import PaymentEditDialog from './PaymentEditDialog';
import PaymentCreateDialog from './PaymentCreateDialog';
import TaskPanel from './TaskPanel';
import AccountEditDialog from './AccountEditDialog';
import ContactEditDialog from './ContactEditDialog';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import { COLLECTING_STAGES, CLOSED_STAGES } from '../types/salesforce';
import { useOpportunityRecordTypes } from '../hooks/useOpportunityRecordTypes';
import { useSchemaPicklist } from '../hooks/useSchemaPicklist';
import { fieldStatusProps, findMissingFields } from '../utils/fieldLoadStatus';
import SaveBlockedDialog from './SaveBlockedDialog';
import DialogStackBreadcrumb from './DialogStackBreadcrumb';
import type { DialogOrigin } from '../contexts/DialogStackContext';

// Fields bound to `editForm.X` in this dialog that the save handler may patch.
// A field absent from the loaded record + touched by the user → silent overwrite
// of SF data the user can't see. We block save when any is missing so the user
// reloads before editing. Read-only / joined fields (Account.Name, Owner.Name,
// CreatedDate, LastModifiedDate, RecordType.Name, ExpectedRevenue, payment
// rollups) are omitted — they can't be edited here and their absence from the
// response doesn't cause data loss on save.
const OPPORTUNITY_EDITABLE_FIELDS: readonly string[] = [
  'Name',
  'StageName',
  'Amount',
  'Probability',
  'CloseDate',
  'RecordTypeId',
  'RenewalRepeat__c',
  'Active_Opportunity__c',
  'LeadSource',
  'NextStep',
  'Description',
  'OwnerId',
  'AccountId',
  'Earliest_Scheduled_Payment__c',
  // PR #173: Primary Contact lookup. NPSP writable Lookup(Contact).
  'npsp__Primary_Contact__c',
  // NOTE: Contract_Start_Date__c, Contract_End_Date__c, Payment_Terms__c,
  // Billing_Frequency__c — bound in the dialog + declared on the TS
  // interface but DO NOT exist in Pursuit's live SF org (confirmed by
  // Jac 2026-04-21 when PR #162 added them to the SOQL and broke the
  // endpoint, reverted in PR #167). Not in this list because the
  // backend doesn't return them, so the save-guard would fire on every
  // Opp save. Separate cleanup PR strips the dead bindings + the TS
  // interface entries.
] as const;

// ── Types ───────────────────────────────────────────────────────────────────

interface OpportunityEditDialogProps {
  open: boolean;
  onClose: () => void;
  opportunityId: string | null;
  initialData?: Record<string, any>;
  onSaved?: (oppId: string, updates: Record<string, any>) => void;
  onStageClosedCompleted?: (opp: { Id: string; Name: string; Amount: number }) => void;
  /** Fires after a successful destructive delete. Parent invalidates any
   *  extra caches the dialog's own invalidateQueries doesn't cover. */
  onDeleted?: (oppId: string) => void;
  /** When provided, shows "Open" icons next to lookup fields for stacked dialog
   *  navigation. `label` is the human-readable name of the target record (shown
   *  in the breadcrumb). `parentInfo` is this dialog's own self-identity so the
   *  pushed stack entry can remember the origin dialog that launched it. */
  onOpenRelated?: (
    type: 'opportunity' | 'account' | 'contact',
    id: string,
    label: string,
    parentInfo?: DialogOrigin,
  ) => void;
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

interface ContactOption {
  Id: string;
  Name: string;
  Email?: string | null;
  AccountId?: string | null;
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
  onDeleted,
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
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dialogTab, setDialogTab] = useState(0);
  const [saveBlockedMissing, setSaveBlockedMissing] = useState<string[]>([]);

  // Merge per-field validation error with load-status caption. Validation
  // errors take priority (user is actively editing); "Not set" / "⚠ Couldn't
  // load current value" show in steady state.
  const getHelperProps = (fieldName: string) => {
    if (errors[fieldName]) {
      return { helperText: errors[fieldName], error: true };
    }
    return fieldStatusProps(fieldName, originalOpp);
  };

  const [users, setUsers] = useState<UserOption[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);

  // Primary Contact picker state (PR #173). Contacts are scoped to the
  // currently-selected AccountId — a primary contact for an Opp almost
  // always belongs to the funding org. If the saved primary contact turns
  // out to belong to a different account (imported data, cross-account
  // ties), the selectedPrimaryContact useMemo below synthesizes an option
  // from the joined relationship so the field still displays correctly.
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  // Inline create-contact dialog state. When the user clicks "+ New
  // contact" we collect LastName (+ optional first/email/title/phone) and
  // post to /api/salesforce/contacts with AccountId = editForm.AccountId.
  // On success the new contact becomes the primary contact on this Opp.
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [newContactDraft, setNewContactDraft] = useState({
    FirstName: '',
    LastName: '',
    Title: '',
    Email: '',
    Phone: '',
  });
  const [creatingContact, setCreatingContact] = useState(false);

  // Click-through fallback (PR #173). Callers that mount OpportunityEditDialog
  // outside the DialogStackContext (Priorities.tsx, Progress.tsx) don't pass
  // `onOpenRelated`, so the original Open icon on the Account autocomplete
  // was silently dropped. Fallback: when no parent handler is provided, open
  // the sub-dialog locally. Preserves the DialogStack flow when a parent
  // DOES manage the stack (Opportunities.tsx via DialogStackRenderer).
  const [subAccountId, setSubAccountId] = useState<string | null>(null);
  const [subContactId, setSubContactId] = useState<string | null>(null);
  const handleOpenRelatedField = useCallback(
    (type: 'opportunity' | 'account' | 'contact', id: string, label: string) => {
      if (onOpenRelated) {
        // Pass self-identity so the pushed entry's breadcrumb can name this
        // Opp as the origin. opportunityId may be null only before the record
        // loads; the Open icons aren't clickable until it does.
        const parentInfo: DialogOrigin = {
          type: 'opportunity',
          id: opportunityId ?? undefined,
          label: originalOpp?.Name ?? 'Opportunity',
        };
        onOpenRelated(type, id, label, parentInfo);
        return;
      }
      if (type === 'account') setSubAccountId(id);
      else if (type === 'contact') setSubContactId(id);
    },
    [onOpenRelated, opportunityId, originalOpp?.Name],
  );

  // Tasks tab state (PR #173). TaskPanel is a drawer; from the Tasks tab we
  // render it stacked over this dialog with `selectedTaskId` + `editOnOpen`
  // to jump straight into edit mode for the clicked row. "+ Add Task" opens
  // it without a selection so the add-form appears.
  const [tasksPanelOpen, setTasksPanelOpen] = useState(false);
  const [tasksPanelSelectedId, setTasksPanelSelectedId] = useState<string | null>(null);
  const [tasksPanelEditOnOpen, setTasksPanelEditOnOpen] = useState(false);

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

  // Load Primary Contact picker options scoped to the currently-selected
  // account (PR #173). Refetches whenever AccountId changes — e.g. user
  // reassigns the Opp to a different account, the contact list updates
  // to that account's contacts. Empty list when no account is set.
  useEffect(() => {
    if (!open) return;
    if (!editForm.AccountId) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    setContactsLoading(true);
    apiService
      .getContacts({ account_id: editForm.AccountId })
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data || res.data || [];
        setContacts(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setContacts([]);
      })
      .finally(() => {
        if (!cancelled) setContactsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, editForm.AccountId]);

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

  // Primary Contact selection — same synthesize-from-joined-relationship
  // fallback pattern as Account. If the stored primary contact isn't in
  // the account-scoped contact list (imported data, cross-account ties),
  // fall back to the SOQL-joined npsp__Primary_Contact__r so the field
  // still shows a meaningful label.
  const selectedPrimaryContact = useMemo(() => {
    const id = editForm.npsp__Primary_Contact__c;
    if (!id) return null;
    const fromList = contacts.find((c) => c.Id === id);
    if (fromList) return fromList;
    const joined = originalOpp?.npsp__Primary_Contact__r;
    if (joined?.Name) {
      return { Id: id, Name: joined.Name, Email: joined.Email ?? null } as ContactOption;
    }
    return null;
  }, [contacts, editForm.npsp__Primary_Contact__c, originalOpp]);

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

    // Block save if the loaded record is missing any editable field — the
    // user could otherwise silently overwrite SF values the dialog never
    // displayed. The per-field "⚠ Couldn't load current value" caption
    // already flags the individual fields; this guard is the safety net.
    const missing = findMissingFields(OPPORTUNITY_EDITABLE_FIELDS, originalOpp);
    if (missing.length > 0) {
      setSaveBlockedMissing(missing);
      return;
    }

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

  // ── Delete handler ──────────────────────────────────────────────────────
  // Destructive and irreversible at the SF level. Backend enforces ownership
  // via _enforce_record_ownership("Opportunity", ..., "edit_all_opportunities")
  // — admin OR edit_all OR isOwner can delete; everyone else gets 403.
  const handleDelete = async () => {
    if (!opportunityId) return;
    setDeleting(true);
    try {
      await apiService.deleteSfOpportunity(opportunityId);
      toast.success('Opportunity deleted');
      // Cascade invalidation: opp lists + opp-tasks + accounts page joined view.
      queryClient.invalidateQueries('opportunities');
      queryClient.invalidateQueries(['opportunity-tasks', opportunityId]);
      queryClient.invalidateQueries('opportunities-for-accounts');
      if (onDeleted) onDeleted(opportunityId);
      onClose();
    } catch (error: any) {
      const detail =
        error?.response?.data?.detail ||
        error?.response?.data?.error ||
        error?.message ||
        'Failed to delete opportunity';
      toast.error(detail);
    } finally {
      setDeleting(false);
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

      {/* Breadcrumb when this dialog is part of a stacked drill — shows the
          chain of records and makes Cancel-is-Back explicit. Renders null
          outside DialogStackProvider (e.g., Priorities/Progress local mounts). */}
      <DialogStackBreadcrumb />

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
              <Tab label="Tasks" icon={<TasksTabIcon />} iconPosition="start" sx={{ textTransform: 'none' }} />
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
                  {...getHelperProps('Name')}
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
                    {...getHelperProps('StageName')}
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
                  {...getHelperProps('Amount')}
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
                  {...getHelperProps('Probability')}
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
                  {...getHelperProps('CloseDate')}
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
                    {...getHelperProps('RecordTypeId')}
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
                    {...getHelperProps('RenewalRepeat__c')}
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

            {/* ── Section 2: Owner & Relationships ──────────────────────
                Owner + Account + Primary Contact live up top per
                feedback_ui_design_standards / PR #173 — these are the
                most-queried relational fields on an Opp and were
                previously buried below Payment Summary in an
                "Ownership & Contract" section. The contract fields that
                justified that label were removed in PR #168. */}
            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
              Owner & Relationships
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
                {/* Account with always-visible click-through icon. Uses
                    handleOpenRelatedField which defers to the parent's
                    onOpenRelated when present (DialogStackContext),
                    falling back to internal sub-dialog state otherwise.
                    Previously the icon only rendered when a parent
                    handler was wired, so Priorities/Progress users had
                    no way to open the Account editor from here. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Autocomplete
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
                  {editForm.AccountId && (
                    <Tooltip title="Open account">
                      <IconButton
                        size="small"
                        onClick={() => handleOpenRelatedField('account', editForm.AccountId, selectedAccount?.Name ?? 'Account')}
                      >
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Grid>
              <Grid item xs={12} sm={6}>
                {/* Primary Contact — npsp__Primary_Contact__c lookup. Scoped
                    to the current Account; empty when no account selected.
                    Open icon click-through (same fallback as Account).
                    "+ New" opens the inline create-contact dialog. */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <Autocomplete
                    options={
                      selectedPrimaryContact
                      && !contacts.some((c) => c.Id === selectedPrimaryContact.Id)
                        ? [selectedPrimaryContact, ...contacts]
                        : contacts
                    }
                    loading={contactsLoading}
                    getOptionLabel={(option: ContactOption) => option.Name || ''}
                    value={selectedPrimaryContact}
                    onChange={(_e, newValue) =>
                      handleFieldChange('npsp__Primary_Contact__c', newValue?.Id || null)
                    }
                    isOptionEqualToValue={(option, value) => option.Id === value?.Id}
                    disabled={!canEdit || !editForm.AccountId}
                    sx={{ flex: 1 }}
                    renderInput={(params) => {
                      // Merge: per-field load-status takes precedence (data-
                      // integrity concern), else show a hint relevant to the
                      // current state (account not set / contact's email).
                      const loadHelper = getHelperProps('npsp__Primary_Contact__c');
                      const hint = !editForm.AccountId
                        ? 'Pick an account first'
                        : selectedPrimaryContact?.Email || undefined;
                      return (
                        <TextField
                          {...params}
                          label="Primary Contact"
                          size="small"
                          {...loadHelper}
                          helperText={loadHelper.helperText ?? hint}
                        />
                      );
                    }}
                  />
                  {editForm.npsp__Primary_Contact__c && (
                    <Tooltip title="Open contact">
                      <IconButton
                        size="small"
                        onClick={() => handleOpenRelatedField('contact', editForm.npsp__Primary_Contact__c!, selectedPrimaryContact?.Name ?? 'Contact')}
                      >
                        <OpenInNewIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  {canEdit && editForm.AccountId && (
                    <Tooltip title="New contact at this account">
                      <IconButton
                        size="small"
                        onClick={() => {
                          setNewContactDraft({ FirstName: '', LastName: '', Title: '', Email: '', Phone: '' });
                          setCreateContactOpen(true);
                        }}
                      >
                        <PersonAddIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              </Grid>
            </Grid>

            {/* ── Section 3: Details ──────────────────────────────────── */}
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
                  {...getHelperProps('LeadSource')}
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
                  {...getHelperProps('NextStep')}
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
                  {...getHelperProps('Description')}
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
                      {...getHelperProps('Earliest_Scheduled_Payment__c')}
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

            {/* ── Tab 2: Tasks ───────────────────────────────────────────
                Compact list of the opp's tasks with click-through to the
                full TaskPanel drawer (stacked below). Rather than
                re-implement inline editing here we reuse TaskPanel
                wholesale — one source of truth for the task-edit UX. */}
            {dialogTab === 2 && opportunityId && originalOpp && (
              <OpportunityTasksTabPanel
                opportunityId={opportunityId}
                onOpenFull={(taskId) => {
                  setTasksPanelSelectedId(taskId ?? null);
                  setTasksPanelEditOnOpen(!!taskId);
                  setTasksPanelOpen(true);
                }}
              />
            )}
          </>
        )}
      </Box>

      {/* Sticky footer */}
      <Box sx={{ px: 3, py: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        {/* Destructive Delete only on the Details tab — same gate as Save.
            canEdit at line ~268 already encodes admin OR edit_all OR
            (isOwner && edit_own_opportunities); backend ownership helper
            re-enforces server-side. */}
        {dialogTab === 0 && originalOpp && canEdit && (
          <ConfirmSaveButton
            onConfirm={handleDelete}
            loading={deleting}
            disabled={!opportunityId}
            variant="outlined"
            color="error"
            confirmTitle="Delete Opportunity?"
            confirmMessage="This permanently deletes the opportunity from Salesforce. Child tasks and payments will be orphaned. This cannot be undone."
            confirmLabel="Delete"
            sx={{ mr: 'auto' }}
          >
            Delete
          </ConfirmSaveButton>
        )}
        <Button onClick={onClose} disabled={saving || deleting}>
          {dialogTab === 0 ? 'Cancel' : 'Close'}
        </Button>
        {dialogTab === 0 && (
          <ConfirmSaveButton
            onConfirm={handleSave}
            loading={saving}
            disabled={!canEdit || !originalOpp || deleting}
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

      <SaveBlockedDialog
        open={saveBlockedMissing.length > 0}
        onClose={() => setSaveBlockedMissing([])}
        missingFields={saveBlockedMissing}
        recordLabel="opportunity"
      />

      {/* Tasks tab drawer — TaskPanel stacked over this Opp drawer when
          the user clicks an inline row ("Open in full editor") or the
          "+ Add Task" button. Reuses the existing full task UX. */}
      {tasksPanelOpen && originalOpp && (
        <TaskPanel
          open={tasksPanelOpen}
          onClose={() => {
            setTasksPanelOpen(false);
            setTasksPanelSelectedId(null);
            setTasksPanelEditOnOpen(false);
            // Refresh the inline list inside this dialog on close (mutations
            // in TaskPanel already invalidate 'opportunity-tasks' — this is
            // defense-in-depth).
            queryClient.invalidateQueries(['opportunity-tasks', opportunityId]);
          }}
          opportunity={{
            Id: originalOpp.Id,
            Name: originalOpp.Name,
            Account: originalOpp.Account || null,
            StageName: originalOpp.StageName,
            Amount: originalOpp.Amount ?? null,
            Probability: originalOpp.Probability ?? null,
            CloseDate: originalOpp.CloseDate ?? null,
            Owner: originalOpp.Owner || null,
          }}
          selectedTaskId={tasksPanelSelectedId}
          editOnOpen={tasksPanelEditOnOpen}
        />
      )}

      {/* Click-through sub-dialogs — render only when parent didn't
          provide onOpenRelated (i.e., the dialog is mounted outside
          DialogStackContext). When onOpenRelated IS provided, the
          parent's stack renders its own copy of these dialogs, so we
          keep these inert to avoid double-rendering. */}
      {!onOpenRelated && subAccountId && (
        <AccountEditDialog
          open
          onClose={() => setSubAccountId(null)}
          accountId={subAccountId}
          onDeleted={() => setSubAccountId(null)}
          onSaved={() => {
            queryClient.invalidateQueries('accounts');
            queryClient.invalidateQueries('opportunities');
            setSubAccountId(null);
          }}
        />
      )}
      {!onOpenRelated && subContactId && (
        <ContactEditDialog
          open
          onClose={() => setSubContactId(null)}
          contactId={subContactId}
          onDeleted={() => {
            // If the deleted contact was the primary, clear the lookup so
            // it doesn't leave a stale foreign-key in editForm.
            if (editForm.npsp__Primary_Contact__c === subContactId) {
              handleFieldChange('npsp__Primary_Contact__c', null);
            }
            setSubContactId(null);
          }}
          onSaved={() => {
            queryClient.invalidateQueries('all-contacts');
            queryClient.invalidateQueries(['opportunity-contacts', editForm.AccountId]);
            setSubContactId(null);
          }}
        />
      )}

      {/* Create Primary Contact inline dialog — mirrors the pattern in
          NewOpportunity.tsx. On success, the new contact becomes the
          Opp's primary contact (editForm.npsp__Primary_Contact__c) and
          gets added to the contacts list so the Autocomplete renders
          the new selection without another round-trip. */}
      <Dialog open={createContactOpen} onClose={() => setCreateContactOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>New Contact at {originalOpp?.Account?.Name || 'this account'}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField
                  label="First Name"
                  fullWidth
                  size="small"
                  value={newContactDraft.FirstName}
                  onChange={(e) => setNewContactDraft({ ...newContactDraft, FirstName: e.target.value })}
                />
              </Grid>
              <Grid item xs={6}>
                <TextField
                  label="Last Name"
                  fullWidth
                  size="small"
                  required
                  value={newContactDraft.LastName}
                  onChange={(e) => setNewContactDraft({ ...newContactDraft, LastName: e.target.value })}
                />
              </Grid>
            </Grid>
            <TextField
              label="Title"
              fullWidth
              size="small"
              value={newContactDraft.Title}
              onChange={(e) => setNewContactDraft({ ...newContactDraft, Title: e.target.value })}
            />
            <TextField
              label="Email"
              type="email"
              fullWidth
              size="small"
              value={newContactDraft.Email}
              onChange={(e) => setNewContactDraft({ ...newContactDraft, Email: e.target.value })}
            />
            <TextField
              label="Phone"
              fullWidth
              size="small"
              value={newContactDraft.Phone}
              onChange={(e) => setNewContactDraft({ ...newContactDraft, Phone: e.target.value })}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateContactOpen(false)} disabled={creatingContact}>Cancel</Button>
          <ConfirmSaveButton
            loading={creatingContact}
            disabled={!newContactDraft.LastName.trim() || !editForm.AccountId}
            confirmTitle="Create in Salesforce?"
            confirmMessage="This creates a new contact in Salesforce and sets it as the Primary Contact on this opportunity."
            onConfirm={async () => {
              if (!editForm.AccountId || !newContactDraft.LastName.trim()) return;
              setCreatingContact(true);
              try {
                const res = await apiService.createContact({
                  FirstName: newContactDraft.FirstName || undefined,
                  LastName: newContactDraft.LastName.trim(),
                  AccountId: editForm.AccountId,
                  Title: newContactDraft.Title || undefined,
                  Email: newContactDraft.Email || undefined,
                  Phone: newContactDraft.Phone || undefined,
                });
                const payload = res.data?.data || res.data;
                const newId: string | undefined = payload?.id || payload?.Id;
                if (!newId) {
                  toast.error('Contact created but server did not return an id — refresh to see it.');
                  setCreateContactOpen(false);
                  return;
                }
                // Wire the new contact as this Opp's primary contact + inject
                // into the local contacts list so the Autocomplete renders
                // the new selection without waiting on a refetch.
                const displayName = [newContactDraft.FirstName, newContactDraft.LastName].filter(Boolean).join(' ').trim();
                const injected: ContactOption = {
                  Id: newId,
                  Name: displayName || newContactDraft.LastName.trim(),
                  Email: newContactDraft.Email || null,
                  AccountId: editForm.AccountId,
                };
                setContacts((prev) => [injected, ...prev]);
                handleFieldChange('npsp__Primary_Contact__c', newId);
                toast.success('Contact created');
                setCreateContactOpen(false);
                queryClient.invalidateQueries('all-contacts');
              } catch (err: any) {
                const detail = err?.response?.data?.detail || err?.message || 'Failed to create contact';
                toast.error(detail);
              } finally {
                setCreatingContact(false);
              }
            }}
          >
            Create Contact
          </ConfirmSaveButton>
        </DialogActions>
      </Dialog>
    </Drawer>
  );
};

// ── Tasks tab panel ─────────────────────────────────────────────────────────

/** Condensed task list rendered inside the Opp dialog's Tasks tab. Clicks
 *  delegate to the shared TaskPanel drawer for the actual edit UX — this
 *  component stays read-only so we don't duplicate the inline-edit logic
 *  that lives in TaskPanel + PriorityTable. */
interface OpportunityTasksTabPanelProps {
  opportunityId: string;
  onOpenFull: (taskId?: string) => void;
}

function OpportunityTasksTabPanel({ opportunityId, onOpenFull }: OpportunityTasksTabPanelProps): JSX.Element {
  const { data, isLoading, error } = useQuery(
    ['opportunity-tasks', opportunityId],
    async () => {
      const response = await apiService.getOpportunityTasks(opportunityId);
      return response.data;
    },
    { enabled: !!opportunityId },
  );
  const tasks: Array<Record<string, any>> = data?.data || data?.tasks || [];
  const openTasks = tasks.filter((t) => t.Status !== 'Completed');
  const completedTasks = tasks.filter((t) => t.Status === 'Completed');
  const hasError = !!error;

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="body2" color="text.secondary">
          {isLoading ? 'Loading…' : `${openTasks.length} open · ${completedTasks.length} completed`}
        </Typography>
        <Button size="small" startIcon={<AddIcon />} onClick={() => onOpenFull()}>
          Add Task
        </Button>
      </Box>
      {hasError && (
        <Alert severity="error" sx={{ mb: 1 }}>Could not load tasks for this opportunity.</Alert>
      )}
      {!isLoading && tasks.length === 0 && (
        <Alert severity="info">No tasks yet. Click "Add Task" to create one.</Alert>
      )}
      {tasks.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 28 }} />
              <TableCell sx={{ fontWeight: 600 }}>Subject</TableCell>
              <TableCell sx={{ fontWeight: 600, width: 110 }}>Due Date</TableCell>
              <TableCell sx={{ fontWeight: 600, width: 110 }}>Status</TableCell>
              <TableCell sx={{ fontWeight: 600, width: 90 }}>Priority</TableCell>
              <TableCell sx={{ fontWeight: 600, width: 140 }}>Owner</TableCell>
              <TableCell sx={{ width: 40 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {[...openTasks, ...completedTasks].map((task) => (
              <TableRow
                key={task.Id}
                hover
                sx={{ cursor: 'pointer' }}
                onClick={() => onOpenFull(task.Id)}
              >
                <TableCell>
                  {task.Status === 'Completed' ? (
                    <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                  ) : (
                    <UncheckedIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                  )}
                </TableCell>
                <TableCell sx={{ textDecoration: task.Status === 'Completed' ? 'line-through' : 'none' }}>
                  {task.Subject || '(no subject)'}
                </TableCell>
                <TableCell>
                  {task.ActivityDate
                    ? new Date(task.ActivityDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : '—'}
                </TableCell>
                <TableCell>
                  <Chip label={task.Status || 'Not Started'} size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} />
                </TableCell>
                <TableCell>{task.Priority || 'Normal'}</TableCell>
                <TableCell>{task.OwnerName || task.Owner?.Name || '—'}</TableCell>
                <TableCell>
                  <Tooltip title="Open in full editor">
                    <IconButton size="small" onClick={(e) => { e.stopPropagation(); onOpenFull(task.Id); }}>
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

export default OpportunityEditDialog;
