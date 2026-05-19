import { useMemo } from "react";
import {
  addDays,
  format,
  isSameDay,
  isWeekend,
  parseISO,
  startOfDay,
  startOfWeek,
} from "date-fns";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
} from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { cn } from "@/lib/utils";
import type { GCalEvent } from "@/services/calendar";
import type { SfMyTask } from "@/services/tasks";
import type { FlatTask } from "@/components/TaskDrawer";

export type CalendarViewMode = "day" | "week" | "2week";

const VIEW_DAYS: Record<CalendarViewMode, number> = {
  day: 1,
  week: 7,
  "2week": 14,
};

export interface WeeklyCalendarProps {
  events: GCalEvent[];
  tasks: SfMyTask[];
  loading?: boolean;
  /** When set, the calendar pane shows a "reconnect Google" banner. */
  needsReauth?: boolean;

  viewMode: CalendarViewMode;
  onViewModeChange: (m: CalendarViewMode) => void;

  /** Week offset from "this week"; positive = future, negative = past. */
  weekOffset: number;
  onWeekOffsetChange: (n: number) => void;

  showWeekends: boolean;
  onShowWeekendsChange: (v: boolean) => void;

  /** Click a task event → opens TaskDrawer. */
  onTaskClick?: (task: FlatTask) => void;
  /** Click a GCal event → opens its htmlLink in a new tab if present. */
  onEventClick?: (ev: GCalEvent) => void;

  headerSlot?: React.ReactNode;
  /** When provided, renders a collapse chevron in the header that
   *  hides this pane (caller wires it to a SplitPanel handle). */
  onCollapse?: () => void;
  className?: string;
}

interface DayBucket {
  date: Date;
  isWeekend: boolean;
  isToday: boolean;
  events: GCalEvent[];
  tasks: SfMyTask[];
}

/**
 * Weekly calendar surface for the home page. Renders a day-column grid
 * with all-day-style cells (no fine time grid). GCal events come from
 * the PBD shared calendar via `useMyCalendarEvents`; tasks come from
 * `useMyTasks`. Both sources are passed in as props so the parent owns
 * the fetch lifecycle and caching.
 *
 * Tasks click → caller opens TaskDrawer with the FlatTask. GCal events
 * with `htmlLink` open in a new tab. The grid auto-fits the requested
 * view mode (day / week / 2week).
 */
export function WeeklyCalendar({
  events,
  tasks,
  loading = false,
  needsReauth = false,
  viewMode,
  onViewModeChange,
  weekOffset,
  onWeekOffsetChange,
  showWeekends,
  onShowWeekendsChange,
  onTaskClick,
  onEventClick,
  headerSlot,
  onCollapse,
  className,
}: WeeklyCalendarProps) {
  const days = useMemo(() => {
    const today = startOfDay(new Date());
    const monday = startOfWeek(today, { weekStartsOn: 1 });
    const base = addDays(monday, weekOffset * 7);
    const count = VIEW_DAYS[viewMode];
    const cells: DayBucket[] = [];
    for (let i = 0; i < count; i++) {
      const d = addDays(base, i);
      const weekend = isWeekend(d);
      if (!showWeekends && weekend) continue;
      cells.push({
        date: d,
        isWeekend: weekend,
        isToday: isSameDay(d, today),
        events: [],
        tasks: [],
      });
    }
    // Bucket events + tasks into day cells (compare by local-date string
    // since GCal timestamps include offsets and tasks use ActivityDate).
    const cellByKey = new Map(cells.map((c) => [dateKey(c.date), c]));
    for (const ev of events) {
      const key = dateKey(parseISO(ev.start));
      cellByKey.get(key)?.events.push(ev);
    }
    for (const t of tasks) {
      if (!t.ActivityDate) continue;
      const key = t.ActivityDate.slice(0, 10);
      cellByKey.get(key)?.tasks.push(t);
    }
    // Sort within each cell by time (events) then due-time-or-asc (tasks).
    for (const c of cells) {
      c.events.sort((a, b) => a.start.localeCompare(b.start));
      c.tasks.sort((a, b) =>
        (a.ActivityDate ?? "").localeCompare(b.ActivityDate ?? ""),
      );
    }
    return cells;
  }, [events, tasks, viewMode, weekOffset, showWeekends]);

  const eventCount = events.length;
  const taskCount = tasks.filter((t) => t.Status !== "Completed" && !t.IsClosed).length;

  return (
    <section
      className={cn(
        "flex h-full flex-col rounded-lg border border-border-strong bg-surface",
        className,
      )}
    >
      <header className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-3 py-2">
        {headerSlot ?? (
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <CalendarDays size={15} className="text-accent" /> Calendar
          </div>
        )}
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse calendar to left edge"
            title="Collapse calendar"
            className="grid h-6 w-6 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink"
          >
            <PanelLeftClose size={13} />
          </button>
        ) : null}
        {eventCount > 0 ? (
          <Tag>{eventCount} events</Tag>
        ) : null}
        {taskCount > 0 ? (
          <Tag variant="accent">{taskCount} tasks</Tag>
        ) : null}
        <div className="flex-1" />
        <ViewModeToggle value={viewMode} onChange={onViewModeChange} />
        <button
          type="button"
          onClick={() => onShowWeekendsChange(!showWeekends)}
          aria-pressed={showWeekends}
          className={cn(
            "h-7 rounded border px-2 text-[11.5px] font-medium",
            showWeekends
              ? "border-accent bg-accent-soft text-accent-ink"
              : "border-border-strong bg-surface text-ink-2 hover:bg-surface-2",
          )}
          title="Toggle weekends"
        >
          S/S
        </button>
        <div className="flex items-center">
          <NavButton onClick={() => onWeekOffsetChange(weekOffset - 1)} label="Previous">
            <ChevronLeft size={14} />
          </NavButton>
          <button
            type="button"
            onClick={() => onWeekOffsetChange(0)}
            className="h-7 border-y border-border-strong bg-surface px-2 text-[11.5px] font-medium text-ink hover:bg-surface-2"
            title="Today"
          >
            Today
          </button>
          <NavButton onClick={() => onWeekOffsetChange(weekOffset + 1)} label="Next">
            <ChevronRight size={14} />
          </NavButton>
        </div>
      </header>

      {needsReauth ? <ReauthBanner /> : null}

      <div
        className="grid flex-1 grid-flow-col overflow-x-auto overflow-y-hidden"
        style={{
          gridAutoColumns: `minmax(${viewMode === "day" ? "100%" : "150px"}, 1fr)`,
        }}
      >
        {loading
          ? Array.from({ length: VIEW_DAYS[viewMode] }).map((_, i) => (
              <DaySkeleton key={i} />
            ))
          : days.map((d) => (
              <DayColumn
                key={d.date.toISOString()}
                day={d}
                onTaskClick={onTaskClick}
                onEventClick={onEventClick}
              />
            ))}
      </div>
    </section>
  );
}

function DayColumn({
  day,
  onTaskClick,
  onEventClick,
}: {
  day: DayBucket;
  onTaskClick?: (task: FlatTask) => void;
  onEventClick?: (ev: GCalEvent) => void;
}) {
  const hasContent = day.events.length > 0 || day.tasks.length > 0;
  return (
    <div
      className={cn(
        "flex h-full flex-col border-r border-border-strong last:border-r-0",
        day.isWeekend && "bg-surface-2/40",
      )}
    >
      <div
        className={cn(
          "flex flex-shrink-0 items-baseline gap-1.5 border-b border-border-strong px-2 py-1.5",
          day.isToday && "bg-accent-soft",
        )}
      >
        <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
          {format(day.date, "EEE")}
        </span>
        <span
          className={cn(
            "text-[15px] font-semibold tabular-nums",
            day.isToday ? "text-accent-ink" : "text-ink",
          )}
        >
          {format(day.date, "d")}
        </span>
        <span className="text-[10.5px] text-ink-3">{format(day.date, "MMM")}</span>
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {!hasContent ? (
          <div className="flex h-full items-center justify-center text-[10.5px] italic text-ink-4">
            —
          </div>
        ) : (
          <>
            {day.events.map((ev) => (
              <EventCell key={`ev:${ev.id}`} event={ev} onClick={onEventClick} />
            ))}
            {day.tasks.map((t) => (
              <TaskCell key={`tk:${t.Id}`} task={t} onClick={onTaskClick} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function EventCell({
  event,
  onClick,
}: {
  event: GCalEvent;
  onClick?: (ev: GCalEvent) => void;
}) {
  const time = useMemo(() => {
    try {
      return format(parseISO(event.start), "h:mm a");
    } catch {
      return null;
    }
  }, [event.start]);
  const link = event.htmlLink;
  const handle = () => {
    onClick?.(event);
    if (link) window.open(link, "_blank", "noopener,noreferrer");
  };
  return (
    <button
      type="button"
      onClick={handle}
      title={event.summary}
      className="group mb-1 block w-full rounded border-l-2 border-accent bg-accent-soft/70 px-1.5 py-1 text-left transition-colors hover:bg-accent-soft"
    >
      {time ? (
        <div className="mono text-[10px] font-semibold tabular-nums text-accent-ink">
          {time}
        </div>
      ) : null}
      <div className="line-clamp-2 text-[11.5px] font-medium text-ink">
        {event.summary || "(no title)"}
      </div>
      {event.location ? (
        <div className="truncate text-[10px] text-ink-3">{event.location}</div>
      ) : null}
    </button>
  );
}

function TaskCell({
  task,
  onClick,
}: {
  task: SfMyTask;
  onClick?: (task: FlatTask) => void;
}) {
  const done = task.Status === "Completed" || !!task.IsClosed;
  return (
    <button
      type="button"
      onClick={() => onClick?.(taskToFlat(task))}
      title={task.Subject ?? "(no subject)"}
      className={cn(
        "mb-1 block w-full rounded border-l-2 px-1.5 py-1 text-left transition-colors",
        done
          ? "border-ink-4 bg-surface-2/60 hover:bg-surface-2"
          : "border-amber bg-amber-soft/60 hover:bg-amber-soft",
      )}
    >
      <div className="flex items-center gap-1">
        {done ? (
          <CheckCircle2 size={11} className="flex-shrink-0 text-ink-3" />
        ) : null}
        <span
          className={cn(
            "line-clamp-2 text-[11.5px] font-medium",
            done ? "text-ink-3 line-through" : "text-ink",
          )}
        >
          {task.Subject ?? "(no subject)"}
        </span>
      </div>
      {task.WhatName ? (
        <div className="truncate text-[10px] text-ink-3">{task.WhatName}</div>
      ) : null}
    </button>
  );
}

function ReauthBanner() {
  return (
    <div
      role="status"
      className="flex flex-shrink-0 items-center gap-2 border-b border-amber/40 bg-amber-soft px-3 py-2 text-[11.5px] text-amber"
    >
      <AlertTriangle size={13} className="flex-shrink-0" />
      <span className="flex-1">
        Google Calendar access expired. Sign out and back in to reconnect.
      </span>
      <a
        href="/auth/logout"
        className="rounded border border-amber/60 bg-surface px-2 py-0.5 text-[11px] font-semibold text-amber hover:bg-amber-soft"
      >
        Sign out
      </a>
    </div>
  );
}

function DaySkeleton() {
  return (
    <div className="flex h-full flex-col border-r border-border-strong last:border-r-0">
      <div className="border-b border-border-strong px-2 py-1.5">
        <div className="h-3 w-10 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="space-y-2 p-1">
        <div className="h-10 animate-pulse rounded bg-surface-2" />
        <div className="h-10 animate-pulse rounded bg-surface-2" />
      </div>
    </div>
  );
}

function ViewModeToggle({
  value,
  onChange,
}: {
  value: CalendarViewMode;
  onChange: (m: CalendarViewMode) => void;
}) {
  const options: { value: CalendarViewMode; label: string }[] = [
    { value: "day", label: "Day" },
    { value: "week", label: "Week" },
    { value: "2week", label: "2w" },
  ];
  return (
    <div
      role="group"
      aria-label="Calendar view mode"
      className="inline-flex overflow-hidden rounded border border-border-strong"
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            "h-7 px-2 text-[11.5px] font-medium",
            i > 0 && "border-l border-border-strong",
            value === o.value
              ? "bg-accent-soft text-accent-ink"
              : "bg-surface text-ink-2 hover:bg-surface-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function NavButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="h-7 border border-border-strong bg-surface px-1.5 text-ink-2 hover:bg-surface-2"
    >
      {children}
    </button>
  );
}

function dateKey(d: Date): string {
  // YYYY-MM-DD in local time, matching SF ActivityDate semantics.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function taskToFlat(t: SfMyTask): FlatTask {
  return {
    source: "crm",
    id: t.Id,
    title: t.Subject ?? "(no subject)",
    status: t.Status ?? "Not Started",
    priority: t.Priority ?? null,
    owner: t.OwnerName ?? null,
    ownerId: t.OwnerId ?? null,
    deadline: t.ActivityDate ?? null,
    description: t.Description ?? null,
    parentLabel: t.WhatName ?? null,
    parentLink: t.WhatId ? `/opportunities/${t.WhatId}` : null,
    type: t.Type ?? null,
  };
}
