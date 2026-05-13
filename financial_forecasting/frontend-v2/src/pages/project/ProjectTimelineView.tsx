import { useMemo, useState } from "react";
import {
  addDays,
  addMonths,
  addQuarters,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfQuarter,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isValid,
  max,
  min,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
} from "date-fns";

import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import {
  type ProjectDetail,
  type ProjectMilestone,
  type ProjectTask,
  type ProjectWorkstream,
} from "@/services/projects";
import { TaskDrawer } from "@/components/project/TaskDrawer";
import {
  taskMatchesFilter,
  type ProjectFilter,
} from "@/components/project/ProjectSubToolbar";

const ROW_HEIGHT = 28;
const GROUP_HEADER_HEIGHT = 26;
const HEADER_HEIGHT = 56;
const MILESTONE_TRACK_HEIGHT = 32;
const LEFT_COL = 280;

const ZOOM_PRESETS = {
  weeks: { dayWidth: 22, label: "Weeks" },
  months: { dayWidth: 8, label: "Months" },
  quarters: { dayWidth: 5, label: "Quarters" },
} as const;

type Zoom = keyof typeof ZOOM_PRESETS;

interface TimelineTask {
  task: ProjectTask;
  milestone: ProjectMilestone;
  workstream: ProjectWorkstream;
  start: Date;
  end: Date;
  pointInTime: boolean;
}

interface TimelineMilestone {
  milestone: ProjectMilestone;
  workstream: ProjectWorkstream;
  due: Date;
}

interface Row {
  kind: "header" | "task";
  height: number;
  label?: string;
  task?: TimelineTask;
}

interface ProjectTimelineViewProps {
  detail: ProjectDetail;
  filter: ProjectFilter;
  canEdit: boolean;
}

function safeParse(dt: string | null | undefined): Date | null {
  if (!dt) return null;
  const d = parseISO(dt);
  return isValid(d) ? d : null;
}

export function ProjectTimelineView({ detail, filter, canEdit }: ProjectTimelineViewProps) {
  const [zoom, setZoom] = useState<Zoom>("months");
  const { dayWidth } = ZOOM_PRESETS[zoom];

  const today = startOfDay(new Date());

  // Flatten and filter all dated tasks once.
  const tasks: TimelineTask[] = useMemo(() => {
    const out: TimelineTask[] = [];
    for (const ws of detail.workstreams) {
      for (const ms of ws.milestones) {
        for (const t of ms.tasks) {
          if (!taskMatchesFilter(t, ms, filter, ws.id)) continue;
          const s = safeParse(t.startDate);
          const e = safeParse(t.deadline);
          if (!s && !e) continue;
          const start = s ?? e!;
          const end = e ?? s!;
          out.push({
            task: t,
            milestone: ms,
            workstream: ws,
            start: startOfDay(start),
            end: startOfDay(end),
            pointInTime: !s || !e,
          });
        }
      }
    }
    return out;
  }, [detail, filter]);

  const milestones: TimelineMilestone[] = useMemo(() => {
    const out: TimelineMilestone[] = [];
    const wsAllowed = filter.workstreamIds.length === 0
      ? null
      : new Set(filter.workstreamIds);
    const msAllowed = filter.milestoneIds.length === 0
      ? null
      : new Set(filter.milestoneIds);
    for (const ws of detail.workstreams) {
      if (wsAllowed && !wsAllowed.has(ws.id)) continue;
      for (const ms of ws.milestones) {
        if (msAllowed && !msAllowed.has(ms.id)) continue;
        const d = safeParse(ms.due_date);
        if (!d) continue;
        out.push({ milestone: ms, workstream: ws, due: startOfDay(d) });
      }
    }
    return out;
  }, [detail, filter.workstreamIds, filter.milestoneIds]);

  // Build the row list — interspersed group headers + task rows.
  const rows: Row[] = useMemo(() => {
    const r: Row[] = [];
    if (filter.groupBy === "workstream") {
      const buckets = new Map<string, { label: string; items: TimelineTask[] }>();
      for (const t of tasks) {
        const k = t.workstream.id;
        if (!buckets.has(k)) buckets.set(k, { label: t.workstream.name, items: [] });
        buckets.get(k)!.items.push(t);
      }
      for (const [, { label, items }] of buckets) {
        r.push({ kind: "header", height: GROUP_HEADER_HEIGHT, label });
        for (const t of items) r.push({ kind: "task", height: ROW_HEIGHT, task: t });
      }
    } else if (filter.groupBy === "milestone") {
      const buckets = new Map<string, { label: string; items: TimelineTask[] }>();
      for (const t of tasks) {
        const k = t.milestone.id;
        if (!buckets.has(k)) {
          buckets.set(k, {
            label: `${t.workstream.name} · ${t.milestone.title}`,
            items: [],
          });
        }
        buckets.get(k)!.items.push(t);
      }
      for (const [, { label, items }] of buckets) {
        r.push({ kind: "header", height: GROUP_HEADER_HEIGHT, label });
        for (const t of items) r.push({ kind: "task", height: ROW_HEIGHT, task: t });
      }
    } else {
      for (const t of tasks) r.push({ kind: "task", height: ROW_HEIGHT, task: t });
    }
    return r;
  }, [tasks, filter.groupBy]);

  // Determine the visible date range. Pad ±15 days for breathing room.
  const range = useMemo(() => {
    const dates: Date[] = [today];
    for (const t of tasks) dates.push(t.start, t.end);
    for (const m of milestones) dates.push(m.due);
    const start = startOfWeek(addDays(min(dates), -15), { weekStartsOn: 1 });
    const end = endOfWeek(addDays(max(dates), 15), { weekStartsOn: 1 });
    return { start, end };
  }, [tasks, milestones, today]);

  const totalDays = differenceInCalendarDays(range.end, range.start) + 1;
  const totalWidth = totalDays * dayWidth;

  const ticks = useMemo(() => generateTicks(range.start, range.end, zoom), [range, zoom]);

  function xOf(d: Date) {
    return differenceInCalendarDays(d, range.start) * dayWidth;
  }

  // Cumulative tops per row so we can absolutely-position bars over the
  // body grid (whose height = sum of all row heights).
  const rowTops = useMemo(() => {
    const tops: number[] = [];
    let y = 0;
    for (const r of rows) {
      tops.push(y);
      y += r.height;
    }
    return tops;
  }, [rows]);
  const bodyHeight = rowTops.length > 0
    ? rowTops[rowTops.length - 1] + rows[rows.length - 1].height
    : 0;

  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const drawerTask = drawerTaskId ? tasks.find((t) => t.task.id === drawerTaskId) : null;

  return (
    <div>
      {/* Toolbar — zoom presets */}
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11.5px] text-ink-3">
          {tasks.length} task{tasks.length === 1 ? "" : "s"} · {milestones.length} milestone
          {milestones.length === 1 ? "" : "s"}
        </p>
        <div className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface">
          {(Object.keys(ZOOM_PRESETS) as Zoom[]).map((z) => {
            const active = z === zoom;
            return (
              <button
                key={z}
                type="button"
                onClick={() => setZoom(z)}
                className={cn(
                  "border-l border-border-strong px-2.5 py-1 text-[11.5px] font-medium first:border-l-0",
                  active
                    ? "bg-ink text-surface"
                    : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
                )}
              >
                {ZOOM_PRESETS[z].label}
              </button>
            );
          })}
        </div>
      </div>

      {tasks.length === 0 && milestones.length === 0 ? (
        <div className="rounded-lg border border-border-strong bg-surface px-5 py-10 text-center text-[12.5px] text-ink-3">
          No dated tasks or milestones. Add a deadline or due date to plot them on the timeline.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-strong bg-surface">
          <div className="flex">
            {/* Left column — task labels */}
            <div
              className="flex-shrink-0 border-r border-border-strong bg-surface"
              style={{ width: LEFT_COL }}
            >
              <div
                className="border-b border-border-strong bg-surface-2 px-3 py-2 text-[11.5px] font-semibold text-ink-2"
                style={{ height: HEADER_HEIGHT }}
              >
                Tasks
              </div>
              <div
                style={{ height: MILESTONE_TRACK_HEIGHT }}
                className="border-b border-border bg-surface-2/40 px-3 py-1 text-[10.5px] uppercase tracking-wider text-ink-4"
              >
                Milestones
              </div>
              {rows.map((r, i) =>
                r.kind === "header" ? (
                  <div
                    key={`hdr-${i}`}
                    className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-3"
                    style={{ height: r.height }}
                  >
                    <span className="truncate" title={r.label}>{r.label}</span>
                  </div>
                ) : (
                  <div
                    key={r.task!.task.id}
                    className="flex cursor-pointer items-center gap-2 border-b border-border px-3 text-[12px] hover:bg-surface-2"
                    style={{ height: r.height }}
                    onClick={() => setDrawerTaskId(r.task!.task.id)}
                  >
                    {r.task!.task.owner ? (
                      <span
                        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-zinc-300 text-[8px] font-bold text-white"
                        title={r.task!.task.owner}
                      >
                        {initials(r.task!.task.owner)}
                      </span>
                    ) : (
                      <span className="h-4 w-4 flex-shrink-0" />
                    )}
                    <span className="truncate text-ink-2" title={r.task!.task.title}>
                      {r.task!.task.title}
                    </span>
                  </div>
                ),
              )}
            </div>

            {/* Right side — gantt grid */}
            <div className="relative" style={{ width: totalWidth }}>
              {/* Axis header */}
              <div
                className="relative border-b border-border-strong bg-surface-2"
                style={{ height: HEADER_HEIGHT }}
              >
                {ticks.major.map((t) => (
                  <div
                    key={`maj-${t.date.toISOString()}`}
                    className="absolute top-0 flex h-[28px] items-center border-l border-border-strong px-1.5 text-[11px] font-semibold text-ink-2"
                    style={{ left: xOf(t.date), width: t.width }}
                  >
                    <span className="truncate">{t.label}</span>
                  </div>
                ))}
                {ticks.minor.map((t) => (
                  <div
                    key={`min-${t.date.toISOString()}`}
                    className="absolute flex h-[28px] items-center border-l border-border px-1 text-[10px] text-ink-3"
                    style={{ top: 28, left: xOf(t.date), width: t.width }}
                  >
                    <span className="truncate">{t.label}</span>
                  </div>
                ))}
              </div>

              {/* Milestone track */}
              <div
                className="relative border-b border-border bg-surface-2/40"
                style={{ height: MILESTONE_TRACK_HEIGHT }}
              >
                {milestones.map((m) => (
                  <button
                    key={m.milestone.id}
                    type="button"
                    title={`${m.milestone.title} · ${format(m.due, "MMM d, yyyy")}`}
                    onClick={() => {
                      const t = tasks.find((x) => x.milestone.id === m.milestone.id);
                      if (t) setDrawerTaskId(t.task.id);
                    }}
                    className="absolute -translate-x-1/2 hover:scale-110"
                    style={{ left: xOf(m.due) + dayWidth / 2, top: 4 }}
                  >
                    <Diamond />
                  </button>
                ))}
              </div>

              {/* Body — grid lines + group bands + bars */}
              <div className="relative" style={{ height: bodyHeight }}>
                {/* Vertical grid lines from major ticks */}
                {ticks.major.map((t) => (
                  <div
                    key={`gl-${t.date.toISOString()}`}
                    className="absolute top-0 bottom-0 border-l border-border"
                    style={{ left: xOf(t.date) }}
                  />
                ))}

                {/* Group-header bands (shaded full-width strip behind labels) */}
                {rows.map((r, i) =>
                  r.kind === "header" ? (
                    <div
                      key={`band-${i}`}
                      className="absolute left-0 right-0 border-b border-border bg-surface-2/60"
                      style={{ top: rowTops[i], height: r.height }}
                    />
                  ) : null,
                )}

                {/* Today guideline */}
                {!isBefore(today, range.start) && !isAfter(today, range.end) ? (
                  <div
                    className="absolute top-0 bottom-0 z-10 w-px bg-red-400"
                    style={{ left: xOf(today) }}
                    title="Today"
                  />
                ) : null}

                {/* Bars */}
                {rows.map((r, i) => {
                  if (r.kind !== "task") return null;
                  const t = r.task!;
                  const left = xOf(t.start);
                  const spanDays = differenceInCalendarDays(t.end, t.start) + 1;
                  const width = Math.max(18, spanDays * dayWidth);
                  const closed = ["done", "complete", "completed", "cancelled", "canceled"].includes(
                    t.task.status.toLowerCase(),
                  );
                  const overdue = !closed && isBefore(t.end, today);
                  return (
                    <button
                      key={t.task.id}
                      type="button"
                      onClick={() => setDrawerTaskId(t.task.id)}
                      title={`${t.task.title}\n${format(t.start, "MMM d")} – ${format(t.end, "MMM d, yyyy")}`}
                      className={cn(
                        "absolute flex h-[18px] cursor-pointer items-center overflow-hidden rounded-sm px-1.5 text-[10.5px] font-medium hover:brightness-95 hover:ring-1 hover:ring-accent",
                        overdue
                          ? "bg-red-200 text-red-900"
                          : closed
                            ? "bg-emerald-200 text-emerald-900"
                            : "bg-blue-200 text-blue-900",
                        t.pointInTime && "rounded-full",
                      )}
                      style={{
                        top: rowTops[i] + (ROW_HEIGHT - 18) / 2,
                        left,
                        width,
                      }}
                    >
                      <span className="truncate">{t.task.title}</span>
                    </button>
                  );
                })}

                {/* Row separators — task rows only (headers carry their own border) */}
                {rows.map((r, i) =>
                  r.kind === "task" ? (
                    <div
                      key={`sep-${i}`}
                      className="absolute left-0 right-0 border-b border-border"
                      style={{ top: rowTops[i] + r.height }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {drawerTask ? (
        <TaskDrawer
          task={drawerTask.task}
          milestone={drawerTask.milestone}
          workstream={drawerTask.workstream}
          projectId={detail.id}
          canEdit={canEdit}
          onClose={() => setDrawerTaskId(null)}
        />
      ) : null}
    </div>
  );
}

function Diamond() {
  return (
    <span
      aria-hidden
      className="block h-3 w-3 rotate-45 bg-amber-500 ring-2 ring-amber-200"
    />
  );
}

interface Tick {
  date: Date;
  label: string;
  width: number;
}

function generateTicks(start: Date, end: Date, zoom: Zoom): { major: Tick[]; minor: Tick[] } {
  const { dayWidth } = ZOOM_PRESETS[zoom];
  const major: Tick[] = [];
  const minor: Tick[] = [];

  if (zoom === "weeks") {
    let cursor = startOfMonth(start);
    while (cursor <= end) {
      const next = startOfMonth(addMonths(cursor, 1));
      const spanStart = max([cursor, start]);
      const spanEnd = min([addDays(next, -1), end]);
      const width = (differenceInCalendarDays(spanEnd, spanStart) + 1) * dayWidth;
      major.push({ date: spanStart, label: format(cursor, "MMM yyyy"), width });
      cursor = next;
    }
    let wkCursor = startOfWeek(start, { weekStartsOn: 1 });
    while (wkCursor <= end) {
      minor.push({ date: wkCursor, label: format(wkCursor, "MMM d"), width: 7 * dayWidth });
      wkCursor = addWeeks(wkCursor, 1);
    }
  } else if (zoom === "months") {
    let cursor = startOfQuarter(start);
    while (cursor <= end) {
      const next = startOfQuarter(addQuarters(cursor, 1));
      const spanStart = max([cursor, start]);
      const spanEnd = min([endOfQuarter(cursor), end]);
      const width = (differenceInCalendarDays(spanEnd, spanStart) + 1) * dayWidth;
      major.push({ date: spanStart, label: format(cursor, "QQQ yyyy"), width });
      cursor = next;
    }
    let monCursor = startOfMonth(start);
    while (monCursor <= end) {
      const spanStart = max([monCursor, start]);
      const spanEnd = min([endOfMonth(monCursor), end]);
      const width = (differenceInCalendarDays(spanEnd, spanStart) + 1) * dayWidth;
      minor.push({ date: spanStart, label: format(monCursor, "MMM"), width });
      monCursor = addMonths(monCursor, 1);
    }
  } else {
    // quarters: Major = year, Minor = quarter
    let cursor = new Date(start.getFullYear(), 0, 1);
    while (cursor <= end) {
      const next = new Date(cursor.getFullYear() + 1, 0, 1);
      const spanStart = max([cursor, start]);
      const spanEnd = min([addDays(next, -1), end]);
      const width = (differenceInCalendarDays(spanEnd, spanStart) + 1) * dayWidth;
      major.push({ date: spanStart, label: format(cursor, "yyyy"), width });
      cursor = next;
    }
    let qCursor = startOfQuarter(start);
    while (qCursor <= end) {
      const spanStart = max([qCursor, start]);
      const spanEnd = min([endOfQuarter(qCursor), end]);
      const width = (differenceInCalendarDays(spanEnd, spanStart) + 1) * dayWidth;
      minor.push({ date: spanStart, label: format(qCursor, "QQQ"), width });
      qCursor = startOfQuarter(addQuarters(qCursor, 1));
    }
  }

  return { major, minor };
}
