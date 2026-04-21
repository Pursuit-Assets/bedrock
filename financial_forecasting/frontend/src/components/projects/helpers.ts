import { parseISO, addDays, differenceInDays, format, isWeekend, eachDayOfInterval, startOfDay } from 'date-fns';
import type {
  Workstream, Milestone, ProjectTask, FlatTask, GanttRow,
  TaskStatus, FilterState, GanttZoom,
} from './types';

// ── Tree -> flat list ──

export function flattenTasks(workstreams: Workstream[]): FlatTask[] {
  const result: FlatTask[] = [];
  for (const ws of workstreams) {
    for (const m of ws.milestones) {
      for (const t of m.tasks) {
        result.push({
          ...t,
          workstreamId: ws.id,
          workstreamName: ws.name,
          milestoneId: m.id,
          milestoneTitle: m.title,
          milestonePriority: m.priority,
          milestoneStatus: m.status,
        });
      }
    }
  }
  return result;
}

// ── Group flat tasks by status ──

export function groupByStatus(tasks: FlatTask[]): Record<TaskStatus, FlatTask[]> {
  const groups: Record<TaskStatus, FlatTask[]> = {
    'Not Started': [],
    'In Progress': [],
    'Completed': [],
    'Blocked': [],
    'On Hold': [],
  };
  for (const t of tasks) {
    if (groups[t.status]) groups[t.status].push(t);
  }
  return groups;
}

// ── Progress helpers ──

export function getMilestoneProgress(m: Milestone): number {
  const total = m.tasks.length;
  const completed = m.tasks.filter((t) => t.status === 'Completed').length;
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

export function getWorkstreamProgress(ws: Workstream): number {
  let total = 0;
  let completed = 0;
  for (const m of ws.milestones) {
    for (const t of m.tasks) {
      total++;
      if (t.status === 'Completed') completed++;
    }
  }
  return total === 0 ? 0 : Math.round((completed / total) * 100);
}

// ── Date inference for tasks without dates ──

export function inferStartDate(task: ProjectTask): Date | null {
  if (task.startDate) return parseISO(task.startDate);
  if (task.deadline) return addDays(parseISO(task.deadline), -7);
  return null;
}

export function inferEndDate(task: ProjectTask): Date | null {
  if (task.deadline) return parseISO(task.deadline);
  if (task.startDate) return addDays(parseISO(task.startDate), 7);
  return null;
}

// ── Gantt row builder ──

export function buildGanttRows(workstreams: Workstream[], collapsedIds: Set<string>): GanttRow[] {
  const rows: GanttRow[] = [];

  for (const ws of workstreams) {
    const wsStart = getEarliestDate(ws);
    const wsEnd = getLatestDate(ws);
    const wsProgress = getWorkstreamProgress(ws);
    const wsCollapsed = collapsedIds.has(ws.id);

    rows.push({
      type: 'workstream',
      id: ws.id,
      label: ws.name,
      indent: 0,
      startDate: wsStart,
      endDate: wsEnd,
      status: '',
      progress: wsProgress,
      dependsOn: [],
      isCollapsed: wsCollapsed,
    });

    if (wsCollapsed) continue;

    for (const m of ws.milestones) {
      const mStart = getEarliestMilestoneDate(m);
      const mEnd = getLatestMilestoneDate(m);
      const mProgress = getMilestoneProgress(m);
      const mCollapsed = collapsedIds.has(m.id);

      rows.push({
        type: 'milestone',
        id: m.id,
        label: m.title,
        indent: 1,
        startDate: mStart,
        endDate: mEnd,
        status: m.status,
        progress: mProgress,
        dependsOn: [],
        isCollapsed: mCollapsed,
        owner: m.owner,
        ownerIds: m.owner_ids,
        milestonePriority: m.priority,
      });

      if (mCollapsed) continue;

      for (const t of m.tasks) {
        rows.push({
          type: 'task',
          id: t.id,
          label: t.title,
          indent: 2,
          startDate: inferStartDate(t),
          endDate: inferEndDate(t),
          status: t.status,
          progress: t.status === 'Completed' ? 100 : t.status === 'In Progress' ? 50 : 0,
          dependsOn: t.dependsOn || [],
          owner: t.owner,
          ownerIds: t.owner_ids,
        });
      }
    }
  }

  return rows;
}

function getEarliestDate(ws: Workstream): Date | null {
  let earliest: Date | null = null;
  for (const m of ws.milestones) {
    for (const t of m.tasks) {
      const d = inferStartDate(t);
      if (d && (!earliest || d < earliest)) earliest = d;
    }
  }
  return earliest;
}

function getLatestDate(ws: Workstream): Date | null {
  let latest: Date | null = null;
  for (const m of ws.milestones) {
    for (const t of m.tasks) {
      const d = inferEndDate(t);
      if (d && (!latest || d > latest)) latest = d;
    }
  }
  return latest;
}

function getEarliestMilestoneDate(m: Milestone): Date | null {
  let earliest: Date | null = null;
  for (const t of m.tasks) {
    const d = inferStartDate(t);
    if (d && (!earliest || d < earliest)) earliest = d;
  }
  return earliest;
}

function getLatestMilestoneDate(m: Milestone): Date | null {
  let latest: Date | null = null;
  for (const t of m.tasks) {
    const d = inferEndDate(t);
    if (d && (!latest || d > latest)) latest = d;
  }
  return latest;
}

// ── Timeline range ──

export function getTimelineRange(rows: GanttRow[]): { start: Date; end: Date; totalDays: number } {
  let earliest: Date | null = null;
  let latest: Date | null = null;

  for (const r of rows) {
    if (r.startDate && (!earliest || r.startDate < earliest)) earliest = r.startDate;
    if (r.endDate && (!latest || r.endDate > latest)) latest = r.endDate;
  }

  const start = earliest ? addDays(startOfDay(earliest), -7) : startOfDay(new Date());
  const end = latest ? addDays(startOfDay(latest), 14) : addDays(startOfDay(new Date()), 60);
  const totalDays = differenceInDays(end, start) + 1;

  return { start, end, totalDays };
}

// ── Pixel <-> date conversion ──

export function dateToPixel(date: Date, timelineStart: Date, dayWidth: number): number {
  return differenceInDays(startOfDay(date), startOfDay(timelineStart)) * dayWidth;
}

export function pixelToDate(px: number, timelineStart: Date, dayWidth: number): Date {
  return addDays(timelineStart, Math.round(px / dayWidth));
}

// ── Dependency edges ──

export interface DependencyEdge {
  fromId: string;
  toId: string;
  fromRowIndex: number;
  toRowIndex: number;
}

export function buildDependencyEdges(rows: GanttRow[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const idxMap = new Map<string, number>();
  rows.forEach((r, i) => idxMap.set(r.id, i));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.dependsOn) {
      for (const depId of row.dependsOn) {
        const fromIdx = idxMap.get(depId);
        if (fromIdx !== undefined) {
          edges.push({ fromId: depId, toId: row.id, fromRowIndex: fromIdx, toRowIndex: i });
        }
      }
    }
  }

  return edges;
}

// ── Filter helpers ──

export function applyFilters(workstreams: Workstream[], filters: FilterState): Workstream[] {
  let filtered = workstreams;

  if (filters.workstreams.length > 0) {
    filtered = filtered.filter(ws => filters.workstreams.includes(ws.id));
  }

  if (filters.owners.length > 0) {
    const selected = new Set(filters.owners);
    const ownerIdsMatch = (ids?: string[]): boolean =>
      (ids || []).some(id => selected.has(id));
    filtered = filtered.map(ws => ({
      ...ws,
      milestones: ws.milestones.map(m => ({
        ...m,
        tasks: m.tasks.filter(t => ownerIdsMatch(t.owner_ids)),
      })).filter(m => m.tasks.length > 0 || ownerIdsMatch(m.owner_ids)),
    })).filter(ws => ws.milestones.length > 0);
  }

  return filtered;
}

// ── Owner display helpers ──

export interface DisplayOwner {
  id: string;
  name: string;
}

export function resolveOwners(
  ownerIds: string[] | undefined,
  activeUsers: { id: string; display_name: string }[],
): DisplayOwner[] {
  if (!ownerIds || ownerIds.length === 0) return [];
  const idMap = new Map(activeUsers.map(u => [u.id, u.display_name]));
  return ownerIds
    .map(id => ({ id, name: idMap.get(id) || '' }))
    .filter(o => o.name !== '');
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0]!)
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

// ── Relative deadline formatting ──

export function formatRelativeDeadline(deadline: string): { text: string; color: string } {
  const d = parseISO(deadline);
  const today = startOfDay(new Date());
  const target = startOfDay(d);
  const diff = differenceInDays(target, today);

  if (diff === 0) return { text: 'today', color: '#f57c00' };
  if (diff > 0) return { text: `in ${diff}d`, color: diff <= 3 ? '#f57c00' : '#666' };
  return { text: `${Math.abs(diff)}d overdue`, color: '#e65100' };
}

// ── Weekend detection for Gantt grid ──

export function getWeekendOffsets(
  timelineStart: Date,
  totalDays: number,
  dayWidth: number
): number[] {
  const offsets: number[] = [];
  const days = eachDayOfInterval({
    start: timelineStart,
    end: addDays(timelineStart, totalDays - 1),
  });
  days.forEach((day, i) => {
    if (isWeekend(day)) {
      offsets.push(i * dayWidth);
    }
  });
  return offsets;
}
