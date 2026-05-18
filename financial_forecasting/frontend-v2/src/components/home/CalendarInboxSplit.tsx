import { CalendarDays, Inbox } from "lucide-react";

import { SplitPanel } from "@/components/ui/SplitPanel";
import { useLayoutPrefs } from "@/lib/useLayoutPrefs";
import { useMyCalendarEvents } from "@/services/calendar";
import { useMyTasks } from "@/services/tasks";
import {
  WeeklyCalendar,
  type CalendarViewMode,
} from "@/components/home/WeeklyCalendar";
import { TaskInbox } from "@/components/home/TaskInbox";
import type { FlatTask } from "@/components/TaskDrawer";

interface SplitPrefs {
  viewMode: CalendarViewMode;
  weekOffset: number;
  showWeekends: boolean;
  inboxHeight: number;
}

const DEFAULTS: SplitPrefs = {
  viewMode: "week",
  weekOffset: 0,
  showWeekends: true,
  inboxHeight: 520,
};

const SPLIT_STORAGE_KEY = "bedrock:home:jp:cal-inbox-split";
const PREFS_STORAGE_KEY = "bedrock:home:jp:cal-inbox";

export interface CalendarInboxSplitProps {
  /** Current user's SF id — for the inbox "Mine" filter. */
  currentUserId?: string | null;
  /** Click a task in either pane → caller opens TaskDrawer. */
  onTaskClick?: (task: FlatTask) => void;
  /** Height of the split surface (CSS). */
  height?: string;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
}

/**
 * Composes WeeklyCalendar (left) and TaskInbox (right) into a sliding
 * split. Persists view mode, weekend toggle, week offset, inbox height,
 * and the L/R split percentage to localStorage under
 * `bedrock:home:jp:*` keys (per-owner namespace).
 *
 * Headline interaction port from `frontend/src/pages/Priorities.tsx`
 * lines 176–457 (`CalendarInboxSplit`) — now using v2 primitives only.
 */
export function CalendarInboxSplit({
  currentUserId,
  onTaskClick,
  height = "calc(100vh - 240px)",
  minHeight = 400,
  maxHeight = 800,
  className,
}: CalendarInboxSplitProps) {
  const { prefs, setPrefs } = useLayoutPrefs<SplitPrefs>(PREFS_STORAGE_KEY, DEFAULTS);

  // Pull data once and pass into both panes. Both queries are cached so
  // siblings rendering elsewhere don't duplicate the network call.
  const { dateWindow } = useDateWindow(prefs.viewMode, prefs.weekOffset);
  const calendarQ = useMyCalendarEvents({
    start: dateWindow.start,
    end: dateWindow.end,
    limit: 200,
  });
  const tasksQ = useMyTasks(dateWindow.start, dateWindow.end);

  return (
    <SplitPanel
      storageKey={SPLIT_STORAGE_KEY}
      height={height}
      minHeight={minHeight}
      maxHeight={maxHeight}
      className={className}
      left={{
        defaultPct: 60,
        minPct: 30,
        collapsedTab: (
          <span className="flex items-center gap-1.5">
            <CalendarDays size={13} /> Calendar
          </span>
        ),
        node: (
          <WeeklyCalendar
            events={calendarQ.data ?? []}
            tasks={tasksQ.data ?? []}
            loading={calendarQ.isLoading || tasksQ.isLoading}
            needsReauth={calendarQ.error?.needsReauth ?? false}
            viewMode={prefs.viewMode}
            onViewModeChange={(v) => setPrefs({ viewMode: v })}
            weekOffset={prefs.weekOffset}
            onWeekOffsetChange={(n) => setPrefs({ weekOffset: n })}
            showWeekends={prefs.showWeekends}
            onShowWeekendsChange={(v) => setPrefs({ showWeekends: v })}
            onTaskClick={onTaskClick}
          />
        ),
      }}
      right={{
        defaultPct: 40,
        minPct: 25,
        collapsedTab: (
          <span className="flex items-center gap-1.5">
            <Inbox size={13} /> Inbox
          </span>
        ),
        node: (
          <TaskInbox
            tasks={tasksQ.data ?? []}
            loading={tasksQ.isLoading}
            currentUserId={currentUserId}
            maxHeight={prefs.inboxHeight}
            onHeightChange={(h) => setPrefs({ inboxHeight: h })}
            onTaskClick={onTaskClick}
          />
        ),
      }}
    />
  );
}

function useDateWindow(viewMode: CalendarViewMode, weekOffset: number) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monday = startOfIsoWeek(today);
  const base = addDays(monday, weekOffset * 7);
  const span = viewMode === "day" ? 1 : viewMode === "week" ? 7 : 14;
  // Pull a 30-day buffer on either side so the calendar can render
  // overflow events near the edges and the inbox shows a meaningful
  // forward window. Backend caps at 200 events / 180 days forward.
  const start = addDays(base, -30);
  const end = addDays(base, span + 30);
  return {
    dateWindow: {
      start: toIsoDate(start),
      end: toIsoDate(end),
    },
  };
}

function startOfIsoWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  out.setDate(out.getDate() + diff);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
