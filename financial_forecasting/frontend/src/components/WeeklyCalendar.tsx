import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  Box,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Chip,
  CircularProgress,
  Tooltip,
  Checkbox,
  FormControlLabel,
  Popover,
  IconButton,
  Button,
} from '@mui/material';
import {
  Assignment as TaskIcon,
  EventAvailable as CalendarCheckIcon,
  CheckCircle as CheckCircleIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import {
  format,
  startOfWeek,
  addDays,
  isSameDay,
  isBefore,
  parseISO,
  startOfDay,
  differenceInDays,
  isWeekend,
} from 'date-fns';

export type CalendarViewMode = 'day' | 'week' | '2week';

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end?: string;
  attendees?: Array<{ name?: string; email?: string }>;
  location?: string;
  description?: string;
  type: 'gcal' | 'task';
  htmlLink?: string;
  opportunityName?: string;
  accountName?: string;
  status?: string;
  priority?: string;
  whatId?: string;
}

export interface CalendarSource {
  id: string;
  label: string;
  type: 'gcal' | 'task';
  color: string;
  iconKey?: 'meeting' | 'task'; // optional; defaults derived from type
}

interface WeeklyCalendarProps {
  events: CalendarEvent[];
  loading?: boolean;
  viewMode?: CalendarViewMode;
  onViewModeChange?: (mode: CalendarViewMode) => void;
  weekOffset?: number;
  onWeekOffsetChange?: (offset: number) => void;
  sources?: CalendarSource[];
  enabledSources?: string[];
  onToggleSource?: (sourceId: string) => void;
  onTaskClick?: (taskId: string, whatId: string) => void;
  timeGridHeight?: number;
  onTimeGridHeightChange?: (height: number) => void;
  headerSlot?: React.ReactNode;
  showWeekends?: boolean;
  onShowWeekendsChange?: (show: boolean) => void;
}

const VIEW_DAYS: Record<CalendarViewMode, number> = {
  day: 1,
  week: 7,
  '2week': 14,
};

const DEFAULT_SOURCES: CalendarSource[] = [
  { id: 'gcal-pbd', label: 'PBD Calendar', type: 'gcal', color: '#7b1fa2' },
  { id: 'sf-tasks', label: 'Salesforce Tasks', type: 'task', color: '#1565c0' },
];

const MAX_VISIBLE_ITEMS = 6;
const TITLE_TRUNCATE_LEN = 40;
const MIN_COL_WIDTH = 110; // px — minimum day column width before horizontal scroll
const GUTTER_WIDTH = 50;   // px — time label / icon column

function truncate(str: string, len: number): string {
  if (!str) return '';
  return str.length <= len ? str : str.slice(0, len) + '…';
}

function getTaskBorderColor(ev: CalendarEvent): string {
  if (ev.status === 'Completed') return '#4caf50';
  if (ev.priority === 'High') return '#d32f2f';
  if (ev.priority === 'Normal') return '#e57373';
  return '#9e9e9e';
}

function formatTime(dateStr: string): string {
  try { return format(parseISO(dateStr), 'h:mm a'); }
  catch { return ''; }
}

// Default visible window: 8 AM – 8 PM. Expands dynamically to fit the
// current week's earliest/latest events; clamped to [6 AM, midnight] so a
// stray overnight event doesn't blow out the layout.
const DEFAULT_DAY_START = 8;
const DEFAULT_DAY_END = 20;
const MIN_DAY_START = 6;
const MAX_DAY_END = 24;

interface DayBounds { start: number; end: number; }

/**
 * Compute the effective day bounds for a given event list. Default window is
 * 8 AM – 8 PM; we *expand* down to fit earlier events (floor 6 AM) and up to
 * fit later events (ceiling midnight). We never *shrink* the window.
 */
function computeDayBounds(events: CalendarEvent[]): DayBounds {
  let earliest = DEFAULT_DAY_START;
  let latest = DEFAULT_DAY_END;
  for (const ev of events) {
    try {
      const s = parseISO(ev.start);
      const sh = s.getHours() + s.getMinutes() / 60;
      if (sh < earliest) earliest = sh;
      const endStr = ev.end || ev.start;
      const e = parseISO(endStr);
      // Round up so an event ending at 9:05 PM shows the 9 PM line; prefer
      // the fractional end to let the event box land correctly.
      const eh = e.getHours() + e.getMinutes() / 60;
      const ceilingEh = Math.ceil(eh);
      if (ceilingEh > latest) latest = ceilingEh;
    } catch {
      // Malformed dates fall back to defaults — they'll be clamped at render.
    }
  }
  return {
    start: Math.max(MIN_DAY_START, Math.min(DEFAULT_DAY_START, Math.floor(earliest))),
    end: Math.min(MAX_DAY_END, Math.max(DEFAULT_DAY_END, latest)),
  };
}

function getTimeTop(dateStr: string, bounds: DayBounds): number {
  try {
    const d = parseISO(dateStr);
    const hours = d.getHours() + d.getMinutes() / 60;
    const clamped = Math.max(bounds.start, Math.min(bounds.end, hours));
    return ((clamped - bounds.start) / (bounds.end - bounds.start)) * 100;
  } catch { return 0; }
}

function getEventHeight(startStr: string, endStr: string | undefined, bounds: DayBounds): number {
  const span = bounds.end - bounds.start;
  if (!endStr) return (0.5 / span) * 100; // 30min default
  const startPct = getTimeTop(startStr, bounds);
  const endPct = getTimeTop(endStr, bounds);
  return Math.max(endPct - startPct, (0.25 / span) * 100); // min 15min
}

function formatHourLabel(hour: number): string {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

/** Lay out overlapping meetings into side-by-side columns (like GCal). */
interface MeetingLayout {
  event: CalendarEvent;
  column: number;
  totalColumns: number;
  top: number;
  height: number;
}

function layoutMeetings(meetings: CalendarEvent[], bounds: DayBounds): MeetingLayout[] {
  if (meetings.length === 0) return [];

  // Compute position for each meeting (already sorted by start time)
  const items = meetings.map((ev) => ({
    event: ev,
    top: getTimeTop(ev.start, bounds),
    bottom: getTimeTop(ev.start, bounds) + getEventHeight(ev.start, ev.end, bounds),
    height: getEventHeight(ev.start, ev.end, bounds),
    column: 0,
  }));

  // Greedily assign each meeting to the leftmost column where it fits
  const colEnds: number[] = [];
  for (const item of items) {
    let col = colEnds.findIndex((end) => end <= item.top + 0.1);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(0);
    }
    colEnds[col] = item.bottom;
    item.column = col;
  }

  // Group overlapping meetings so each group gets its own column count
  const groups: number[][] = [];
  let cur: number[] = [];
  let groupBottom = 0;

  for (let i = 0; i < items.length; i++) {
    if (cur.length === 0 || items[i].top < groupBottom - 0.1) {
      cur.push(i);
      groupBottom = Math.max(groupBottom, items[i].bottom);
    } else {
      groups.push(cur);
      cur = [i];
      groupBottom = items[i].bottom;
    }
  }
  if (cur.length > 0) groups.push(cur);

  const result: MeetingLayout[] = items.map((it) => ({
    event: it.event,
    column: it.column,
    totalColumns: 1,
    top: it.top,
    height: it.height,
  }));

  for (const group of groups) {
    const totalCols = Math.max(...group.map((i) => items[i].column)) + 1;
    for (const i of group) result[i].totalColumns = totalCols;
  }

  return result;
}

const WeeklyCalendar: React.FC<WeeklyCalendarProps> = ({
  events,
  loading = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  weekOffset: controlledWeekOffset,
  onWeekOffsetChange,
  sources = DEFAULT_SOURCES,
  enabledSources: controlledEnabledSources,
  onToggleSource,
  onTaskClick,
  timeGridHeight: controlledTimeGridHeight,
  onTimeGridHeightChange,
  headerSlot,
  showWeekends = true,
  onShowWeekendsChange,
}) => {
  const [internalViewMode, setInternalViewMode] = useState<CalendarViewMode>('week');
  const viewMode = controlledViewMode ?? internalViewMode;
  const timeGridHeight = controlledTimeGridHeight ?? 520;

  const [internalWeekOffset, setInternalWeekOffset] = useState(0);
  const weekOffset = controlledWeekOffset ?? internalWeekOffset;
  const setWeekOffset = onWeekOffsetChange ?? setInternalWeekOffset;

  const [internalEnabled, setInternalEnabled] = useState<Set<string>>(
    new Set(sources.map((s) => s.id)),
  );
  const enabledSet = controlledEnabledSources
    ? new Set(controlledEnabledSources)
    : internalEnabled;

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [eventAnchorEl, setEventAnchorEl] = useState<HTMLElement | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const closeEventPopover = useCallback(() => {
    setEventAnchorEl(null);
    setSelectedEvent(null);
  }, []);

  const handleViewChange = (_: any, newMode: CalendarViewMode | null) => {
    if (!newMode) return;
    if (newMode === 'day') setWeekOffset(0);
    if (onViewModeChange) onViewModeChange(newMode);
    else setInternalViewMode(newMode);
  };

  const handleToggle = (sourceId: string) => {
    if (onToggleSource) {
      onToggleSource(sourceId);
    } else {
      setInternalEnabled((prev) => {
        const next = new Set(prev);
        if (next.has(sourceId)) next.delete(sourceId);
        else next.add(sourceId);
        return next;
      });
    }
  };

  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      const src = sources.find((s) => s.type === ev.type);
      return src ? enabledSet.has(src.id) : true;
    });
  }, [events, sources, enabledSet]);

  // Time axis — expands dynamically to fit the week's events (no clipping).
  const dayBounds = useMemo(() => computeDayBounds(filteredEvents), [filteredEvents]);
  const hours = useMemo(
    () => Array.from({ length: dayBounds.end - dayBounds.start + 1 }, (_, i) => dayBounds.start + i),
    [dayBounds],
  );

  const days = useMemo(() => {
    const today = new Date();
    const start = viewMode === 'day'
      ? today
      : startOfWeek(addDays(today, weekOffset * 7), { weekStartsOn: 1 });
    const count = VIEW_DAYS[viewMode];
    const allDays = Array.from({ length: count }, (_, i) => addDays(start, i));
    if (!showWeekends && viewMode !== 'day') {
      return allDays.filter(d => !isWeekend(d));
    }
    return allDays;
  }, [viewMode, weekOffset, showWeekends]);

  // Dynamic title truncation — wider columns can show more text
  const titleTruncLen = viewMode === 'day' ? 60 : (days.length <= 5 ? 50 : days.length <= 7 ? 40 : 20);
  const taskTruncLen = viewMode === 'day' ? 60 : (days.length <= 5 ? 30 : 20);

  // Shared grid layout — guarantees column alignment across all sections
  const minGridWidth = GUTTER_WIDTH + days.length * MIN_COL_WIDTH;
  const gridCols = `${GUTTER_WIDTH}px repeat(${days.length}, minmax(${MIN_COL_WIDTH}px, 1fr))`;

  // Group events by day, split into timed meetings, all-day meetings, and tasks
  const eventsByDay = useMemo(() => {
    const map = new Map<string, { meetings: CalendarEvent[]; allDayMeetings: CalendarEvent[]; tasks: CalendarEvent[] }>();
    for (const day of days) {
      map.set(format(day, 'yyyy-MM-dd'), { meetings: [], allDayMeetings: [], tasks: [] });
    }
    for (const ev of filteredEvents) {
      if (!ev.start) continue;
      try {
        const evDate = parseISO(ev.start);
        for (const day of days) {
          if (isSameDay(evDate, day)) {
            const entry = map.get(format(day, 'yyyy-MM-dd'));
            if (entry) {
              if (ev.type === 'task') {
                entry.tasks.push(ev);
              } else if (!ev.start.includes('T')) {
                // Date-only start = all-day event
                entry.allDayMeetings.push(ev);
              } else {
                entry.meetings.push(ev);
              }
            }
            break;
          }
        }
      } catch {}
    }
    // Sort meetings by start time, tasks by due date
    map.forEach((entry) => {
      entry.meetings.sort((a: CalendarEvent, b: CalendarEvent) => (a.start || '').localeCompare(b.start || ''));
      entry.tasks.sort((a: CalendarEvent, b: CalendarEvent) => (a.start || '').localeCompare(b.start || ''));
    });
    return map;
  }, [filteredEvents, days]);

  const isTodayFn = (d: Date) => isSameDay(d, new Date());
  const meetingColor = sources.find((s) => s.type === 'gcal')?.color || '#1976d2';
  const taskColor = sources.find((s) => s.type === 'task')?.color || '#ed6c02';

  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!loading && gridRef.current) {
      const nowLine = gridRef.current.querySelector('[data-now-line]') as HTMLElement;
      if (nowLine) {
        // Scroll the container (not the page) so the now-line is centered
        const containerHeight = gridRef.current.clientHeight;
        const nowTop = nowLine.offsetTop;
        gridRef.current.scrollTop = Math.max(0, nowTop - containerHeight / 2);
      }
    }
  }, [loading, viewMode]);

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header bar — pl: 4 clears the absolutely-positioned collapse button in MyDashboard */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap', pl: 4 }}>
        {headerSlot}
        <Box sx={{ flex: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {viewMode !== 'day' && (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={weekOffset}
              onChange={(_, val) => { if (val !== null) setWeekOffset(val); }}
            >
              <ToggleButton value={0} sx={{ textTransform: 'none', px: 1, py: 0.25, fontSize: '0.75rem' }}>This Week</ToggleButton>
              <ToggleButton value={1} sx={{ textTransform: 'none', px: 1, py: 0.25, fontSize: '0.75rem' }}>Next Week</ToggleButton>
            </ToggleButtonGroup>
          )}
          <IconButton size="small" onClick={(e) => setAnchorEl(e.currentTarget)}>
            <CalendarCheckIcon fontSize="small" />
          </IconButton>
          <Popover
            open={Boolean(anchorEl)}
            anchorEl={anchorEl}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <Box sx={{ p: 2, minWidth: 200 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Calendars</Typography>
              {sources.map((src) => (
                <FormControlLabel
                  key={src.id}
                  control={
                    <Checkbox
                      size="small"
                      checked={enabledSet.has(src.id)}
                      onChange={() => handleToggle(src.id)}
                      sx={{ color: src.color, '&.Mui-checked': { color: src.color } }}
                    />
                  }
                  label={<Typography variant="body2">{src.label}</Typography>}
                />
              ))}
            </Box>
          </Popover>

          <ToggleButtonGroup size="small" exclusive value={viewMode} onChange={handleViewChange}>
            <ToggleButton value="day" sx={{ textTransform: 'none', px: 1, py: 0.25, fontSize: '0.75rem' }}>Day</ToggleButton>
            <ToggleButton value="week" sx={{ textTransform: 'none', px: 1, py: 0.25, fontSize: '0.75rem' }}>Week</ToggleButton>
          </ToggleButtonGroup>
          {viewMode !== 'day' && (
            <Button
              size="small"
              variant={showWeekends ? 'contained' : 'outlined'}
              onClick={() => onShowWeekendsChange?.(!showWeekends)}
              sx={{
                textTransform: 'none',
                fontSize: '0.75rem',
                px: 1,
                py: 0.25,
                minWidth: 'auto',
                lineHeight: 1.75,
              }}
            >
              Sat/Sun
            </Button>
          )}
        </Box>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', py: 4, gap: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2">Loading events...</Typography>
        </Box>
      ) : (
        <Box ref={gridRef} sx={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
          {/* Day headers — sticky at top during vertical scroll */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: gridCols,
              minWidth: minGridWidth,
              borderBottom: '1px solid',
              borderColor: 'divider',
              pb: 0.5,
              mb: 0,
              position: 'sticky',
              top: 0,
              zIndex: 5,
              bgcolor: 'background.paper',
            }}
          >
            <Box /> {/* spacer for time column */}
            {days.map((day) => {
              const today = isTodayFn(day);
              return (
                <Box key={format(day, 'yyyy-MM-dd')} sx={{ textAlign: 'center' }}>
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: today ? 700 : 500, color: today ? 'primary.main' : 'text.secondary', fontSize: '0.75rem' }}
                  >
                    {format(day, 'EEE')}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: today ? 700 : 400,
                      bgcolor: today ? 'primary.main' : 'transparent',
                      color: today ? 'white' : 'text.primary',
                      borderRadius: '50%',
                      width: 24,
                      height: 24,
                      mx: 'auto',
                      fontSize: '0.8rem',
                    }}
                  >
                    {format(day, 'd')}
                  </Typography>
                </Box>
              );
            })}
          </Box>

          {/* All-day row: tasks */}
          {(() => {
            const allDayTasks = days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              return eventsByDay.get(key)?.tasks || [];
            });
            const hasAnyTasks = allDayTasks.some((t) => t.length > 0);
            if (!hasAnyTasks) return null;
            return (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: gridCols,
                  minWidth: minGridWidth,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <TaskIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                </Box>
                {days.map((day, di) => {
                  const key = format(day, 'yyyy-MM-dd');
                  const tasks = eventsByDay.get(key)?.tasks || [];
                  return (
                    <Box
                      key={key}
                      sx={{
                        px: 0.25,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.25,
                        py: 0.25,
                        borderLeft: di > 0 ? '1px solid' : 'none',
                        borderColor: 'divider',
                      }}
                    >
                      {tasks.map((ev, i) => {
                        const borderColor = getTaskBorderColor(ev);
                        const isCompleted = ev.status === 'Completed';
                        const hasOpp = ev.whatId && onTaskClick;
                        return (
                          <Tooltip
                            key={ev.id + i}
                            title={hasOpp ? 'Open in task panel' : 'No linked opportunity'}
                            placement="top"
                            arrow
                          >
                            <Box
                              onClick={(e) => {
                                if (hasOpp) {
                                  onTaskClick!(ev.id, ev.whatId!);
                                } else {
                                  setSelectedEvent(ev);
                                  setEventAnchorEl(e.currentTarget as HTMLElement);
                                }
                              }}
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.5,
                                px: 0.5,
                                py: 0.25,
                                borderRadius: 0.5,
                                bgcolor: isCompleted ? 'grey.50' : 'transparent',
                                borderLeft: `3px solid ${borderColor}`,
                                cursor: 'pointer',
                                overflow: 'hidden',
                                opacity: isCompleted ? 0.6 : 1,
                                '&:hover': { bgcolor: 'action.hover' },
                              }}
                            >
                              {isCompleted ? (
                                <CheckCircleIcon sx={{ fontSize: 14, color: 'success.main' }} />
                              ) : (
                                <TaskIcon sx={{ fontSize: 14, color: borderColor }} />
                              )}
                              <Typography
                                variant="caption"
                                noWrap
                                sx={{
                                  fontSize: '0.7rem',
                                  lineHeight: 1.2,
                                  minWidth: 0,
                                  textDecoration: isCompleted ? 'line-through' : 'none',
                                  color: isCompleted ? 'text.secondary' : 'text.primary',
                                }}
                              >
                                {truncate(ev.summary, taskTruncLen)}
                              </Typography>
                            </Box>
                          </Tooltip>
                        );
                      })}
                    </Box>
                  );
                })}
              </Box>
            );
          })()}

          {/* All-day row: GCal all-day events (below tasks, above time grid) */}
          {(() => {
            const allDayMeetings = days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              return eventsByDay.get(key)?.allDayMeetings || [];
            });
            const hasAny = allDayMeetings.some((m) => m.length > 0);
            if (!hasAny) return null;
            return (
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: gridCols,
                  minWidth: minGridWidth,
                  borderBottom: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <CalendarCheckIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                </Box>
                {days.map((day, di) => {
                  const key = format(day, 'yyyy-MM-dd');
                  const meetings = eventsByDay.get(key)?.allDayMeetings || [];
                  return (
                    <Box
                      key={key}
                      sx={{
                        px: 0.25,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.25,
                        py: 0.25,
                        borderLeft: di > 0 ? '1px solid' : 'none',
                        borderColor: 'divider',
                      }}
                    >
                      {meetings.map((ev, i) => (
                        <Tooltip key={ev.id + i} title={ev.summary} placement="top" arrow>
                          <Box
                            onClick={(e) => {
                              setSelectedEvent(ev);
                              setEventAnchorEl(e.currentTarget as HTMLElement);
                            }}
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 0.5,
                              px: 0.5,
                              py: 0.25,
                              borderRadius: 1,
                              bgcolor: `${meetingColor}20`,
                              cursor: 'pointer',
                              overflow: 'hidden',
                              '&:hover': { bgcolor: `${meetingColor}35` },
                            }}
                          >
                            <Typography
                              variant="caption"
                              noWrap
                              sx={{
                                fontSize: '0.7rem',
                                lineHeight: 1.2,
                                minWidth: 0,
                                fontWeight: 500,
                                color: meetingColor,
                              }}
                            >
                              {truncate(ev.summary, taskTruncLen)}
                            </Typography>
                          </Box>
                        </Tooltip>
                      ))}
                    </Box>
                  );
                })}
              </Box>
            );
          })()}

          {/* Time grid */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: gridCols,
              minWidth: minGridWidth,
              position: 'relative',
              borderTop: '1px solid',
              borderColor: 'divider',
            }}
          >
            {/* Hour labels column — sticky left during horizontal scroll */}
            <Box sx={{ position: 'sticky', left: 0, zIndex: 2, bgcolor: 'background.paper', pt: 0.5 }}>
              {hours.map((hour) => (
                <Box
                  key={hour}
                  sx={{
                    height: 40,
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'flex-end',
                    pr: 0.5,
                  }}
                >
                  <Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'text.disabled', lineHeight: 1 }}>
                    {formatHourLabel(hour)}
                  </Typography>
                </Box>
              ))}
            </Box>

            {/* Day columns */}
            {days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const { meetings } = eventsByDay.get(key) || { meetings: [], tasks: [] };
              const today = isTodayFn(day);

              return (
                <Box
                  key={key}
                  sx={{
                    position: 'relative',
                    borderLeft: '1px solid',
                    borderColor: 'divider',
                    height: hours.length * 40,
                  }}
                >
                  {/* Horizontal grid lines */}
                  {hours.map((hour) => (
                    <Box
                      key={hour}
                      sx={{
                        position: 'absolute',
                        top: `${((hour - dayBounds.start) / (dayBounds.end - dayBounds.start)) * 100}%`,
                        left: 0,
                        right: 0,
                        borderTop: '1px solid',
                        borderColor: 'divider',
                        opacity: 0.5,
                      }}
                    />
                  ))}

                  {/* Current time indicator */}
                  {today && (
                    <Box
                      data-now-line
                      sx={{
                        position: 'absolute',
                        top: `${getTimeTop(new Date().toISOString(), dayBounds)}%`,
                        left: 0,
                        right: 0,
                        height: 2,
                        bgcolor: '#d32f2f',
                        zIndex: 3,
                        '&::before': {
                          content: '""',
                          position: 'absolute',
                          left: -3,
                          top: -3,
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          bgcolor: '#d32f2f',
                        },
                      }}
                    />
                  )}

                  {/* Meeting blocks — side-by-side when overlapping */}
                  {layoutMeetings(meetings, dayBounds).map((layout, i) => {
                    const { event: ev, column, totalColumns, top, height } = layout;
                    const colWidth = 100 / totalColumns;
                    const leftPct = column * colWidth;
                    const time = formatTime(ev.start);
                    const endTime = ev.end ? formatTime(ev.end) : '';
                    const attendeeCount = (ev.attendees || []).length;

                    return (
                      <Box
                        key={ev.id + i}
                        onClick={(e) => {
                          setSelectedEvent(ev);
                          setEventAnchorEl(e.currentTarget as HTMLElement);
                        }}
                        sx={{
                          position: 'absolute',
                          top: `${top}%`,
                          height: `${height}%`,
                          left: `calc(${leftPct}% + 1px)`,
                          width: `calc(${colWidth}% - 2px)`,
                          bgcolor: `${meetingColor}18`,
                          borderLeft: `3px solid ${meetingColor}`,
                          borderRadius: 0.5,
                          px: 0.5,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          zIndex: 1,
                          '&:hover': { bgcolor: `${meetingColor}28`, zIndex: 2 },
                        }}
                      >
                        <Typography
                          variant="caption"
                          noWrap
                          sx={{ fontSize: '0.7rem', fontWeight: 600, lineHeight: 1.3, display: 'block', minWidth: 0 }}
                        >
                          {truncate(ev.summary, titleTruncLen)}
                        </Typography>
                        <Typography variant="caption" noWrap sx={{ fontSize: '0.6rem', color: 'text.secondary', lineHeight: 1, display: 'block', minWidth: 0 }}>
                          {time}{endTime ? ` – ${endTime}` : ''}
                        </Typography>
                        {viewMode === 'day' && attendeeCount > 0 && (
                          <Typography variant="caption" noWrap sx={{ fontSize: '0.6rem', color: 'text.secondary', display: 'block', minWidth: 0 }}>
                            {(ev.attendees || []).map((a: any) => a.name || a.email).filter(Boolean).slice(0, 3).join(', ')}
                            {attendeeCount > 3 ? ` +${attendeeCount - 3}` : ''}
                          </Typography>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              );
            })}
          </Box>

          {/* Calendar height resize handle */}
          {onTimeGridHeightChange && (
            <Box
              onMouseDown={(e) => {
                e.preventDefault();
                const startY = e.clientY;
                const startHeight = timeGridHeight;
                const onMove = (me: MouseEvent) => {
                  const newH = Math.min(800, Math.max(200, startHeight + me.clientY - startY));
                  onTimeGridHeightChange(newH);
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
              sx={{
                height: 8,
                cursor: 'row-resize',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                '&:hover > div': { bgcolor: 'primary.main' },
              }}
            >
              <Box sx={{ width: 40, height: 4, borderRadius: 2, bgcolor: 'divider', transition: 'background-color 0.15s' }} />
            </Box>
          )}
        </Box>
      )}

      {/* Event / orphan-task detail popover */}
      <Popover
        open={Boolean(eventAnchorEl) && Boolean(selectedEvent)}
        anchorEl={eventAnchorEl}
        onClose={closeEventPopover}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { maxWidth: 340, p: 1.5, position: 'relative' } } }}
      >
        {selectedEvent && (
          <>
            <IconButton
              size="small"
              onClick={closeEventPopover}
              sx={{ position: 'absolute', top: 4, right: 4 }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
            {selectedEvent.type === 'gcal' && selectedEvent.htmlLink ? (
              <Typography
                variant="subtitle2"
                component="a"
                href={selectedEvent.htmlLink}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ fontWeight: 600, mb: 0.5, pr: 3, display: 'block', color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
              >
                {selectedEvent.summary}
              </Typography>
            ) : (
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5, pr: 3 }}>
                {selectedEvent.summary}
              </Typography>
            )}

            {selectedEvent.type === 'gcal' && (
              <>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                  {formatTime(selectedEvent.start)}
                  {selectedEvent.end ? ` \u2013 ${formatTime(selectedEvent.end)}` : ''}
                </Typography>
                {selectedEvent.location && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                    {selectedEvent.location}
                  </Typography>
                )}
                {selectedEvent.description && (
                  <Typography variant="caption" sx={{ mt: 0.5, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>
                    {selectedEvent.description.length > 200 ? selectedEvent.description.slice(0, 200) + '\u2026' : selectedEvent.description}
                  </Typography>
                )}
                {(selectedEvent.attendees?.length || 0) > 0 && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                    {selectedEvent.attendees!.slice(0, 5).map(a => a.name || a.email).filter(Boolean).join(', ')}
                    {selectedEvent.attendees!.length > 5 ? ` +${selectedEvent.attendees!.length - 5} more` : ''}
                  </Typography>
                )}
              </>
            )}

            {selectedEvent.type === 'task' && (
              <>
                <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5, flexWrap: 'wrap' }}>
                  {selectedEvent.status && <Chip label={selectedEvent.status} size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
                  {selectedEvent.priority && <Chip label={selectedEvent.priority} size="small" sx={{ height: 20, fontSize: '0.7rem' }} variant="outlined" />}
                </Box>
                {selectedEvent.opportunityName && (
                  <Typography variant="caption" sx={{ fontSize: '0.75rem', color: 'text.secondary', display: 'block' }}>
                    Opp: {selectedEvent.opportunityName}
                  </Typography>
                )}
                {selectedEvent.description && (
                  <Typography variant="caption" sx={{ mt: 0.5, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>
                    {selectedEvent.description.length > 200 ? selectedEvent.description.slice(0, 200) + '\u2026' : selectedEvent.description}
                  </Typography>
                )}
              </>
            )}
          </>
        )}
      </Popover>
    </Box>
  );
};

export default WeeklyCalendar;
