import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  addDays,
  addMonths,
  addQuarters,
  addWeeks,
  differenceInCalendarDays,
  endOfMonth,
  endOfQuarter,
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
import { MilestoneDrawer } from "@/components/project/MilestoneDrawer";
import { WorkstreamDrawer } from "@/components/project/WorkstreamDrawer";
import {
  taskMatchesFilter,
  type ProjectFilter,
} from "@/components/project/ProjectSubToolbar";

// ── Dimensions ─────────────────────────────────────────────────────────
const ROW_HEIGHT = 28;
const GROUP_HEADER_HEIGHT = 28;
const SUBGROUP_HEADER_HEIGHT = 26;
const HEADER_HEIGHT = 56;
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

  // Milestones default collapsed so the workstream rollup is the
  // overview; users expand individual milestones to drill in.
  function isMsCollapsed(msId: string) {
    const explicit = explicitMsState.get(msId);
    if (explicit !== undefined) return explicit;
    return true;
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
  }, [tasks, detail.workstreams, collapsedWs, explicitMsState]);

  // ── Date axis ─────────────────────────────────────────────────────────
  // Align range start/end to the *major* tick boundary at the current
  // zoom: weeks→month, months→quarter, quarters→year. This makes
  // every major AND minor tick the same width, and prevents scrolling
  // past the data range into empty padded columns.
  const range = useMemo(() => {
    const dates: Date[] = [today];
    for (const t of tasks) dates.push(t.start, t.end);
    for (const m of milestones) dates.push(m.due);
    const minPadded = addDays(min(dates), -15);
    const maxPadded = addDays(max(dates), 15);
    if (zoom === "weeks") {
      return {
        start: startOfMonth(minPadded),
        end: endOfMonth(maxPadded),
      };
    }
    if (zoom === "months") {
      return {
        start: startOfQuarter(minPadded),
        end: endOfQuarter(maxPadded),
      };
    }
    // quarters → year boundaries
    return {
      start: new Date(minPadded.getFullYear(), 0, 1),
      end: new Date(maxPadded.getFullYear() + 1, 0, 1),
    };
  }, [tasks, milestones, today, zoom]);

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

  // Center the viewport on today whenever the zoom or date range
  // changes (which includes initial mount). The user can scroll
  // wherever afterwards — we only re-center on those triggers.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const todayX = xOf(today);
    const target = Math.max(0, LEFT_COL + todayX - (el.clientWidth - LEFT_COL) / 2);
    el.scrollLeft = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, range.start.getTime(), totalWidth]);

  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const drawerTask = drawerTaskId ? tasks.find((t) => t.task.id === drawerTaskId) : null;
  const [drawerWsId, setDrawerWsId] = useState<string | null>(null);
  const drawerWs = drawerWsId ? detail.workstreams.find((w) => w.id === drawerWsId) : null;
  const [drawerMsId, setDrawerMsId] = useState<string | null>(null);
  const drawerMsContext = (() => {
    if (!drawerMsId) return null;
    for (const ws of detail.workstreams) {
      const ms = ws.milestones.find((m) => m.id === drawerMsId);
      if (ms) return { ws, ms };
    }
    return null;
  })();

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
          ref={scrollRef}
          className="overflow-auto rounded-lg border border-border-strong bg-surface"
          style={{ height: VIEW_HEIGHT }}
        >
          <div
            className="relative"
            style={{ width: LEFT_COL + totalWidth, minHeight: "100%" }}
          >
            {/* Sticky top header — date axis only */}
            <div
              className="sticky top-0 z-20 flex bg-surface-2"
              style={{ height: HEADER_HEIGHT }}
            >
              <div
                className="sticky left-0 z-30 flex flex-shrink-0 items-center border-b border-r border-border-strong bg-surface-2 px-3 text-[11.5px] font-semibold text-ink-2"
                style={{ width: LEFT_COL, height: HEADER_HEIGHT }}
              >
                Tasks
              </div>

              <div className="relative flex-shrink-0 border-b border-border-strong" style={{ width: totalWidth, height: HEADER_HEIGHT }}>
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
                      <div
                        key={`ws-${r.wsId}-${i}`}
                        className="flex w-full items-center border-b border-border bg-surface-2/80 text-[12px] font-semibold text-ink-2"
                        style={{ height: r.height }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleWs(r.wsId)}
                          aria-label={collapsed ? "Expand workstream" : "Collapse workstream"}
                          className="flex h-full items-center justify-center px-2 text-ink-3 hover:bg-surface-2 hover:text-ink"
                        >
                          {collapsed ? (
                            <ChevronRight size={13} />
                          ) : (
                            <ChevronDown size={13} />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDrawerWsId(r.wsId)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-1 text-left hover:text-accent-ink hover:underline"
                          title="Open workstream details"
                        >
                          <span className="truncate">{r.label}</span>
                        </button>
                        <span className="px-2 text-[10.5px] font-normal text-ink-4">
                          {r.span?.count ?? 0}
                        </span>
                      </div>
                    );
                  }
                  if (r.kind === "milestone-header") {
                    const collapsed = isMsCollapsed(r.msId);
                    return (
                      <div
                        key={`ms-${r.msId}-${i}`}
                        className="flex w-full items-center border-b border-border bg-surface text-[11.5px] text-ink-3"
                        style={{ height: r.height }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleMs(r.msId)}
                          aria-label={collapsed ? "Expand milestone" : "Collapse milestone"}
                          className="flex h-full items-center justify-center px-2 pl-6 text-ink-4 hover:bg-surface-2 hover:text-ink"
                        >
                          {collapsed ? (
                            <ChevronRight size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDrawerMsId(r.msId)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 truncate px-1 text-left hover:text-accent-ink hover:underline"
                          title="Open milestone details"
                        >
                          <span className="truncate">{r.label}</span>
                        </button>
                        <span className="px-2 text-[10.5px] text-ink-4">
                          {r.span?.count ?? 0}
                        </span>
                      </div>
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

      {drawerWs ? (
        <WorkstreamDrawer
          workstream={drawerWs}
          projectId={detail.id}
          canEdit={canEdit}
          onClose={() => setDrawerWsId(null)}
          onOpenMilestone={(m) => {
            setDrawerWsId(null);
            setDrawerMsId(m.id);
          }}
        />
      ) : null}

      {drawerMsContext ? (
        <MilestoneDrawer
          milestone={drawerMsContext.ms}
          workstream={drawerMsContext.ws}
          projectId={detail.id}
          canEdit={canEdit}
          onClose={() => setDrawerMsId(null)}
          onOpenTask={(t) => {
            setDrawerMsId(null);
            setDrawerTaskId(t.id);
          }}
        />
      ) : null}
    </div>
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

  // Range is pre-aligned to the major tick boundary, so every tick
  // starts exactly at `start` and the last tick ends exactly at `end`.
  // No padding; no overflow past the data range.

  if (zoom === "weeks") {
    // Major = month; Minor = week.
    let cursor = start;
    while (cursor < end) {
      const next = addMonths(cursor, 1);
      const width = differenceInCalendarDays(next, cursor) * dayWidth;
      major.push({ date: cursor, label: format(cursor, "MMM yyyy"), width });
      cursor = next;
    }
    let wkCursor = startOfWeek(start, { weekStartsOn: 1 });
    while (wkCursor < end) {
      minor.push({ date: wkCursor, label: format(wkCursor, "MMM d"), width: 7 * dayWidth });
      wkCursor = addWeeks(wkCursor, 1);
    }
  } else if (zoom === "months") {
    // Major = quarter; Minor = month.
    let cursor = start;
    while (cursor < end) {
      const next = addQuarters(cursor, 1);
      const width = differenceInCalendarDays(next, cursor) * dayWidth;
      major.push({ date: cursor, label: format(cursor, "QQQ yyyy"), width });
      cursor = next;
    }
    let monCursor = start;
    while (monCursor < end) {
      const next = addMonths(monCursor, 1);
      const width = differenceInCalendarDays(next, monCursor) * dayWidth;
      minor.push({ date: monCursor, label: format(monCursor, "MMM"), width });
      monCursor = next;
    }
  } else {
    // Quarters zoom: Major = year; Minor = quarter.
    let cursor = start;
    while (cursor < end) {
      const next = new Date(cursor.getFullYear() + 1, 0, 1);
      const width = differenceInCalendarDays(next, cursor) * dayWidth;
      major.push({ date: cursor, label: format(cursor, "yyyy"), width });
      cursor = next;
    }
    let qCursor = start;
    while (qCursor < end) {
      const next = addQuarters(qCursor, 1);
      const width = differenceInCalendarDays(next, qCursor) * dayWidth;
      minor.push({ date: qCursor, label: format(qCursor, "QQQ"), width });
      qCursor = next;
    }
  }

  return { major, minor };
}
