import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDollarMillions } from '../utils/formatters';
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Chip,
  Collapse,
  IconButton,
  Alert,
  Button,
  LinearProgress,
  TextField,
  ToggleButtonGroup,
  ToggleButton,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Tooltip,
  ListSubheader,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import {
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  CalendarToday as CalendarIcon,
  Star as PriorityIcon,
  TrendingUp as TrendingUpIcon,
  AttachMoney as MoneyIcon,
  AccountBalance as WeightedIcon,
  Event as EventIcon,
  Inbox as InboxIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';
import { useQuery } from 'react-query';
import {
  format,
  parseISO,
  startOfWeek,
  endOfDay,
  addDays,
  subDays,
  startOfDay,
} from 'date-fns';

import { apiService } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import WeeklyCalendar, { CalendarEvent, CalendarViewMode } from '../components/WeeklyCalendar';
import PriorityTable, { PriorityOpp } from '../components/PriorityTable';
import TaskInbox, { InboxTask } from '../components/TaskInbox';
import TaskPanel from '../components/TaskPanel';
import OpportunityEditDialog from '../components/OpportunityEditDialog';
import GoalTracker from '../components/GoalTracker';
import { DEFAULT_GOAL } from '../config/goals';
import { useOwnerGoals } from '../hooks/useOwnerGoals';
import DateRangeSelector, { type DateRangeValue } from '../components/DateRangeSelector';
import type { Opportunity } from './Opportunities/helpers';

const PREFS_KEY = 'pursuit-priorities-prefs';

const OPEN_STAGES = [
  'Lead Gen', 'New Lead', 'Qualifying',
  'Design / Proposal Creation', 'Proposal Negotiation',
  'Contract Creation', 'Negotiating Contract',
];

type SnapshotMode = 'all' | 'filtered' | 'priorities';

interface DashboardPrefs {
  collapsed: Record<string, boolean>;
  calendarView: CalendarViewMode;
  topN: number;
  filterUserId: string; // 'all' or a SF user ID
  showWeighted: boolean;
  dateRange: DateRangeValue;
  snapshotMode: SnapshotMode;
  calendarInboxSplit?: number[];
  taskPanelWidth?: number;
  taskInboxMaxHeight?: number;
  calendarTimeGridHeight?: number;
  weekOffset?: number;
  showWeekends?: boolean;
}

function loadPrefs(): DashboardPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = { filterUserId: 'me', showWeighted: false, snapshotMode: 'all', ...JSON.parse(raw) };
      // Migrate old closeDateRange to new dateRange format
      if (parsed.closeDateRange && !parsed.dateRange) {
        const mapping: Record<string, DateRangeValue> = {
          all: { preset: 'all' },
          next30: { preset: 'next30' },
          next60: { preset: 'next60' },
          next90: { preset: 'next90' },
          thisQuarter: { preset: 'thisQuarter' },
          thisYear: { preset: 'currentFY' },
        };
        parsed.dateRange = mapping[parsed.closeDateRange] || { preset: 'all' };
        delete parsed.closeDateRange;
      }
      if (!parsed.dateRange) parsed.dateRange = { preset: 'all' };
      if (parsed._topNV !== 3) {
        parsed.topN = 20;
        parsed._topNV = 3;
      }
      parsed.topN = Math.min(50, Math.max(1, parsed.topN || 20));
      if (parsed.taskPanelWidth != null) parsed.taskPanelWidth = Math.min(800, Math.max(360, parsed.taskPanelWidth));
      if (parsed.taskInboxMaxHeight != null) parsed.taskInboxMaxHeight = Math.min(600, Math.max(200, parsed.taskInboxMaxHeight));
      return parsed;
    }
  } catch {}
  return { collapsed: {}, calendarView: 'week', topN: 20, filterUserId: 'me', showWeighted: false, dateRange: { preset: 'all' }, snapshotMode: 'all' as SnapshotMode };
}

function savePrefs(prefs: DashboardPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

// Collapsible section wrapper
function Section({
  id,
  title,
  icon,
  collapsed,
  onToggle,
  badge,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card sx={{ mb: 2 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover' },
        }}
        onClick={onToggle}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {icon}
          <Typography variant="subtitle1" sx={{ fontWeight: 600, fontSize: '1.1rem' }}>{title}</Typography>
          {badge}
        </Box>
        <IconButton size="small">
          {collapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
        </IconButton>
      </Box>
      <Collapse in={!collapsed}>
        <CardContent sx={{ pt: 0 }}>{children}</CardContent>
      </Collapse>
    </Card>
  );
}

// Resizable Calendar + Inbox split (desktop only)
function CalendarInboxSplit({
  calNeedsReauth,
  calErrorMsg,
  logout,
  calendarEvents,
  calLoading,
  prefs,
  toggleSection,
  setPrefs,
  priorityOpps,
  allOpportunities,
  setTaskPanelOpp,
  setTaskPanelOpen,
  inboxTasks,
  tasksLoading,
  currentUserId,
  onToggleUrgent,
  gcalCount,
  taskCount,
  setSelectedTaskId,
  setEditOnOpen,
  setOrphanTask,
  sfUsers,
}: {
  calNeedsReauth: boolean;
  calErrorMsg?: string;
  logout: () => Promise<void>;
  calendarEvents: CalendarEvent[];
  calLoading: boolean;
  prefs: DashboardPrefs;
  toggleSection: (id: string) => void;
  setPrefs: React.Dispatch<React.SetStateAction<DashboardPrefs>>;
  priorityOpps: PriorityOpp[];
  allOpportunities: any[];
  setTaskPanelOpp: (o: Opportunity | null) => void;
  setTaskPanelOpen: (open: boolean) => void;
  inboxTasks: InboxTask[];
  tasksLoading: boolean;
  currentUserId?: string | null;
  onToggleUrgent?: (taskId: string, urgent: boolean) => void;
  gcalCount: number;
  taskCount: number;
  setSelectedTaskId: (id: string | null) => void;
  setEditOnOpen: (edit: boolean) => void;
  setOrphanTask: (task: any) => void;
  sfUsers: Array<{ Id: string; Name: string; IsActive: boolean }>;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'pursuit-calendar-inbox-split',
    storage: typeof window !== 'undefined' ? localStorage : undefined,
    panelIds: ['calendar', 'inbox'],
  });

  const calendarPanelRef = usePanelRef();
  const inboxPanelRef = usePanelRef();
  const [calCollapsed, setCalCollapsed] = useState(false);
  const [inboxCollapsed, setInboxCollapsed] = useState(false);

  const handleTaskClick = useCallback(
    (taskId: string, whatId: string) => {
      const opp = priorityOpps.find((o) => o.Id === whatId) || allOpportunities.find((o: any) => o.Id === whatId);
      if (opp) {
        const mapped: Opportunity = {
          Id: opp.Id,
          Name: opp.Name,
          AccountId: (opp as any).Account?.Id || '',
          Account: (opp as any).Account ? { Name: (opp as any).Account.Name } : undefined,
          StageName: opp.StageName,
          Amount: opp.Amount,
          Probability: opp.Probability,
          CloseDate: opp.CloseDate,
          CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
          LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(),
          OwnerId: opp.OwnerId || '',
        };
        setTaskPanelOpp(mapped);
        setTaskPanelOpen(true);
        setSelectedTaskId(taskId);
      }
    },
    [priorityOpps, allOpportunities, setTaskPanelOpp, setTaskPanelOpen, setSelectedTaskId]
  );

  const openTaskCount = inboxTasks.filter((t) => t.Status !== 'Completed').length;

  return (
    <Box sx={{ display: 'flex', mb: 2, height: 'calc(100vh - 240px)', minHeight: 400, maxHeight: 800, gap: 0 }}>
      {/* Collapsed calendar tab */}
      {calCollapsed && (
        <Box
          onClick={() => calendarPanelRef.current?.expand()}
          sx={{
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            cursor: 'pointer',
            px: 0.75,
            py: 2,
            bgcolor: 'grey.100',
            borderRadius: '8px 0 0 8px',
            '&:hover': { bgcolor: 'primary.main', color: 'white', '& .MuiSvgIcon-root': { color: 'white' } },
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            userSelect: 'none',
            flexShrink: 0,
            transition: 'background-color 0.15s, color 0.15s',
          }}
        >
          <CalendarIcon sx={{ fontSize: 16, color: 'primary.main', transition: 'color 0.15s' }} />
          <Typography variant="caption" sx={{ fontWeight: 600, fontSize: '0.75rem' }}>Calendar</Typography>
        </Box>
      )}

      <Group
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        style={{ flex: 1 }}
      >
        <Panel
          id="calendar"
          panelRef={calendarPanelRef}
          defaultSize={60}
          minSize={30}
          collapsible
          collapsedSize={0}
          onResize={(size) => setCalCollapsed(size.asPercentage === 0)}
        >
          <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1.5, position: 'relative' }}>
              {/* Collapse button — pinned top-left, symmetric with Inbox top-right */}
              <IconButton
                size="small"
                onClick={() => calendarPanelRef.current?.collapse()}
                title="Collapse calendar"
                sx={{ position: 'absolute', top: 8, left: 8, zIndex: 2 }}
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
              {(calNeedsReauth || calErrorMsg) && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {calNeedsReauth ? (
                    <>
                      Calendar access expired. Please{' '}
                      <Button
                        size="small"
                        color="inherit"
                        sx={{ textDecoration: 'underline', p: 0, minWidth: 0 }}
                        onClick={() => logout().then(() => {})}
                      >
                        log out and sign in again
                      </Button>{' '}
                      to restore PBD calendar sync.
                    </>
                  ) : (
                    <>{calErrorMsg}</>
                  )}
                </Alert>
              )}
              <WeeklyCalendar
                events={calendarEvents}
                loading={calLoading}
                viewMode={prefs.calendarView}
                onViewModeChange={(v) => setPrefs((p) => ({ ...p, calendarView: v }))}
                weekOffset={prefs.weekOffset ?? 0}
                onWeekOffsetChange={(offset) => setPrefs((p) => ({ ...p, weekOffset: offset }))}
                onTaskClick={handleTaskClick}
                timeGridHeight={prefs.calendarTimeGridHeight ?? 520}
                onTimeGridHeightChange={(h) => setPrefs((p) => ({ ...p, calendarTimeGridHeight: h }))}
                showWeekends={prefs.showWeekends ?? true}
                onShowWeekendsChange={(show) => setPrefs((p) => ({ ...p, showWeekends: show }))}
                headerSlot={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CalendarIcon color="primary" sx={{ fontSize: 20 }} />
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, fontSize: '1.1rem', whiteSpace: 'nowrap' }}>Calendar</Typography>
                    {gcalCount > 0 && <Chip label={`${gcalCount} events`} size="small" />}
                    {taskCount > 0 && <Chip label={`${taskCount} tasks`} size="small" variant="outlined" />}
                  </Box>
                }
              />
            </CardContent>
          </Card>
        </Panel>
        <Separator style={{ width: 8, background: 'transparent', cursor: 'col-resize', position: 'relative' }}>
          <Box
            component="div"
            sx={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              width: 4,
              height: 40,
              borderRadius: 2,
              bgcolor: 'divider',
              '&:hover': { bgcolor: 'primary.main', opacity: 0.5 },
            }}
          />
        </Separator>
        <Panel
          id="inbox"
          panelRef={inboxPanelRef}
          defaultSize={40}
          minSize={25}
          collapsible
          collapsedSize={0}
          onResize={(size) => setInboxCollapsed(size.asPercentage === 0)}
        >
          <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
            <CardContent sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, pt: 1.5, position: 'relative' }}>
              {/* Collapse button — pinned top-right so filters wrap before intersecting */}
              <IconButton
                size="small"
                onClick={() => inboxPanelRef.current?.collapse()}
                title="Collapse inbox"
                sx={{ position: 'absolute', top: 8, right: 8, zIndex: 2 }}
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
              <TaskInbox
                tasks={inboxTasks}
                loading={tasksLoading}
                maxHeight={prefs.taskInboxMaxHeight ?? 400}
                currentUserId={currentUserId}
                users={sfUsers}
                onToggleUrgent={onToggleUrgent}
                onEditTask={(task) => {
                  const opp = task.WhatId ? allOpportunities.find((o: any) => o.Id === task.WhatId) : null;
                  const mapped: Opportunity | null = opp ? {
                    Id: opp.Id, Name: opp.Name, AccountId: opp.Account?.Id || '',
                    Account: opp.Account ? { Name: opp.Account.Name } : undefined,
                    StageName: opp.StageName, Amount: opp.Amount, Probability: opp.Probability,
                    CloseDate: opp.CloseDate, CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
                    LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(), OwnerId: opp.OwnerId || '',
                  } : null;
                  setTaskPanelOpp(mapped);
                  setOrphanTask(!opp ? task : null);
                  setSelectedTaskId(task.Id);
                  setEditOnOpen(true);
                  setTaskPanelOpen(true);
                }}
                onHeightChange={(h) => setPrefs((p) => ({ ...p, taskInboxMaxHeight: Math.min(600, Math.max(200, h)) }))}
                headerSlot={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <InboxIcon color="primary" sx={{ fontSize: 20 }} />
                    <Typography variant="subtitle1" sx={{ fontWeight: 600, fontSize: '1.1rem', whiteSpace: 'nowrap' }}>Tasks</Typography>
                  </Box>
                }
              />
            </CardContent>
          </Card>
        </Panel>
      </Group>

      {/* Collapsed inbox tab */}
      {inboxCollapsed && (
        <Box
          onClick={() => inboxPanelRef.current?.expand()}
          sx={{
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            cursor: 'pointer',
            px: 0.75,
            py: 2,
            bgcolor: 'grey.100',
            borderRadius: '0 8px 8px 0',
            '&:hover': { bgcolor: 'primary.main', color: 'white', '& .MuiSvgIcon-root': { color: 'white' } },
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            userSelect: 'none',
            flexShrink: 0,
            transition: 'background-color 0.15s, color 0.15s',
          }}
        >
          <InboxIcon sx={{ fontSize: 16, color: 'primary.main', transition: 'color 0.15s' }} />
          <Typography variant="caption" sx={{ fontWeight: 600, fontSize: '0.75rem' }}>Inbox</Typography>
        </Box>
      )}
    </Box>
  );
}

const PBD_CALENDAR_ID_FALLBACK = 'c_f06065f4e4551cee88f8d465a6a77a24c8333c66a0077770a3e60b8d26251e98@group.calendar.google.com';

// ── Mock data for layout testing (DEV only — not used in production paths) ──
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MOCK_PRIORITY_OPPS: PriorityOpp[] = [
  {
    Id: 'mock-001', Name: 'Goldman Sachs Foundation — AIJI Year 3', StageName: 'Proposal Negotiation',
    Amount: 2500000, CloseDate: '2026-03-20', Probability: 75, OwnerId: 'u1',
    Account: { Name: 'Goldman Sachs Foundation', Id: 'a1' }, LastModifiedDate: '2026-03-14',
    tasks: [
      { Id: 't1', Subject: 'Send revised budget', ActivityDate: '2026-03-15', Priority: 'High', Status: 'Not Started', OwnerId: 'u1', OwnerName: 'Jane Park', Description: 'Include updated indirect cost rate per finance team email from 3/12' },
      { Id: 't2', Subject: 'Follow up with program officer', ActivityDate: '2026-03-18', Priority: 'Normal', Status: 'Not Started', OwnerId: 'u2', OwnerName: 'Marcus Chen', Description: '' },
    ],
  },
  {
    Id: 'mock-002', Name: 'JPMorgan Chase — Workforce Dev Grant', StageName: 'Design / Proposal Creation',
    Amount: 1800000, CloseDate: '2026-04-15', Probability: 60, OwnerId: 'u1',
    Account: { Name: 'JPMorgan Chase Foundation', Id: 'a2' }, LastModifiedDate: '2026-03-10',
    tasks: [
      { Id: 't3', Subject: 'Draft LOI', ActivityDate: '2026-03-12', Priority: 'High', Status: 'Not Started', OwnerId: 'u1', OwnerName: 'Jane Park' },
    ],
  },
  {
    Id: 'mock-003', Name: 'Robin Hood Foundation — General Operating', StageName: 'Qualifying',
    Amount: 750000, CloseDate: '2026-05-01', Probability: 40, OwnerId: 'u1',
    Account: { Name: 'Robin Hood Foundation', Id: 'a3' }, LastModifiedDate: '2026-02-01',
    tasks: [],
  },
  {
    Id: 'mock-004', Name: 'Google.org — AI Skills Accelerator', StageName: 'Proposal Negotiation',
    Amount: 3200000, CloseDate: '2026-03-28', Probability: 80, OwnerId: 'u1',
    Account: { Name: 'Google.org', Id: 'a4' }, LastModifiedDate: '2026-03-16',
    tasks: [
      { Id: 't4', Subject: 'Finalize MOU', ActivityDate: '2026-03-22', Priority: 'High', Status: 'Not Started', OwnerId: 'u1', OwnerName: 'Jane Park', Description: 'Legal reviewed — waiting on Google.org redline. Check Slack #google-partnership for latest' },
      { Id: 't5', Subject: 'Board approval package', ActivityDate: '2026-03-25', Priority: 'Normal', Status: 'Not Started', OwnerId: 'u2', OwnerName: 'Marcus Chen', Description: 'Need: exec summary, budget, MOU draft, board resolution template' },
      { Id: 't6', Subject: 'Schedule site visit', ActivityDate: '2026-03-10', Priority: 'Normal', Status: 'Completed', OwnerId: 'u1', OwnerName: 'Jane Park', Description: 'Completed — visit confirmed for 3/28 at LIC campus' },
    ],
    nextEvent: { summary: 'Google.org — Final Review Call', start: '2026-03-18' },
  },
  {
    Id: 'mock-005', Name: 'Salesforce Foundation — PBC Renewal', StageName: 'Contract Creation',
    Amount: 500000, CloseDate: '2026-03-17', Probability: 90, OwnerId: 'u1',
    Account: { Name: 'Salesforce Foundation', Id: 'a5' }, LastModifiedDate: '2026-03-16',
    tasks: [
      { Id: 't7', Subject: 'Countersign agreement', ActivityDate: '2026-03-17', Priority: 'High', Status: 'Not Started', OwnerId: 'u1', OwnerName: 'Jane Park' },
    ],
  },
  {
    Id: 'mock-006', Name: 'Bloomberg Philanthropies — Career Pathways', StageName: 'New Lead',
    Amount: 1200000, CloseDate: '2026-06-30', Probability: 25, OwnerId: 'u1',
    Account: { Name: 'Bloomberg Philanthropies', Id: 'a6' }, LastModifiedDate: '2026-01-15',
    tasks: [],
  },
  {
    Id: 'mock-007', Name: 'Bank of America — Community Grant', StageName: 'Qualifying',
    Amount: 350000, CloseDate: '2026-04-01', Probability: 35, OwnerId: 'u1',
    Account: { Name: 'Bank of America Charitable Foundation', Id: 'a7' }, LastModifiedDate: '2026-03-05',
    tasks: [
      { Id: 't8', Subject: 'Submit capacity statement', ActivityDate: '2026-03-08', Priority: 'Normal', Status: 'Not Started', OwnerId: 'u2', OwnerName: 'Marcus Chen' },
    ],
  },
  {
    Id: 'mock-008', Name: 'Citi Foundation — Digital Skills 2026', StageName: 'Design / Proposal Creation',
    Amount: 900000, CloseDate: '2026-05-15', Probability: 50, OwnerId: 'u1',
    Account: { Name: 'Citi Foundation', Id: 'a8' }, LastModifiedDate: '2026-03-13',
    tasks: [
      { Id: 't9', Subject: 'Complete evaluation framework', ActivityDate: '2026-03-20', Priority: 'Normal', Status: 'Not Started', OwnerId: 'u1', OwnerName: 'Jane Park' },
    ],
  },
];

const Priorities: React.FC = () => {
  const navigate = useNavigate();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const { user, logout } = useAuth();
  const currentFiscalYear = useMemo(() => new Date().getFullYear(), []);
  const { goals: ownerGoals } = useOwnerGoals(currentFiscalYear);
  const [prefs, setPrefs] = useState<DashboardPrefs>(loadPrefs);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [editOpp, setEditOpp] = useState<any>(null);
  const [taskPanelOpp, setTaskPanelOpp] = useState<Opportunity | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [editOnOpen, setEditOnOpen] = useState(false);
  const [orphanTask, setOrphanTask] = useState<any>(null);
  const [filteredOpps, setFilteredOpps] = useState<{ allFiltered: PriorityOpp[]; visible: PriorityOpp[] }>({ allFiltered: [], visible: [] });
  const [rowsInput, setRowsInput] = useState(String(prefs.topN));

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);
  useEffect(() => setRowsInput(String(prefs.topN)), [prefs.topN]);

  const toggleSection = (id: string) =>
    setPrefs((p) => ({ ...p, collapsed: { ...p.collapsed, [id]: !p.collapsed[id] } }));
  const updatePrefs = (patch: Partial<DashboardPrefs>) =>
    setPrefs((p) => ({ ...p, ...patch }));
  const setCalendarView = (view: CalendarViewMode) =>
    setPrefs((p) => ({ ...p, calendarView: view }));
  const handleFilteredChange = useCallback((allFiltered: PriorityOpp[], visible: PriorityOpp[]) => {
    setFilteredOpps({ allFiltered, visible });
  }, []);

  // Urgent overrides — persisted in localStorage
  const URGENT_KEY = 'pursuit-urgent-overrides';
  const [urgentOverrides, setUrgentOverrides] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(URGENT_KEY) || '{}'); } catch { return {}; }
  });
  const handleToggleUrgent = useCallback((taskId: string, urgent: boolean) => {
    setUrgentOverrides(prev => {
      const next = { ...prev, [taskId]: urgent };
      localStorage.setItem(URGENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Compute date range for calendar
  const { calStart, calEnd, calDaysForward } = useMemo(() => {
    const today = new Date();
    const offset = prefs.weekOffset || 0;
    const weekStart = startOfWeek(addDays(today, offset * 7), { weekStartsOn: 1 });
    const start = prefs.calendarView === 'day' ? today : weekStart;
    const daysForward = prefs.calendarView === 'day' ? 1 : prefs.calendarView === 'week' ? 7 : 14;
    const end = addDays(start, daysForward);
    return {
      calStart: format(start, 'yyyy-MM-dd'),
      calEnd: format(end, 'yyyy-MM-dd'),
      calDaysForward: daysForward,
    };
  }, [prefs.calendarView, prefs.weekOffset]);

  // Wider task date range for priorities (90 days back, 180 days forward)
  const { taskStart, taskEnd } = useMemo(() => {
    const today = startOfDay(new Date());
    return {
      taskStart: format(subDays(today, 90), 'yyyy-MM-dd'),
      taskEnd: format(addDays(today, 180), 'yyyy-MM-dd'),
    };
  }, []);

  // Fetch SF users for the filter dropdown
  const { data: usersData } = useQuery('sf-users', async () => {
    const response = await apiService.getUsers();
    return response.data?.data || response.data?.users || response.data || [];
  }, { staleTime: 15 * 60 * 1000 });

  // Fetch opportunities
  const { data: oppsData, isLoading: oppsLoading } = useQuery('opportunities', async () => {
    const response = await apiService.getOpportunities();
    return response.data;
  }, { staleTime: 5 * 60 * 1000 });

  // Fetch my tasks (wider range for priorities; calendar filters by visible dates)
  const { data: tasksData, isLoading: tasksLoading } = useQuery(
    ['my-tasks', taskStart, taskEnd],
    async () => {
      const response = await apiService.getMyTasks(taskStart, taskEnd);
      return response.data?.data || response.data || [];
    },
    { staleTime: 5 * 60 * 1000 }
  );

  // Use PBD calendar ID from backend config, falling back to hardcoded value
  const pbdCalendarId = user?.calendar_pbd_id || PBD_CALENDAR_ID_FALLBACK;

  // Fetch PBD shared calendar events
  const { data: calResponse, isLoading: calLoading, isError: calIsError } = useQuery(
    ['pbd-calendar-events', calStart, calEnd, pbdCalendarId],
    async () => {
      const response = await apiService.getMyCalendarEvents(calStart, calEnd, 100, pbdCalendarId);
      return response.data;
    },
    { staleTime: 5 * 60 * 1000 }
  );
  const calEventsData = Array.isArray(calResponse?.data) ? calResponse.data : [];
  const calNeedsReauth = calResponse?.needs_reauth === true;
  const calErrorMsg: string | undefined = calNeedsReauth
    ? undefined
    : calIsError
      ? 'Network error — please try again.'
      : calResponse?.error
        ? String(calResponse.error)
        : undefined;

  const allOpportunities = useMemo(() => {
    const raw = Array.isArray(oppsData)
      ? oppsData
      : (oppsData?.opportunities || oppsData?.data || []);
    return raw as any[];
  }, [oppsData]);

  // Build user list for filter dropdown — merge SF users + opp owners, track IsActive
  const sfUsers = useMemo(() => {
    const userMap = new Map<string, { Id: string; Name: string; IsActive: boolean }>();
    // From users API
    const rawUsers = Array.isArray(usersData) ? usersData : [];
    for (const u of rawUsers) {
      if (u.Id && u.Name) userMap.set(u.Id, { Id: u.Id, Name: u.Name, IsActive: u.IsActive !== false });
    }
    // From opportunity owners (catches inactive/historical users not in user list)
    for (const opp of allOpportunities) {
      if (opp.OwnerId && !userMap.has(opp.OwnerId)) {
        userMap.set(opp.OwnerId, { Id: opp.OwnerId, Name: opp.Owner?.Name || opp.OwnerId, IsActive: false });
      }
    }
    return Array.from(userMap.values())
      .sort((a, b) => {
        const aActive = a.IsActive ? 0 : 1;
        const bActive = b.IsActive ? 0 : 1;
        return aActive !== bActive ? aActive - bActive : a.Name.localeCompare(b.Name);
      });
  }, [usersData, allOpportunities]);

  // Precompute open opp counts per user for dropdown labels
  const allOpenOpps = useMemo(
    () => allOpportunities.filter((opp: any) => OPEN_STAGES.includes(opp.StageName)),
    [allOpportunities]
  );
  const openCountByUser = useMemo(() => {
    const counts = new Map<string, number>();
    for (const opp of allOpenOpps) {
      counts.set(opp.OwnerId, (counts.get(opp.OwnerId) || 0) + 1);
    }
    return counts;
  }, [allOpenOpps]);

  // Filtered opportunities — by selected user or all
  const sfUserId = user?.salesforce_user_id;
  const resolvedFilterId = prefs.filterUserId === 'me' ? (sfUserId || 'all') : (prefs.filterUserId || 'all');
  const filteredOpportunities = useMemo(() => {
    if (resolvedFilterId === 'all') return allOpportunities;
    return allOpportunities.filter((opp: any) => opp.OwnerId === resolvedFilterId);
  }, [allOpportunities, resolvedFilterId]);

  const myOpenOpps = useMemo(() => {
    let opps = filteredOpportunities.filter((opp: any) => OPEN_STAGES.includes(opp.StageName));

    const dr = prefs.dateRange;
    if (dr.preset !== 'all') {
      const now = new Date();
      const today = startOfDay(now);
      let rangeStart: Date | null = null;
      let rangeEnd: Date | null = null;

      if (dr.preset === 'custom') {
        rangeStart = parseISO(dr.start);
        rangeEnd = parseISO(dr.end);
      } else {
        switch (dr.preset) {
          case 'next30': rangeEnd = addDays(today, 30); break;
          case 'next60': rangeEnd = addDays(today, 60); break;
          case 'next90': rangeEnd = addDays(today, 90); break;
          case 'thisQuarter': {
            const qMonth = Math.floor(now.getMonth() / 3) * 3 + 3;
            rangeEnd = new Date(now.getFullYear(), qMonth, 0);
            break;
          }
          case 'currentFY':
            rangeStart = new Date(now.getFullYear(), 0, 1);
            rangeEnd = new Date(now.getFullYear(), 11, 31);
            break;
        }
      }

      opps = opps.filter((opp: any) => {
        if (!opp.CloseDate) return false;
        const d = parseISO(opp.CloseDate);
        if (rangeStart && d < startOfDay(rangeStart)) return false;
        if (rangeEnd && d > endOfDay(rangeEnd)) return false;
        return true;
      });
    }

    return opps;
  }, [filteredOpportunities, prefs.dateRange]);

  // Map tasks to their parent opportunities
  const sfTasks = useMemo(() => (Array.isArray(tasksData) ? tasksData : []), [tasksData]);

  // Build opp name lookup for calendar tasks
  const oppNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const opp of allOpportunities) {
      m.set(opp.Id, opp.Name);
    }
    return m;
  }, [allOpportunities]);

  // Build calendar events from GCal + SF Tasks
  const calendarEvents: CalendarEvent[] = useMemo(() => {
    const events: CalendarEvent[] = [];

    // GCal events
    const gcalEvents = calEventsData;
    for (const ev of gcalEvents) {
      events.push({
        id: ev.id || `gcal-${events.length}`,
        summary: ev.summary || 'Untitled',
        start: ev.start || '',
        end: ev.end || '',
        attendees: ev.attendees || [],
        location: ev.location || '',
        description: ev.description || '',
        htmlLink: ev.htmlLink || undefined,
        type: 'gcal',
      });
    }

    // SF Tasks — only tasks due within the visible calendar date range
    for (const task of sfTasks) {
      if (!task.ActivityDate) continue;
      if (task.ActivityDate < calStart || task.ActivityDate > calEnd) continue;
      if (task.Status === 'Completed') continue;
      events.push({
        id: task.Id || `task-${events.length}`,
        summary: task.Subject || 'Untitled Task',
        start: task.ActivityDate,
        type: 'task',
        priority: task.Priority,
        status: task.Status,
        description: task.Description || '',
        opportunityName: task.WhatId ? oppNameMap.get(task.WhatId) || undefined : undefined,
        whatId: task.WhatId || undefined,
      });
    }

    return events;
  }, [calEventsData, sfTasks, oppNameMap, calStart, calEnd]);

  const gcalCount = useMemo(() => calendarEvents.filter(e => e.type === 'gcal').length, [calendarEvents]);
  const taskCount = useMemo(() => calendarEvents.filter(e => e.type === 'task').length, [calendarEvents]);

  // Build priority opportunities with tasks attached
  const priorityOpps: PriorityOpp[] = useMemo(() => {
    if (myOpenOpps.length === 0) return [];

    // Group tasks by WhatId (opportunity ID)
    const tasksByOppId = new Map<string, any[]>();
    for (const task of sfTasks) {
      if (!task.WhatId) continue;
      if (!tasksByOppId.has(task.WhatId)) tasksByOppId.set(task.WhatId, []);
      tasksByOppId.get(task.WhatId)!.push(task);
    }

    return myOpenOpps.map((opp: any) => ({
      Id: opp.Id,
      Name: opp.Name,
      StageName: opp.StageName,
      Amount: opp.Amount || 0,
      CloseDate: opp.CloseDate || '',
      Probability: opp.Probability || 0,
      OwnerId: opp.OwnerId,
      Type: opp.Type || '',
      RenewalRepeat: opp.RenewalRepeat__c || opp.RenewalRepeat || '',
      Account: opp.Account,
      LastModifiedDate: opp.LastModifiedDate,
      LastActivityDate: opp.LastActivityDate || null,
      CampaignId: opp.CampaignId || null,
      CampaignName: opp.Campaign?.Name || null,
      tasks: (tasksByOppId.get(opp.Id) || []).map((t: any) => ({
        Id: t.Id,
        Subject: t.Subject,
        ActivityDate: t.ActivityDate || '',
        Priority: t.Priority || 'Normal',
        Status: t.Status || 'Not Started',
        OwnerId: t.OwnerId,
        OwnerName: t.Owner?.Name || t.OwnerName || '',
        Description: t.Description || '',
        WhoId: t.WhoId || '',
        WhoName: t.Who?.Name || t.WhoName || '',
      })),
    }));
  }, [myOpenOpps, sfTasks]);

  // Build inbox tasks with opportunity names
  const inboxTasks: InboxTask[] = useMemo(() => {
    const oppNameMap = new Map<string, string>();
    for (const opp of allOpportunities) {
      oppNameMap.set(opp.Id, opp.Name);
    }
    return sfTasks.map((t: any) => ({
      Id: t.Id,
      Subject: t.Subject || 'Untitled Task',
      Status: t.Status || 'Not Started',
      Priority: t.Priority || 'Normal',
      ActivityDate: t.ActivityDate || null,
      Description: t.Description || null,
      OwnerId: t.OwnerId || '',
      OwnerName: t.Owner?.Name || t.OwnerName || null,
      CreatedById: t.CreatedById || null,
      CreatedByName: t.CreatedBy?.Name || null,
      WhatId: t.WhatId || null,
      OpportunityName: t.WhatId ? oppNameMap.get(t.WhatId) || null : null,
      WhoId: t.WhoId || null,
      WhoName: t.Who?.Name || t.WhoName || null,
      isUrgent: Object.hasOwn(urgentOverrides, t.Id) ? urgentOverrides[t.Id] : t.Priority === 'High',
    }));
  }, [sfTasks, allOpportunities, urgentOverrides]);

  // Pipeline summary stats — scoped by snapshot mode
  // For 'priorities': use allFiltered (all that meet filters) so Total/Weighted toggle reflects full set
  const pipelineStats = useMemo(() => {
    let statsOpps: any[];
    switch (prefs.snapshotMode) {
      case 'filtered': statsOpps = filteredOpps.allFiltered; break;
      case 'priorities': statsOpps = filteredOpps.visible; break;
      default: statsOpps = myOpenOpps;
    }
    const count = statsOpps.length;
    const total = statsOpps.reduce((sum: number, opp: any) => sum + (opp.Amount || 0), 0);
    const weighted = statsOpps.reduce(
      (sum: number, opp: any) => sum + ((opp.Amount || 0) * (opp.Probability || 0)) / 100,
      0
    );
    const now = new Date();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const closingThisMonth = statsOpps.filter((opp: any) => {
      if (!opp.CloseDate) return false;
      const d = parseISO(opp.CloseDate);
      return d >= startOfDay(now) && d <= endOfDay(monthEnd);
    });
    const closingAmount = closingThisMonth.reduce((s: number, o: any) => s + ((o.Amount || 0) * (o.Probability || 0)) / 100, 0);
    const closingOpps = closingThisMonth.map((o: any) => ({
      Name: o.Name as string,
      Amount: (o.Amount || 0) as number,
      Probability: (o.Probability || 0) as number,
    }));
    return { count, total, weighted, closingThisMonth: closingThisMonth.length, closingAmount, closingOpps };
  }, [myOpenOpps, prefs.snapshotMode, filteredOpps]);

  const snapshotDescription = useMemo(() => {
    const parts: string[] = [];
    switch (prefs.snapshotMode) {
      case 'all': parts.push(`All open pipeline (${myOpenOpps.length} opps)`); break;
      case 'filtered': parts.push(`All filtered (${filteredOpps.allFiltered.length} opps)`); break;
      case 'priorities': parts.push(`Top ${Math.min(prefs.topN, filteredOpps.visible.length)} priorities`); break;
    }
    if (resolvedFilterId !== 'all') {
      const userName = sfUsers.find((u: any) => u.Id === resolvedFilterId)?.Name;
      if (userName) parts.push(userName);
    }
    const dr = prefs.dateRange;
    if (dr.preset !== 'all') {
      if (dr.preset === 'custom') {
        try {
          parts.push(`${format(parseISO(dr.start), 'MMM d')} – ${format(parseISO(dr.end), 'MMM d')}`);
        } catch {}
      } else {
        const labels: Record<string, string> = {
          currentFY: 'Current FY', next30: 'Next 30 days', next60: 'Next 60 days',
          next90: 'Next 90 days', thisQuarter: 'This Quarter',
        };
        parts.push(labels[dr.preset] || '');
      }
    }
    return parts.join(' \u00b7 ');
  }, [prefs.snapshotMode, prefs.topN, prefs.dateRange, resolvedFilterId, sfUsers, myOpenOpps, filteredOpps]);

  // Navigate to Pipeline with pre-applied filters from hero card click
  const navigateToPipeline = useCallback((card: 'total' | 'weighted' | 'closing') => {
    const owners = resolvedFilterId !== 'all' ? [resolvedFilterId] : [];
    let closeDateStart = '';
    let closeDateEnd = '';

    const dr = prefs.dateRange;
    if (dr.preset === 'custom') {
      closeDateStart = dr.start;
      closeDateEnd = dr.end;
    } else if (dr.preset !== 'all') {
      const now = new Date();
      const today = startOfDay(now);
      switch (dr.preset) {
        case 'next30': closeDateEnd = format(addDays(today, 30), 'yyyy-MM-dd'); break;
        case 'next60': closeDateEnd = format(addDays(today, 60), 'yyyy-MM-dd'); break;
        case 'next90': closeDateEnd = format(addDays(today, 90), 'yyyy-MM-dd'); break;
        case 'thisQuarter': {
          const qMonth = Math.floor(now.getMonth() / 3) * 3 + 3;
          closeDateEnd = format(new Date(now.getFullYear(), qMonth, 0), 'yyyy-MM-dd');
          break;
        }
        case 'currentFY':
          closeDateStart = format(new Date(now.getFullYear(), 0, 1), 'yyyy-MM-dd');
          closeDateEnd = format(new Date(now.getFullYear(), 11, 31), 'yyyy-MM-dd');
          break;
      }
    }

    if (card === 'closing') {
      const now = new Date();
      closeDateStart = format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd');
      closeDateEnd = format(new Date(now.getFullYear(), now.getMonth() + 1, 0), 'yyyy-MM-dd');
    }

    const cardLabels = { total: 'Total Pipeline', weighted: 'Weighted Pipeline', closing: 'Weighted Closing This Month' };
    let source = cardLabels[card];
    if (resolvedFilterId !== 'all') {
      const name = sfUsers.find(u => u.Id === resolvedFilterId)?.Name;
      if (name) source += ` — ${name}`;
    }
    if (card === 'closing') {
      source += `, ${format(new Date(), 'MMMM yyyy')}`;
    }

    navigate('/reports', {
      state: { dashboardFilters: { owners, closeDateStart, closeDateEnd, source } },
    });
  }, [prefs.dateRange, resolvedFilterId, sfUsers, navigate]);

  if (oppsLoading) {
    return (
      <Box sx={{ width: '100%', mt: 4 }}>
        <LinearProgress />
        <Typography align="center" sx={{ mt: 2 }}>Loading your priorities...</Typography>
      </Box>
    );
  }

  return (
    <Box>

      {/* Section header: On the docket */}
      <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: '0.75rem', mb: 1 }}>
        On the docket
      </Typography>

      {/* Row 1: Calendar + Task Inbox side-by-side (resizable on desktop) */}
      {prefs.collapsed['inbox'] ? (
        <Box sx={{ mb: 2 }}>
          <Section
            id="calendar"
            title="Weekly Calendar"
            icon={<CalendarIcon color="primary" />}
            collapsed={!!prefs.collapsed['calendar']}
            onToggle={() => toggleSection('calendar')}
            badge={
              (gcalCount > 0 || taskCount > 0) ? (
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                  {gcalCount > 0 && <Chip label={`${gcalCount} events`} size="small" />}
                  {taskCount > 0 && <Chip label={`${taskCount} tasks`} size="small" variant="outlined" />}
                </Box>
              ) : undefined
            }
          >
            {(calNeedsReauth || calErrorMsg) && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                {calNeedsReauth ? (
                  <>
                    Calendar access expired. Please{' '}
                    <Button
                      size="small"
                      color="inherit"
                      sx={{ textDecoration: 'underline', p: 0, minWidth: 0 }}
                      onClick={() => logout().then(() => {})}
                    >
                      log out and sign in again
                    </Button>{' '}
                    to restore PBD calendar sync.
                  </>
                ) : (
                  <>{calErrorMsg}</>
                )}
              </Alert>
            )}
            <WeeklyCalendar
              events={calendarEvents}
              loading={calLoading}
              viewMode={prefs.calendarView}
              onViewModeChange={setCalendarView}
              weekOffset={prefs.weekOffset ?? 0}
              onWeekOffsetChange={(offset) => setPrefs((p) => ({ ...p, weekOffset: offset }))}
              showWeekends={prefs.showWeekends ?? true}
              onShowWeekendsChange={(show) => setPrefs((p) => ({ ...p, showWeekends: show }))}
              onTaskClick={(taskId, whatId) => {
                const opp = priorityOpps.find((o) => o.Id === whatId) || allOpportunities.find((o: any) => o.Id === whatId);
                if (opp) {
                  const mapped: Opportunity = {
                    Id: opp.Id,
                    Name: opp.Name,
                    AccountId: (opp as any).Account?.Id || '',
                    Account: (opp as any).Account ? { Name: (opp as any).Account.Name } : undefined,
                    StageName: opp.StageName,
                    Amount: opp.Amount,
                    Probability: opp.Probability,
                    CloseDate: opp.CloseDate,
                    CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
                    LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(),
                    OwnerId: opp.OwnerId || '',
                  };
                  setTaskPanelOpp(mapped);
                  setTaskPanelOpen(true);
                  setSelectedTaskId(taskId);
                }
              }}
            />
          </Section>
          <Section
            id="inbox"
            title="Task Inbox"
            icon={<InboxIcon color="primary" />}
            collapsed={true}
            onToggle={() => toggleSection('inbox')}
          >
            <div />
          </Section>
        </Box>
      ) : isDesktop ? (
        <CalendarInboxSplit
          calNeedsReauth={calNeedsReauth}
          calErrorMsg={calErrorMsg}
          logout={logout}
          calendarEvents={calendarEvents}
          calLoading={calLoading}
          prefs={prefs}
          toggleSection={toggleSection}
          setPrefs={setPrefs}
          priorityOpps={priorityOpps}
          allOpportunities={allOpportunities}
          setTaskPanelOpp={setTaskPanelOpp}
          setTaskPanelOpen={setTaskPanelOpen}
          inboxTasks={inboxTasks}
          tasksLoading={tasksLoading}
          currentUserId={user?.salesforce_user_id}
          onToggleUrgent={handleToggleUrgent}
          gcalCount={gcalCount}
          taskCount={taskCount}
          setSelectedTaskId={setSelectedTaskId}
          setEditOnOpen={setEditOnOpen}
          setOrphanTask={setOrphanTask}
          sfUsers={sfUsers}
        />
      ) : (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={12}>
            <Section
              id="calendar"
              title="Weekly Calendar"
              icon={<CalendarIcon color="primary" />}
              collapsed={!!prefs.collapsed['calendar']}
              onToggle={() => toggleSection('calendar')}
              badge={
                (gcalCount > 0 || taskCount > 0) ? (
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    {gcalCount > 0 && <Chip label={`${gcalCount} events this ${prefs.calendarView === 'day' ? 'day' : 'week'}`} size="small" />}
                    {taskCount > 0 && <Chip label={`${taskCount} tasks due this ${prefs.calendarView === 'day' ? 'day' : 'week'}`} size="small" variant="outlined" />}
                  </Box>
                ) : undefined
              }
            >
              {(calNeedsReauth || calErrorMsg) && (
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {calNeedsReauth ? (
                    <>
                      Calendar access expired. Please{' '}
                      <Button
                        size="small"
                        color="inherit"
                        sx={{ textDecoration: 'underline', p: 0, minWidth: 0 }}
                        onClick={() => logout().then(() => {})}
                      >
                        log out and sign in again
                      </Button>{' '}
                      to restore PBD calendar sync.
                    </>
                  ) : (
                    <>{calErrorMsg}</>
                  )}
                </Alert>
              )}
              <WeeklyCalendar
                events={calendarEvents}
                loading={calLoading}
                viewMode={prefs.calendarView}
                onViewModeChange={setCalendarView}
                weekOffset={prefs.weekOffset ?? 0}
                onWeekOffsetChange={(offset) => setPrefs((p) => ({ ...p, weekOffset: offset }))}
                showWeekends={prefs.showWeekends ?? true}
                onShowWeekendsChange={(show) => setPrefs((p) => ({ ...p, showWeekends: show }))}
                onTaskClick={(taskId, whatId) => {
                  const opp = priorityOpps.find((o) => o.Id === whatId) || allOpportunities.find((o: any) => o.Id === whatId);
                  if (opp) {
                    const mapped: Opportunity = {
                      Id: opp.Id,
                      Name: opp.Name,
                      AccountId: (opp as any).Account?.Id || '',
                      Account: (opp as any).Account ? { Name: (opp as any).Account.Name } : undefined,
                      StageName: opp.StageName,
                      Amount: opp.Amount,
                      Probability: opp.Probability,
                      CloseDate: opp.CloseDate,
                      CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
                      LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(),
                      OwnerId: opp.OwnerId || '',
                    };
                    setTaskPanelOpp(mapped);
                    setTaskPanelOpen(true);
                    setSelectedTaskId(taskId);
                  }
                }}
              />
            </Section>
          </Grid>
          <Grid item xs={12}>
            <Section
              id="inbox"
              title="Task Inbox"
              icon={<InboxIcon color="primary" />}
              collapsed={!!prefs.collapsed['inbox']}
              onToggle={() => toggleSection('inbox')}
              badge={
                inboxTasks.filter((t) => t.Status !== 'Completed').length > 0 ? (
                  <Chip label={`${inboxTasks.filter((t) => t.Status !== 'Completed').length} open`} size="small" />
                ) : undefined
              }
            >
              <TaskInbox
                tasks={inboxTasks}
                loading={tasksLoading}
                maxHeight={prefs.taskInboxMaxHeight ?? 400}
                currentUserId={user?.salesforce_user_id}
                users={sfUsers}
                onToggleUrgent={handleToggleUrgent}
                onEditTask={(task) => {
                  const opp = task.WhatId ? allOpportunities.find((o: any) => o.Id === task.WhatId) : null;
                  const mapped: Opportunity | null = opp ? {
                    Id: opp.Id, Name: opp.Name, AccountId: opp.Account?.Id || '',
                    Account: opp.Account ? { Name: opp.Account.Name } : undefined,
                    StageName: opp.StageName, Amount: opp.Amount, Probability: opp.Probability,
                    CloseDate: opp.CloseDate, CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
                    LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(), OwnerId: opp.OwnerId || '',
                  } : null;
                  setTaskPanelOpp(mapped);
                  setOrphanTask(!opp ? task : null);
                  setSelectedTaskId(task.Id);
                  setEditOnOpen(true);
                  setTaskPanelOpen(true);
                }}
                onHeightChange={(h) => setPrefs((p) => ({ ...p, taskInboxMaxHeight: Math.min(600, Math.max(200, h)) }))}
              />
            </Section>
          </Grid>
        </Grid>
      )}

      {/* Section header: Get Prioritized */}
      <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: '0.75rem', mt: 2, mb: 1 }}>
        Get Prioritized
      </Typography>

      {/* Row 2: Priority Opportunities */}
      <Section
        id="priorities"
        title="Priority Opportunities"
        icon={<PriorityIcon color="primary" />}
        collapsed={!!prefs.collapsed['priorities']}
        onToggle={() => toggleSection('priorities')}
        badge={
          myOpenOpps.length > 0 ? (
            <Tooltip title="Opportunities in open pipeline stages (Lead Gen through Negotiating Contract) — excludes Collecting/In Effect and closed stages">
              <Chip label={`${myOpenOpps.length} open`} size="small" />
            </Tooltip>
          ) : undefined
        }
      >
        {!user?.salesforce_connected && priorityOpps.length === 0 ? (
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
              Connect Salesforce to see your priority opportunities.
            </Typography>
            <Button
              variant="contained"
              size="small"
              onClick={() => navigate('/settings')}
            >
              Go to Settings
            </Button>
          </Box>
        ) : (
          <>
            <PriorityTable
              opportunities={priorityOpps}
              maxRows={prefs.topN}
              users={[]}
              toolbarSlot={
                <>
                  <FormControl size="small" sx={{ minWidth: 160, '& .MuiInputBase-root': { height: 32, fontSize: '0.75rem' }, '& .MuiInputLabel-root': { fontSize: '0.75rem' } }}>
                    <InputLabel id="opportunity-owner-filter-label">Opportunity Owner</InputLabel>
                    <Select
                      labelId="opportunity-owner-filter-label"
                      label="Opportunity Owner"
                      value={prefs.filterUserId}
                      onChange={(e) => setPrefs((p) => ({ ...p, filterUserId: e.target.value as string }))}
                    >
                      <MenuItem value="all">All Users ({allOpenOpps.length})</MenuItem>
                      {sfUserId && <MenuItem value="me">My Opportunities ({openCountByUser.get(sfUserId) || 0})</MenuItem>}
                      <ListSubheader sx={{ fontSize: '0.7rem', lineHeight: '24px', color: 'text.secondary', bgcolor: 'grey.50' }}>Active</ListSubheader>
                      {sfUsers.filter((u) => u.IsActive && (openCountByUser.get(u.Id) || 0) > 0).map((u) => (
                        <MenuItem key={u.Id} value={u.Id}>
                          {u.Name} ({openCountByUser.get(u.Id)})
                        </MenuItem>
                      ))}
                      {sfUsers.some((u) => !u.IsActive && (openCountByUser.get(u.Id) || 0) > 0) && (
                        <ListSubheader sx={{ fontSize: '0.7rem', lineHeight: '24px', color: 'text.secondary', bgcolor: 'grey.50' }}>Inactive</ListSubheader>
                      )}
                      {sfUsers.filter((u) => !u.IsActive && (openCountByUser.get(u.Id) || 0) > 0).map((u) => (
                        <MenuItem key={u.Id} value={u.Id} sx={{ color: 'text.secondary' }}>
                          {u.Name} ({openCountByUser.get(u.Id)})
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <DateRangeSelector
                    value={prefs.dateRange}
                    onChange={(dateRange) => setPrefs((p) => ({ ...p, dateRange }))}
                  />
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={prefs.showWeighted ? 'weighted' : 'total'}
                    onChange={(_, v) => v && setPrefs((p) => ({ ...p, showWeighted: v === 'weighted' }))}
                    sx={{ '& .MuiToggleButton-root': { textTransform: 'none', px: 1, py: 0.25, fontSize: '0.75rem' } }}
                  >
                    <ToggleButton value="total">Total</ToggleButton>
                    <ToggleButton value="weighted">Weighted</ToggleButton>
                  </ToggleButtonGroup>
                  {prefs.showWeighted && (
                    <Typography variant="caption" color="text.secondary">
                      Amt × Prob
                    </Typography>
                  )}
                  <TextField
                    type="number"
                    size="small"
                    label="Rows"
                    value={rowsInput}
                    inputProps={{ min: 1, max: 50 }}
                    sx={{ width: 56, '& .MuiInputBase-root': { height: 32, fontSize: '0.75rem' }, '& .MuiInputLabel-root': { fontSize: '0.75rem' } }}
                    onChange={(e) => setRowsInput(e.target.value)}
                    onBlur={() => {
                      const v = Math.min(50, Math.max(1, parseInt(rowsInput, 10) || 20));
                      setRowsInput(String(v));
                      setPrefs((p) => ({ ...p, topN: v }));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                </>
              }
              showWeighted={prefs.showWeighted}
              onFilteredChange={handleFilteredChange}
              onAddTask={(opp) => {
                const mapped: Opportunity = {
                  Id: opp.Id,
                  Name: opp.Name,
                  AccountId: opp.Account?.Id || '',
                  Account: opp.Account ? { Name: opp.Account.Name } : undefined,
                  StageName: opp.StageName,
                  Amount: opp.Amount,
                  Probability: opp.Probability,
                  CloseDate: opp.CloseDate,
                  CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
                  LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(),
                  OwnerId: opp.OwnerId || '',
                };
                setTaskPanelOpp(mapped);
                setTaskPanelOpen(true);
              }}
              onOppClick={(priorityOpp) => {
                // Look up full Salesforce record — PriorityOpp drops many fields
                const fullOpp = allOpportunities.find((o: any) => o.Id === priorityOpp.Id);
                setEditOpp(fullOpp || priorityOpp);
              }}
              onOpenTaskDrawer={(opp, _taskId) => {
                const mapped: Opportunity = {
                  Id: opp.Id,
                  Name: opp.Name,
                  AccountId: opp.Account?.Id || '',
                  Account: opp.Account ? { Name: opp.Account.Name } : undefined,
                  StageName: opp.StageName,
                  Amount: opp.Amount,
                  Probability: opp.Probability,
                  CloseDate: opp.CloseDate,
                  CreatedDate: opp.LastModifiedDate || new Date().toISOString(),
                  LastModifiedDate: opp.LastModifiedDate || new Date().toISOString(),
                  OwnerId: opp.OwnerId || '',
                };
                setTaskPanelOpp(mapped);
                setTaskPanelOpen(true);
              }}
            />
          </>
        )}
      </Section>

      {/* Section 3: Revenue Snapshot */}
      <Section
        id="revenue"
        title="Revenue Snapshot"
        icon={<TrendingUpIcon color="primary" />}
        collapsed={!!prefs.collapsed['revenue']}
        onToggle={() => toggleSection('revenue')}
        badge={
          <ToggleButtonGroup
            size="small"
            exclusive
            value={prefs.snapshotMode}
            onChange={(e, v) => { e.stopPropagation(); v && setPrefs((p) => ({ ...p, snapshotMode: v })); }}
            sx={{ '& .MuiToggleButton-root': { textTransform: 'none', px: 1, py: 0.25, fontSize: '0.75rem' } }}
          >
            <ToggleButton value="all" onClick={(e) => e.stopPropagation()}>All Pipeline</ToggleButton>
            <ToggleButton value="filtered" onClick={(e) => e.stopPropagation()}>Filtered</ToggleButton>
            <ToggleButton value="priorities" onClick={(e) => e.stopPropagation()}>Top Priorities</ToggleButton>
          </ToggleButtonGroup>
        }
      >
        {snapshotDescription && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, px: 0.5 }}>
            {snapshotDescription}
          </Typography>
        )}
        <Grid container spacing={2}>
          <Grid item xs={12} md={5}>
            <GoalTracker
              goalAmount={ownerGoals[resolvedFilterId]?.goal_amount ?? DEFAULT_GOAL}
              allOpportunities={allOpportunities}
              filterUserId={resolvedFilterId}
              ownerName={
                resolvedFilterId !== 'all'
                  ? sfUsers.find((u) => u.Id === resolvedFilterId)?.Name || null
                  : null
              }
            />
          </Grid>
          <Grid item xs={12} md={7}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={4}>
                <Card
                  variant="outlined"
                  sx={{ cursor: 'pointer', '&:hover': { borderColor: 'primary.main' } }}
                  onClick={() => navigateToPipeline('total')}
                >
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <MoneyIcon color="primary" />
                    <Typography variant="caption" color="text.secondary" display="block">
                      Total Pipeline
                    </Typography>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                      {formatDollarMillions(pipelineStats.total)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {pipelineStats.count} open opportunities
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Card
                  variant="outlined"
                  sx={{ cursor: 'pointer', '&:hover': { borderColor: 'primary.main' } }}
                  onClick={() => navigateToPipeline('weighted')}
                >
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <WeightedIcon color="primary" />
                    <Typography variant="caption" color="text.secondary" display="block">
                      Weighted Pipeline
                    </Typography>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                      {formatDollarMillions(pipelineStats.weighted)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Probability-weighted
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Card
                  variant="outlined"
                  sx={{ cursor: 'pointer', '&:hover': { borderColor: 'primary.main' } }}
                  onClick={() => navigateToPipeline('closing')}
                >
                  <CardContent sx={{ py: 1.5, textAlign: 'center' }}>
                    <EventIcon color="primary" />
                    <Typography variant="caption" color="text.secondary" display="block">
                      Weighted Closing This Mo.
                    </Typography>
                    <Typography variant="h5" sx={{ fontWeight: 700 }}>
                      {formatDollarMillions(pipelineStats.closingAmount)}
                    </Typography>
                    <Tooltip
                      title={
                        pipelineStats.closingOpps.length > 0 ? (
                          <Box>
                            {pipelineStats.closingOpps.slice(0, 8).map((o, i) => (
                              <Typography key={i} variant="caption" display="block" sx={{ fontSize: '0.75rem' }}>
                                {o.Name} — ${(o.Amount || 0).toLocaleString()} ({o.Probability}%)
                              </Typography>
                            ))}
                            {pipelineStats.closingOpps.length > 8 && (
                              <Typography variant="caption" display="block" sx={{ fontSize: '0.75rem', fontStyle: 'italic' }}>
                                and {pipelineStats.closingOpps.length - 8} more…
                              </Typography>
                            )}
                          </Box>
                        ) : ''
                      }
                      arrow
                      placement="top"
                    >
                      <Typography variant="caption" color="text.secondary" sx={{ cursor: 'default' }}>
                        {pipelineStats.closingThisMonth} deal{pipelineStats.closingThisMonth !== 1 ? 's' : ''} &middot; probability-weighted
                      </Typography>
                    </Tooltip>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>
          </Grid>
        </Grid>
      </Section>

      {/* Task Panel drawer */}
      <TaskPanel
        open={taskPanelOpen}
        onClose={() => { setTaskPanelOpen(false); setTaskPanelOpp(null); setSelectedTaskId(null); setEditOnOpen(false); setOrphanTask(null); }}
        opportunity={taskPanelOpp}
        selectedTaskId={selectedTaskId}
        editOnOpen={editOnOpen}
        orphanTask={orphanTask}
        users={sfUsers}
        opportunities={allOpportunities.map((o: any) => ({ Id: o.Id, Name: o.Name }))}
      />

      {/* Opportunity Edit Dialog */}
      <OpportunityEditDialog
        open={!!editOpp}
        onClose={() => setEditOpp(null)}
        opportunityId={editOpp?.Id ?? null}
        initialData={editOpp}
        onSaved={() => setEditOpp(null)}
        onStageClosedCompleted={(opp) => {
          setEditOpp(null);
          navigate(`/payment-schedule/${opp.Id}`, {
            state: { fromStageChange: true, targetStage: 'Closed / Completed', opportunityId: opp.Id },
          });
        }}
      />
    </Box>
  );
};

export default Priorities;
