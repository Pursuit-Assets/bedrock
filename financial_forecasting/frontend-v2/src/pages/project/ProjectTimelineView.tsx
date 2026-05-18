import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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

// ── Dimensions ─────────────────────────────────────────────────────────
const ROW_HEIGHT = 28;
const GROUP_HEADER_HEIGHT = 28;
const SUBGROUP_HEADER_HEIGHT = 26;
const HEADER_HEIGHT = 56;
const MILESTONE_TRACK_HEIGHT = 32;
const LEFT_COL = 320;
const VIEW_HEIGHT = 640; // fixed gantt height; bottom scrollbar is always reachable

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

interface Span {
  start: Date;
  end: Date;
  count: number;
  overdue: boolean;
}

type RowKind =
  | { kind: "workstream-header"; wsId: string; label: string; height: number; span?: Span }
  | { kind: "milestone-header"; wsId: string; msId: string; label: string; height: number; span?: Span }
  | { kind: "task"; height: number; task: TimelineTask };

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

function isClosed(status: string) {
  return ["done", "complete", "completed", "cancelled", "canceled"].includes(
    status.toLowerCase(),
  );
}

export function ProjectTimelineView({ detail, filter, canEdit }: ProjectTimelineViewProps) {
  const [zoom, setZoom] = useState<Zoom>("months");
  const { dayWidth } = ZOOM_PRESETS[zoom];

  const today = startOfDay(new Date());

  // Flatten + filter dated tasks.
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
    const wsAllowed = filter.workstreamIds.length === 0 ? null : new Set(filter.workstreamIds);
    const msAllowed = filter.milestoneIds.length === 0 ? null : new Set(filter.milestoneIds);
    const out: TimelineMilestone[] = [];
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

  // ── Collapse state ────────────────────────────────────────────────────
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set());
  const [explicitMsState, setExplicitMsState] = useState<Map<string, boolean>>(new Map());

  function toggleWs(id: string) {
    setCollapsedWs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Default milestone collapse depends on the active grouping:
  //   - workstream grouping → milestones default collapsed (the WS rollup is the overview)
  //   - milestone grouping  → milestones default expanded
  //   - none                → milestones default expanded (flat list look)
  function isMsCollapsed(msId: string) {
    const explicit = explicitMsState.get(msId);
    if (explicit !== undefined) return explicit;
    return filter.groupBy === "workstream";
  }

  function toggleMs(id: string) {
    const currentlyCollapsed = isMsCollapsed(id);
    setExplicitMsState((prev) => {
      const next = new Map(prev);
      next.set(id, !currentlyCollapsed);
      return next;
    });
  }

  // ── Build rows ────────────────────────────────────────────────────────
  const rows: RowKind[] = useMemo(() => {
    const out: RowKind[] = [];

    const byWs = new Map<string, Map<string, TimelineTask[]>>();
    for (const t of tasks) {
      if (!byWs.has(t.workstream.id)) byWs.set(t.workstream.id, new Map());
      const wsMap = byWs.get(t.workstream.id)!;
      if (!wsMap.has(t.milestone.id)) wsMap.set(t.milestone.id, []);
      wsMap.get(t.milestone.id)!.push(t);
    }

    const todayD = startOfDay(new Date());

    for (const ws of detail.workstreams) {
      const wsMap = byWs.get(ws.id);
      if (!wsMap) continue;
      const wsTasks = Array.from(wsMap.values()).flat();
      if (wsTasks.length === 0) continue;

      const wsSpan: Span = {
        start: min(wsTasks.map((t) => t.start)),
        end: max(wsTasks.map((t) => t.end)),
        count: wsTasks.length,
        overdue: wsTasks.some(
          (t) => !isClosed(t.task.status) && isBefore(t.end, todayD),
        ),
      };
      out.push({
        kind: "workstream-header",
        wsId: ws.id,
        label: ws.name,
        height: GROUP_HEADER_HEIGHT,
        span: wsSpan,
      });
      if (collapsedWs.has(ws.id)) continue;

      const msEntries = ws.milestones
        .map((m) => ({ ms: m, list: wsMap.get(m.id) }))
        .filter((e): e is { ms: ProjectMilestone; list: TimelineTask[] } => !!e.list && e.list.length > 0)
        .sort((a, b) => {
          const aMin = min(a.list.map((t) => t.start)).getTime();
          const bMin = min(b.list.map((t) => t.start)).getTime();
          return aMin - bMin;
        });

      for (const { ms, list } of msEntries) {
        const msSpan: Span = {
          start: min(list.map((t) => t.start)),
          end: max(list.map((t) => t.end)),
          count: list.length,
          overdue: list.some(
            (t) => !isClosed(t.task.status) && isBefore(t.end, todayD),
          ),
        };
        out.push({
          kind: "milestone-header",
          wsId: ws.id,
          msId: ms.id,
          label: ms.title,
          height: SUBGROUP_HEADER_HEIGHT,
          span: msSpan,
        });
        if (isMsCollapsed(ms.id)) continue;

        const sorted = [...list].sort((a, b) => {
          const aD = a.task.deadline ? new Date(a.task.deadline).getTime() : Infinity;
          const bD = b.task.deadline ? new Date(b.task.deadline).getTime() : Infinity;
          return aD - bD;
        });
        for (const t of sorted) out.push({ kind: "task", height: ROW_HEIGHT, task: t });
      }
    }
    return out;
  }, [tasks, detail.workstreams, collapsedWs, explicitMsState, filter.groupBy]);

  // ── Date axis ─────────────────────────────────────────────────────────
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
      {/* Toolbar — zoom + counts */}
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
        // Fixed-height scroll container — horizontal scrollbar sits at
        // the bottom of this box no matter how many tasks are listed.
        <div
          className="overflow-auto rounded-lg border border-border-strong bg-surface"
          style={{ height: VIEW_HEIGHT }}
        >
          <div
            className="relative"
            style={{ width: LEFT_COL + totalWidth, minHeight: "100%" }}
          >
            {/* Sticky top header (date axis + milestone diamond track) */}
            <div
              className="sticky top-0 z-20 flex bg-surface-2"
              style={{ height: HEADER_HEIGHT + MILESTONE_TRACK_HEIGHT }}
            >
              {/* Left header — sticky both axes */}
              <div
                className="sticky left-0 z-30 flex flex-col flex-shrink-0 border-r border-border-strong bg-surface-2"
                style={{ width: LEFT_COL }}
              >
                <div
                  className="border-b border-border-strong px-3 py-2 text-[11.5px] font-semibold text-ink-2"
                  style={{ height: HEADER_HEIGHT }}
                >
                  Tasks
                </div>
                <div
                  style={{ height: MILESTONE_TRACK_HEIGHT }}
                  className="border-b border-border bg-surface-2/40 px-3 py-1 text-[10.5px] uppercase tracking-wider text-ink-4"
                >
                  Milestone diamonds
                </div>
              </div>

              {/* Right header — date axis + milestone diamonds */}
              <div className="relative flex-shrink-0" style={{ width: totalWidth }}>
                <div className="relative" style={{ height: HEADER_HEIGHT }}>
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
              </div>
            </div>

            {/* Body rows */}
            <div className="flex" style={{ minHeight: bodyHeight }}>
              {/* Left labels — sticky left */}
              <div
                className="sticky left-0 z-10 flex flex-shrink-0 flex-col border-r border-border-strong bg-surface"
                style={{ width: LEFT_COL }}
              >
                {rows.map((r, i) => {
                  if (r.kind === "workstream-header") {
                    const collapsed = collapsedWs.has(r.wsId);
                    return (
                      <button
                        key={`ws-${r.wsId}-${i}`}
                        type="button"
                        onClick={() => toggleWs(r.wsId)}
                        className="flex w-full items-center gap-1.5 border-b border-border bg-surface-2/80 px-2 text-left text-[12px] font-semibold text-ink-2 hover:bg-surface-2"
                        style={{ height: r.height }}
                      >
                        {collapsed ? (
                          <ChevronRight size={13} className="text-ink-3" />
                        ) : (
                          <ChevronDown size={13} className="text-ink-3" />
                        )}
                        <span className="truncate">{r.label}</span>
                        <span className="ml-auto text-[10.5px] font-normal text-ink-4">
                          {r.span?.count ?? 0}
                        </span>
                      </button>
                    );
                  }
                  if (r.kind === "milestone-header") {
                    const collapsed = isMsCollapsed(r.msId);
                    return (
                      <button
                        key={`ms-${r.msId}-${i}`}
                        type="button"
                        onClick={() => toggleMs(r.msId)}
                        className="flex w-full items-center gap-1.5 border-b border-border bg-surface px-2 pl-6 text-left text-[11.5px] text-ink-3 hover:bg-surface-2"
                        style={{ height: r.height }}
                      >
                        {collapsed ? (
                          <ChevronRight size={11} className="text-ink-4" />
                        ) : (
                          <ChevronDown size={11} className="text-ink-4" />
                        )}
                        <span className="truncate">{r.label}</span>
                        <span className="ml-auto text-[10.5px] text-ink-4">
                          {r.span?.count ?? 0}
                        </span>
                      </button>
                    );
                  }
                  const t = r.task;
                  return (
                    <button
                      key={t.task.id}
                      type="button"
                      onClick={() => setDrawerTaskId(t.task.id)}
                      className="flex w-full items-center gap-2 border-b border-border bg-surface px-3 pl-8 text-left text-[12px] hover:bg-surface-2"
                      style={{ height: r.height }}
                    >
                      {t.task.owner ? (
                        <span
                          className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-zinc-300 text-[8px] font-bold text-white"
                          title={t.task.owner}
                        >
                          {initials(t.task.owner)}
                        </span>
                      ) : (
                        <span className="h-4 w-4 flex-shrink-0" />
                      )}
                      <span className="truncate text-ink-2" title={t.task.title}>
                        {t.task.title}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Right — gantt grid + bars */}
              <div className="relative flex-shrink-0" style={{ width: totalWidth, height: bodyHeight }}>
                {/* Vertical grid lines */}
                {ticks.major.map((t) => (
                  <div
                    key={`gl-${t.date.toISOString()}`}
                    className="absolute top-0 bottom-0 border-l border-border"
                    style={{ left: xOf(t.date) }}
                  />
                ))}

                {/* Today guideline */}
                {!isBefore(today, range.start) && !isAfter(today, range.end) ? (
                  <div
                    className="absolute top-0 bottom-0 z-10 w-px bg-red-400"
                    style={{ left: xOf(today) }}
                    title="Today"
                  />
                ) : null}

                {/* One row per RowKind — background + bar */}
                {rows.map((r, i) => {
                  const top = rowTops[i];
                  if (r.kind === "workstream-header" || r.kind === "milestone-header") {
                    const tone =
                      r.kind === "workstream-header" ? "bg-surface-2/60" : "bg-surface-2/30";
                    const rollupBarThickness = r.kind === "workstream-header" ? 8 : 6;
                    const rollupColor = r.span?.overdue
                      ? "bg-red-300/80"
                      : r.kind === "workstream-header"
                        ? "bg-accent/40"
                        : "bg-accent/30";
                    const span = r.span;
                    return (
                      <div
                        key={`row-${i}`}
                        className={cn("absolute left-0 border-b border-border", tone)}
                        style={{ top, height: r.height, width: totalWidth }}
                      >
                        {span ? (
                          <div
                            className={cn("absolute rounded-sm", rollupColor)}
                            style={{
                              top: (r.height - rollupBarThickness) / 2,
                              height: rollupBarThickness,
                              left: xOf(span.start),
                              width: Math.max(
                                14,
                                (differenceInCalendarDays(span.end, span.start) + 1) * dayWidth,
                              ),
                            }}
                            title={`${format(span.start, "MMM d")} – ${format(span.end, "MMM d, yyyy")} · ${span.count} task${span.count === 1 ? "" : "s"}`}
                          />
                        ) : null}
                      </div>
                    );
                  }

                  // Task row
                  const t = r.task;
                  const left = xOf(t.start);
                  const spanDays = differenceInCalendarDays(t.end, t.start) + 1;
                  const width = Math.max(18, spanDays * dayWidth);
                  const closed = isClosed(t.task.status);
                  const overdue = !closed && isBefore(t.end, today);
                  return (
                    <div
                      key={`row-${i}`}
                      className="absolute left-0 border-b border-border bg-surface"
                      style={{ top, height: r.height, width: totalWidth }}
                    >
                      <button
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
                          top: (ROW_HEIGHT - 18) / 2,
                          left,
                          width,
                        }}
                      >
                        <span className="truncate">{t.task.title}</span>
                      </button>
                    </div>
                  );
                })}
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
