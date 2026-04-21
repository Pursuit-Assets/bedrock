import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Box,
  Typography,
  Chip,
  TextField,
  Select,
  MenuItem,
  InputLabel,
  FormControl,
  Button,
  IconButton,
  Collapse,
  CircularProgress,
  Alert,
  InputAdornment,
  Menu,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Paper,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import {
  Phone as PhoneIcon,
  Email as EmailIcon,
  Groups as GroupsIcon,
  StickyNote2 as NoteIcon,
  Chat as ChatIcon,
  CalendarMonth as CalendarIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Search as SearchIcon,
  History as HistoryIcon,
  Clear as ClearIcon,
  MoreVert as MoreVertIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Add as AddIcon,
  AutoAwesome as AutoAwesomeIcon,
  FiberManualRecord as BulletIcon,
  CheckCircleOutline as CheckIcon,
  Sync as SyncIcon,
  Visibility as VisibilityIcon,
} from '@mui/icons-material';
import { format, parseISO, isToday, isYesterday, subDays } from 'date-fns';
import { useQueryClient } from 'react-query';
import toast from 'react-hot-toast';
import { useActivities } from '../hooks/useActivities';
import { apiService } from '../services/api';
import { usePermissions } from '../contexts/PermissionsContext';
import LogActivityDialog from './LogActivityDialog';
import ActivitySyncPopover from './ActivitySyncPopover';
import ActivityDetailDialog from './ActivityDetailDialog';
import { highlightText } from '../utils/highlightText';
import type { Activity, ActivityType, ActivityInsightsResponse } from '../types/activity';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ACTIVITY_TYPE_CONFIG: Record<ActivityType, { icon: React.ReactElement; color: string; label: string }> = {
  call: { icon: <PhoneIcon fontSize="small" />, color: 'success.main', label: 'Call' },
  email: { icon: <EmailIcon fontSize="small" />, color: 'info.main', label: 'Email' },
  meeting: { icon: <GroupsIcon fontSize="small" />, color: 'secondary.main', label: 'Meeting' },
  note: { icon: <NoteIcon fontSize="small" />, color: 'warning.main', label: 'Note' },
  'slack-message': { icon: <ChatIcon fontSize="small" />, color: 'warning.dark', label: 'Slack' },
  'calendar-event': { icon: <CalendarIcon fontSize="small" />, color: 'info.dark', label: 'Calendar' },
};

const ALL_ACTIVITY_TYPES: ActivityType[] = ['call', 'email', 'meeting', 'note', 'slack-message', 'calendar-event'];

const DATE_RANGE_OPTIONS = [
  { value: '7d' as const, label: 'Last 7 days' },
  { value: '30d' as const, label: 'Last 30 days' },
  { value: '90d' as const, label: 'Last 90 days' },
  { value: 'all' as const, label: 'All time' },
];

const MOMENTUM_CONFIG: Record<string, { color: 'success' | 'info' | 'error' | 'default'; label: string }> = {
  increasing: { color: 'success', label: 'Increasing' },
  stable: { color: 'info', label: 'Stable' },
  declining: { color: 'error', label: 'Declining' },
  new: { color: 'default', label: 'New' },
};

type DateRangeValue = '7d' | '30d' | '90d' | 'all';

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
// Props
// ---------------------------------------------------------------------------

interface ActivityTimelineProps {
  opportunityId?: string;
  accountId?: string;
  contactId?: string;
  maxHeight?: number;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Format a date group header */
function formatDateHeader(dateStr: string): string {
  const date = parseISO(dateStr);
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEEE, MMMM d, yyyy');
}

/** Group activities by date (yyyy-MM-dd of activity_date) */
function groupByDate(activities: Activity[]): Map<string, Activity[]> {
  const groups = new Map<string, Activity[]>();
  for (const activity of activities) {
    const dateKey = activity.activity_date
      ? format(parseISO(activity.activity_date), 'yyyy-MM-dd')
      : 'unknown';
    const existing = groups.get(dateKey);
    if (existing) {
      existing.push(activity);
    } else {
      groups.set(dateKey, [activity]);
    }
  }
  return groups;
}

/** Single activity card */
function ActivityCard({
  activity,
  expanded,
  onToggle,
  currentEntityType,
  oppNameMap,
  acctNameMap,
  contactNameMap,
  onEdit,
  onDelete,
  onViewDetails,
  searchTerm,
}: {
  activity: Activity;
  expanded: boolean;
  onToggle: () => void;
  currentEntityType: 'opportunity' | 'account' | 'contact';
  oppNameMap: Map<string, string>;
  acctNameMap: Map<string, string>;
  contactNameMap: Map<string, string>;
  onEdit?: (activity: Activity) => void;
  onDelete?: (activity: Activity) => void;
  onViewDetails?: (activity: Activity) => void;
  searchTerm?: string;
}) {
  const config = ACTIVITY_TYPE_CONFIG[activity.type] || ACTIVITY_TYPE_CONFIG.note;
  const activityDate = activity.activity_date ? parseISO(activity.activity_date) : null;
  const isManual = activity.source === 'manual';

  // 3-dot menu state
  const [menuAnchorEl, setMenuAnchorEl] = useState<null | HTMLElement>(null);

  const hasExpandableContent =
    activity.description ||
    activity.email_from ||
    activity.meeting_attendees?.length ||
    activity.meeting_duration_minutes ||
    activity.meeting_location ||
    (activity.attachments && activity.attachments.length > 0);

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1.5,
        py: 1.5,
        px: 1,
        borderRadius: 1,
        '&:hover': { bgcolor: 'action.hover' },
        cursor: hasExpandableContent ? 'pointer' : 'default',
      }}
      onClick={hasExpandableContent ? onToggle : undefined}
      onDoubleClick={onViewDetails ? () => onViewDetails(activity) : undefined}
    >
      {/* Type icon gutter */}
      <Box
        sx={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: `${config.color}`,
          color: 'white',
          flexShrink: 0,
          mt: 0.25,
          '& .MuiSvgIcon-root': { color: 'white' },
        }}
      >
        {config.icon}
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* Header row: subject + metadata */}
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, lineHeight: 1.4 }} noWrap>
            {searchTerm ? highlightText(activity.subject, searchTerm) : activity.subject}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
            <Chip label={config.label} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} />
            {activityDate && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {format(activityDate, 'h:mm a')}
              </Typography>
            )}
            {hasExpandableContent && (
              <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
                {expanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
              </IconButton>
            )}
            {/* 3-dot menu — all activities get View Details; manual also get Edit/Delete */}
            <IconButton
              size="small"
              sx={{ p: 0.25 }}
              onClick={(e) => { e.stopPropagation(); setMenuAnchorEl(e.currentTarget); }}
              aria-label="Activity actions"
            >
              <MoreVertIcon fontSize="small" />
            </IconButton>
            <Menu
              anchorEl={menuAnchorEl}
              open={Boolean(menuAnchorEl)}
              onClose={() => setMenuAnchorEl(null)}
              onClick={(e) => e.stopPropagation()}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
              <MenuItem
                onClick={() => { setMenuAnchorEl(null); onViewDetails?.(activity); }}
                sx={{ fontSize: '0.85rem' }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}><VisibilityIcon fontSize="small" /></ListItemIcon>
                View Details
              </MenuItem>
              {isManual && (
                <MenuItem
                  onClick={() => { setMenuAnchorEl(null); onEdit?.(activity); }}
                  sx={{ fontSize: '0.85rem' }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}><EditIcon fontSize="small" /></ListItemIcon>
                  Edit
                </MenuItem>
              )}
              {isManual && (
                <MenuItem
                  onClick={() => { setMenuAnchorEl(null); onDelete?.(activity); }}
                  sx={{ fontSize: '0.85rem', color: 'error.main' }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}><DeleteIcon fontSize="small" color="error" /></ListItemIcon>
                  Delete
                </MenuItem>
              )}
            </Menu>
          </Box>
        </Box>

        {/* Description snippet (2-line clamp) */}
        {(activity.email_snippet || activity.description) && !expanded && (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              mt: 0.25,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.4,
            }}
          >
            {searchTerm
              ? highlightText((activity.email_snippet || activity.description) || '', searchTerm)
              : (activity.email_snippet || activity.description)}
          </Typography>
        )}

        {/* Source + related entity chips (with name resolution) */}
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
          <Chip
            label={activity.source.replace('-', ' ')}
            size="small"
            sx={{ height: 18, fontSize: '0.6rem', textTransform: 'capitalize' }}
          />
          {activity.opportunity_id && currentEntityType !== 'opportunity' && (
            <Chip
              label={`Opp: ${oppNameMap.get(activity.opportunity_id) || activity.opportunity_id.slice(0, 8) + '...'}`}
              size="small"
              variant="outlined"
              sx={{ height: 18, fontSize: '0.6rem' }}
            />
          )}
          {activity.account_id && currentEntityType !== 'account' && (
            <Chip
              label={`Acct: ${acctNameMap.get(activity.account_id) || activity.account_id.slice(0, 8) + '...'}`}
              size="small"
              variant="outlined"
              sx={{ height: 18, fontSize: '0.6rem' }}
            />
          )}
          {activity.contact_ids && activity.contact_ids.length > 0 && currentEntityType !== 'contact' && (() => {
            const MAX_VISIBLE = 2;
            const visible = activity.contact_ids.slice(0, MAX_VISIBLE);
            const overflow = activity.contact_ids.length - MAX_VISIBLE;
            return (
              <>
                {visible.map((cId) => (
                  <Chip
                    key={cId}
                    label={`Contact: ${contactNameMap.get(cId) || cId.slice(0, 8) + '...'}`}
                    size="small"
                    variant="outlined"
                    sx={{ height: 18, fontSize: '0.6rem' }}
                  />
                ))}
                {overflow > 0 && (
                  <Chip
                    label={`+${overflow} more`}
                    size="small"
                    variant="outlined"
                    sx={{ height: 18, fontSize: '0.6rem' }}
                  />
                )}
              </>
            );
          })()}
          {activity.logged_by && (
            <Chip label={activity.logged_by} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.6rem' }} />
          )}
        </Box>

        {/* Expandable detail section */}
        <Collapse in={expanded}>
          <Box sx={{ mt: 1.5, pl: 0.5, borderLeft: '2px solid', borderColor: 'divider' }}>
            {/* Full description */}
            {activity.description && (
              <Box sx={{ mb: 1.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Description
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.25, whiteSpace: 'pre-line', lineHeight: 1.5, pl: 1 }}>
                  {activity.description}
                </Typography>
              </Box>
            )}

            {/* Email metadata */}
            {activity.email_from && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  From:
                </Typography>
                <Typography variant="body2" component="span" sx={{ ml: 0.5 }}>
                  {activity.email_from}
                </Typography>
              </Box>
            )}
            {activity.email_to && activity.email_to.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  To:
                </Typography>
                <Typography variant="body2" component="span" sx={{ ml: 0.5 }}>
                  {activity.email_to.join(', ')}
                </Typography>
              </Box>
            )}
            {activity.email_cc && activity.email_cc.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  CC:
                </Typography>
                <Typography variant="body2" component="span" sx={{ ml: 0.5 }}>
                  {activity.email_cc.join(', ')}
                </Typography>
              </Box>
            )}

            {/* Meeting metadata */}
            {activity.meeting_duration_minutes != null && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Duration:
                </Typography>
                <Typography variant="body2" component="span" sx={{ ml: 0.5 }}>
                  {activity.meeting_duration_minutes} min
                </Typography>
              </Box>
            )}
            {activity.meeting_location && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Location:
                </Typography>
                <Typography variant="body2" component="span" sx={{ ml: 0.5 }}>
                  {activity.meeting_location}
                </Typography>
              </Box>
            )}
            {activity.meeting_attendees && activity.meeting_attendees.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.25 }}>
                  Attendees ({activity.meeting_attendees.length})
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', pl: 1 }}>
                  {activity.meeting_attendees.map((att, i) => (
                    <Chip
                      key={i}
                      label={att.name || att.email || att.Name || 'Unknown'}
                      size="small"
                      variant="outlined"
                      sx={{ height: 22, fontSize: '0.7rem' }}
                    />
                  ))}
                </Box>
              </Box>
            )}

            {/* Attachments count */}
            {activity.attachments && activity.attachments.length > 0 && (
              <Box sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Attachments:
                </Typography>
                <Typography variant="body2" component="span" sx={{ ml: 0.5 }}>
                  {activity.attachments.length} file{activity.attachments.length !== 1 ? 's' : ''}
                </Typography>
              </Box>
            )}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  opportunityId,
  accountId,
  contactId,
  maxHeight = 500,
}) => {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canSync = can('trigger_data_sync');

  // ── Filter state ─────────────────────────────────────────────────────────
  const [typeFilter, setTypeFilter] = useState<ActivityType[]>([]);
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeValue>('all');

  // ── CRUD state ───────────────────────────────────────────────────────────
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Activity | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Activity | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Sync & detail state ─────────────────────────────────────────────────
  const [syncAnchorEl, setSyncAnchorEl] = useState<HTMLElement | null>(null);
  const [detailTarget, setDetailTarget] = useState<Activity | null>(null);

  // ── AI Insights state ────────────────────────────────────────────────────
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [insightsData, setInsightsData] = useState<ActivityInsightsResponse | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);

  // Debounce search input
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchText(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(value), 300);
  }, []);

  // Determine entity type for chip display logic
  const currentEntityType: 'opportunity' | 'account' | 'contact' = opportunityId
    ? 'opportunity'
    : accountId
    ? 'account'
    : 'contact';

  const canShowInsights = !!(opportunityId || accountId);

  // ── Reset insights when entity changes (prevent stale data from previous entity) ──
  useEffect(() => {
    setInsightsOpen(false);
    setInsightsData(null);
    setInsightsError(null);
    setInsightsLoading(false);
  }, [opportunityId, accountId]);

  // ── Date range → startDate/endDate for hook ──────────────────────────────
  const { startDate, endDate } = useMemo(() => {
    if (dateRange === 'all') return { startDate: undefined, endDate: undefined };
    const now = new Date();
    const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
    return {
      startDate: format(subDays(now, days), 'yyyy-MM-dd'),
      endDate: format(now, 'yyyy-MM-dd'),
    };
  }, [dateRange]);

  // ── Data fetching ────────────────────────────────────────────────────────
  const {
    activities,
    total,
    isLoading,
    error,
    refetch,
    loadMore,
    hasMore,
    isSearchMode,
    isFetching,
  } = useActivities({
    opportunityId,
    accountId,
    contactId,
    type: typeFilter.length === 1 ? typeFilter[0] : undefined,
    search: debouncedSearch || undefined,
    startDate,
    endDate,
  });

  // ── Entity name resolution maps ──────────────────────────────────────────
  const { oppNameMap, acctNameMap, contactNameMap } = useMemo(() => {
    const oppMap = new Map<string, string>();
    for (const o of toArray(queryClient.getQueryData('opportunities'))) {
      if (o.Id && o.Name) oppMap.set(o.Id, o.Name);
    }
    const acctMap = new Map<string, string>();
    for (const a of toArray(queryClient.getQueryData('accounts'))) {
      if (a.Id && a.Name) acctMap.set(a.Id, a.Name);
    }
    const contactMap = new Map<string, string>();
    for (const c of toArray(queryClient.getQueryData('all-contacts'))) {
      if (c.Id && c.Name) contactMap.set(c.Id, c.Name);
    }
    return { oppNameMap: oppMap, acctNameMap: acctMap, contactNameMap: contactMap };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities]);

  // Client-side multi-type filter (API only supports single type filter)
  const filteredActivities = useMemo(() => {
    if (typeFilter.length <= 1) return activities;
    return activities.filter((a) => typeFilter.includes(a.type));
  }, [activities, typeFilter]);

  // Group by date
  const dateGroups = useMemo(() => groupByDate(filteredActivities), [filteredActivities]);

  const hasFilters = typeFilter.length > 0 || searchText.length > 0 || dateRange !== 'all';

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleClearFilters = useCallback(() => {
    setTypeFilter([]);
    setSearchText('');
    setDebouncedSearch('');
    setDateRange('all');
  }, []);

  const handleTypeChange = useCallback((event: SelectChangeEvent<ActivityType[]>) => {
    const value = event.target.value;
    setTypeFilter(typeof value === 'string' ? (value.split(',') as ActivityType[]) : value);
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleActivitySaved = useCallback(() => {
    queryClient.invalidateQueries('activities');
  }, [queryClient]);

  const handleEdit = useCallback((activity: Activity) => {
    setEditTarget(activity);
  }, []);

  const handleDelete = useCallback((activity: Activity) => {
    setDeleteTarget(activity);
  }, []);

  const handleViewDetails = useCallback((activity: Activity) => {
    setDetailTarget(activity);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await apiService.deleteActivity(deleteTarget.id);
      queryClient.invalidateQueries('activities');
      toast.success('Activity deleted');
      setDeleteTarget(null);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || 'Failed to delete activity');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, queryClient]);

  const handleInsightsToggle = useCallback(async () => {
    const opening = !insightsOpen;
    setInsightsOpen(opening);
    if (opening && !insightsData && !insightsLoading) {
      setInsightsLoading(true);
      setInsightsError(null);
      try {
        const res = await apiService.activityInsights({
          opportunity_id: opportunityId,
          account_id: accountId,
        });
        setInsightsData(res.data as ActivityInsightsResponse);
      } catch (err: any) {
        setInsightsError(err.response?.data?.detail || 'Failed to generate insights');
      } finally {
        setInsightsLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insightsOpen, insightsData, insightsLoading, opportunityId, accountId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Filter bar.
          alignItems:'flex-start' on the outer row keeps the RIGHT action
          buttons pinned to the top line (Type/Date) even when the LEFT group
          wraps Search onto a second row in a narrow drawer (BUG-UI-11). */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 2, flexWrap: 'wrap' }}>
        {/* LEFT group: filters */}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flex: 1, flexWrap: 'wrap', minWidth: 0 }}>
          {/* Type filter */}
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="activity-type-filter-label">Type</InputLabel>
            <Select
              labelId="activity-type-filter-label"
              multiple
              value={typeFilter}
              onChange={handleTypeChange}
              label="Type"
              renderValue={(selected) => (
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {selected.map((t) => (
                    <Chip
                      key={t}
                      label={ACTIVITY_TYPE_CONFIG[t]?.label || t}
                      size="small"
                      sx={{ height: 20, fontSize: '0.65rem' }}
                    />
                  ))}
                </Box>
              )}
            >
              {ALL_ACTIVITY_TYPES.map((t) => (
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

          {/* Date range filter */}
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="activity-date-range-label">Date</InputLabel>
            <Select
              labelId="activity-date-range-label"
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as DateRangeValue)}
              label="Date"
            >
              {DATE_RANGE_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Search */}
          <TextField
            size="small"
            placeholder="Search activities..."
            value={searchText}
            onChange={handleSearchChange}
            sx={{ flex: 1, minWidth: 140 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
            }}
          />

          {hasFilters && (
            <Button size="small" startIcon={<ClearIcon />} onClick={handleClearFilters} sx={{ textTransform: 'none' }}>
              Clear
            </Button>
          )}
        </Box>

        {/* RIGHT group: action buttons.
            Heights are pinned to 40px so they line up with the size="small"
            Select / TextField inputs in the LEFT group (BUG-UI-11). */}
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexShrink: 0 }}>
          {canSync && (
            <Button
              size="small"
              variant="outlined"
              startIcon={<SyncIcon />}
              onClick={(e) => setSyncAnchorEl(e.currentTarget)}
              sx={{ textTransform: 'none', fontSize: '0.8125rem', height: 40 }}
            >
              Sync
            </Button>
          )}
          {canShowInsights && (
            <Button
              size="small"
              variant={insightsOpen ? 'contained' : 'outlined'}
              startIcon={<AutoAwesomeIcon />}
              onClick={handleInsightsToggle}
              sx={{ textTransform: 'none', fontSize: '0.8125rem', height: 40 }}
            >
              AI Insights
            </Button>
          )}
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setLogDialogOpen(true)}
            sx={{ textTransform: 'none', fontSize: '0.8125rem', height: 40 }}
          >
            Add Activity
          </Button>
        </Box>
      </Box>

      {/* AI Insights panel (collapsible) */}
      {canShowInsights && (
        <Collapse in={insightsOpen}>
          <Paper variant="outlined" sx={{ bgcolor: 'grey.50', p: 2, mb: 2, borderRadius: 1 }}>
            {/* Loading */}
            {insightsLoading && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 2 }}>
                <CircularProgress size={20} />
                <Typography variant="body2" color="text.secondary">
                  Generating insights...
                </Typography>
              </Box>
            )}

            {/* Error */}
            {insightsError && !insightsLoading && (
              <Alert severity="warning" sx={{ mb: 0 }}>
                {insightsError}
              </Alert>
            )}

            {/* No data / low confidence */}
            {insightsData && insightsData.confidence === 'none' && !insightsLoading && (
              <Alert severity="info" sx={{ mb: 0 }}>
                Not enough activity data for meaningful insights.
              </Alert>
            )}

            {/* Insights content */}
            {insightsData && insightsData.confidence !== 'none' && !insightsLoading && (
              <Box>
                {/* Momentum chip */}
                {insightsData.momentum && MOMENTUM_CONFIG[insightsData.momentum] && (
                  <Box sx={{ mb: 1.5 }}>
                    <Chip
                      label={`Momentum: ${MOMENTUM_CONFIG[insightsData.momentum].label}`}
                      size="small"
                      color={MOMENTUM_CONFIG[insightsData.momentum].color}
                    />
                  </Box>
                )}

                {/* Summary */}
                <Typography variant="body2" sx={{ mb: 1.5, lineHeight: 1.6 }}>
                  {insightsData.summary}
                </Typography>

                {/* Key Findings */}
                {insightsData.key_findings.length > 0 && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.5 }}>
                      Key Findings
                    </Typography>
                    <List dense disablePadding>
                      {insightsData.key_findings.map((finding, i) => (
                        <ListItem key={i} disableGutters sx={{ py: 0.25 }}>
                          <ListItemIcon sx={{ minWidth: 20 }}>
                            <BulletIcon sx={{ fontSize: 8, color: 'text.secondary' }} />
                          </ListItemIcon>
                          <ListItemText
                            primary={finding}
                            primaryTypographyProps={{ variant: 'body2', lineHeight: 1.4 }}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Box>
                )}

                {/* Action Items */}
                {insightsData.action_items.length > 0 && (
                  <Box sx={{ mb: 1 }}>
                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.5 }}>
                      Action Items
                    </Typography>
                    <List dense disablePadding>
                      {insightsData.action_items.map((item, i) => (
                        <ListItem key={i} disableGutters sx={{ py: 0.25 }}>
                          <ListItemIcon sx={{ minWidth: 24 }}>
                            <CheckIcon sx={{ fontSize: 16, color: 'success.main' }} />
                          </ListItemIcon>
                          <ListItemText
                            primary={item}
                            primaryTypographyProps={{ variant: 'body2', lineHeight: 1.4 }}
                          />
                        </ListItem>
                      ))}
                    </List>
                  </Box>
                )}

                {/* Generated timestamp */}
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', textAlign: 'right' }}>
                  Generated {format(parseISO(insightsData.generated_at), 'MMM d, h:mm a')}
                </Typography>
              </Box>
            )}
          </Paper>
        </Collapse>
      )}

      {/* Content area */}
      <Box
        sx={{
          maxHeight,
          overflow: 'auto',
          flex: 1,
          '&::-webkit-scrollbar': { width: '6px' },
          '&::-webkit-scrollbar-thumb': { bgcolor: 'grey.300', borderRadius: '3px' },
        }}
      ><>
        {/* Loading state */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
            <CircularProgress size={32} />
          </Box>
        )}

        {/* Error state */}
        {error && !isLoading && (
          <Alert
            severity="error"
            sx={{ mb: 2 }}
            action={
              <Button size="small" onClick={() => refetch()}>
                Retry
              </Button>
            }
          >
            Failed to load activities. {(error as Error).message || 'Please try again.'}
          </Alert>
        )}

        {/* Empty state */}
        {!isLoading && !error && filteredActivities.length === 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 6 }}>
            <HistoryIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
            <Typography variant="body1" color="text.secondary" sx={{ fontWeight: 500 }}>
              No activities found
            </Typography>
            <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5, textAlign: 'center' }}>
              {hasFilters
                ? 'Try adjusting your filters or search terms.'
                : `Activities for this ${currentEntityType} will appear here once logged or synced from Salesforce.`}
            </Typography>
          </Box>
        )}

        {/* Timeline content */}
        {!isLoading && !error && filteredActivities.length > 0 && (
          <>
            {/* Result count */}
            <Typography variant="caption" color="text.secondary" sx={{ mb: 1, display: 'block' }}>
              {isSearchMode
                ? `${filteredActivities.length} result${filteredActivities.length !== 1 ? 's' : ''}`
                : `${filteredActivities.length} of ${total} activit${total !== 1 ? 'ies' : 'y'}`}
            </Typography>

            {/* Date-grouped sections */}
            {Array.from(dateGroups.entries()).map(([dateKey, group]) => (
              <Box key={dateKey} sx={{ mb: 2 }}>
                {/* Date header */}
                <Typography
                  variant="overline"
                  sx={{
                    display: 'block',
                    color: 'text.secondary',
                    fontWeight: 600,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    pb: 0.5,
                    mb: 0.5,
                    position: 'sticky',
                    top: 0,
                    bgcolor: 'background.paper',
                    zIndex: 1,
                  }}
                >
                  {formatDateHeader(dateKey)}
                </Typography>

                {/* Activity cards */}
                {group.map((activity) => (
                  <ActivityCard
                    key={activity.id}
                    activity={activity}
                    expanded={expandedId === activity.id}
                    onToggle={() => handleToggleExpand(activity.id)}
                    currentEntityType={currentEntityType}
                    oppNameMap={oppNameMap}
                    acctNameMap={acctNameMap}
                    contactNameMap={contactNameMap}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onViewDetails={handleViewDetails}
                    searchTerm={debouncedSearch || undefined}
                  />
                ))}
              </Box>
            ))}

            {/* Load more button */}
            {hasMore && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={loadMore}
                  disabled={isFetching}
                  sx={{ textTransform: 'none' }}
                >
                  {isFetching ? 'Loading...' : `Load more (${total - filteredActivities.length} remaining)`}
                </Button>
              </Box>
            )}
          </>
        )}
      </></Box>

      {/* Log / Edit Activity Dialog */}
      <LogActivityDialog
        open={logDialogOpen || !!editTarget}
        onClose={() => { setLogDialogOpen(false); setEditTarget(null); }}
        onSaved={handleActivitySaved}
        editActivity={editTarget}
        defaultOpportunityId={opportunityId}
        defaultAccountId={accountId}
        defaultContactId={contactId}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!deleteTarget}
        onClose={() => !deleting && setDeleteTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete Activity</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Are you sure you want to delete this activity? This action cannot be undone.
          </Typography>
          {deleteTarget && (
            <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary' }}>
              &ldquo;{deleteTarget.subject}&rdquo;
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button size="small" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            onClick={handleConfirmDelete}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : <DeleteIcon />}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Sync Popover */}
      <ActivitySyncPopover
        anchorEl={syncAnchorEl}
        onClose={() => setSyncAnchorEl(null)}
        onSyncComplete={() => queryClient.invalidateQueries('activities')}
      />

      {/* Activity Detail Dialog */}
      <ActivityDetailDialog
        activity={detailTarget}
        onClose={() => setDetailTarget(null)}
        onEdit={(a) => { setDetailTarget(null); setEditTarget(a); }}
        onDelete={(a) => { setDetailTarget(null); setDeleteTarget(a); }}
        oppNameMap={oppNameMap}
        acctNameMap={acctNameMap}
        contactNameMap={contactNameMap}
      />
    </Box>
  );
};

export default ActivityTimeline;
