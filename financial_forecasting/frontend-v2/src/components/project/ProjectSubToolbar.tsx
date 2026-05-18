import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ActiveUser, ProjectWorkstream } from "@/services/projects";
import type { ProjectView } from "@/components/project/ProjectViewSwitcher";
import { MultiSelect } from "@/components/project/MultiSelect";

export type StatusFilter = "all" | "open" | "done";
export type DueFilter = "all" | "this_week" | "overdue";
export type GroupBy = "none" | "status" | "workstream" | "milestone";

export interface ProjectFilter {
  q: string;
  status: StatusFilter;
  /** Quick-filter on task deadline. 'this_week' = tasks due in the
   *  current Mon–Sun window plus anything overdue. 'overdue' = strictly
   *  past-due open tasks. */
  due: DueFilter;
  /** Empty = anyone. */
  ownerIds: string[];
  /** Empty = all workstreams. */
  workstreamIds: string[];
  /** Empty = all milestones. */
  milestoneIds: string[];
  groupBy: GroupBy;
}

export const DEFAULT_FILTER: ProjectFilter = {
  q: "",
  status: "all",
  due: "all",
  ownerIds: [],
  workstreamIds: [],
  milestoneIds: [],
  // Board groups by status by default. The Timeline view doesn't read
  // this field — it always groups workstream → milestone.
  groupBy: "status",
};

export function isDefaultFilter(f: ProjectFilter): boolean {
  return (
    f.q === DEFAULT_FILTER.q &&
    f.status === DEFAULT_FILTER.status &&
    f.due === DEFAULT_FILTER.due &&
    f.ownerIds.length === 0 &&
    f.workstreamIds.length === 0 &&
    f.milestoneIds.length === 0
  );
}

interface ProjectSubToolbarProps {
  view: ProjectView;
  filter: ProjectFilter;
  onChange: (next: ProjectFilter) => void;
  owners: ActiveUser[];
  workstreams: ProjectWorkstream[];
  className?: string;
}

interface PillOption<V extends string> {
  value: V;
  label: string;
}

function Pills<V extends string>({
  ariaLabel,
  value,
  onChange,
  options,
}: {
  ariaLabel: string;
  value: V;
  onChange: (v: V) => void;
  options: PillOption<V>[];
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "border-l border-border-strong px-2.5 py-1 text-[11.5px] font-medium first:border-l-0",
              active
                ? "bg-ink text-surface"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function ProjectSubToolbar({
  view,
  filter,
  onChange,
  owners,
  workstreams,
  className,
}: ProjectSubToolbarProps) {
  const patch = (p: Partial<ProjectFilter>) => onChange({ ...filter, ...p });

  // Milestone options scope to the selected workstreams when any are
  // chosen; otherwise all milestones are listed (prefixed with their
  // workstream for context).
  const milestoneOptions = (() => {
    if (filter.workstreamIds.length > 0) {
      const set = new Set(filter.workstreamIds);
      return workstreams
        .filter((ws) => set.has(ws.id))
        .flatMap((ws) =>
          ws.milestones.map((m) => ({ value: m.id, label: m.title })),
        );
    }
    return workstreams.flatMap((ws) =>
      ws.milestones.map((m) => ({
        value: m.id,
        label: `${ws.name} · ${m.title}`,
      })),
    );
  })();

  const workstreamOptions = workstreams.map((ws) => ({
    value: ws.id,
    label: ws.name,
  }));

  const ownerOptions = owners.map((u) => ({
    value: u.id,
    label: u.display_name || u.email,
  }));

  // Group-by is only meaningful on Board. List has nothing to group;
  // Timeline always uses workstream → milestone hierarchy.
  const groupByOptions: { value: GroupBy; label: string }[] = [
    { value: "status", label: "Status" },
    { value: "workstream", label: "Workstream" },
    { value: "milestone", label: "Milestone" },
  ];

  // If the user picked an unsupported groupBy in some prior session and
  // is now on Board, normalize to "status".
  if (view === "board" && !groupByOptions.some((o) => o.value === filter.groupBy)) {
    queueMicrotask(() => patch({ groupBy: "status" }));
  }

  return (
    <div
      className={cn(
        "mt-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2",
        className,
      )}
    >
      <div className="relative">
        <Search
          size={12}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-4"
        />
        <input
          value={filter.q}
          onChange={(e) => patch({ q: e.target.value })}
          placeholder="Search tasks…"
          className="h-7 w-56 rounded border border-border-strong bg-surface pl-6 pr-6 text-[12px] outline-none focus:border-accent"
        />
        {filter.q ? (
          <button
            type="button"
            onClick={() => patch({ q: "" })}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      <Pills<StatusFilter>
        ariaLabel="Status"
        value={filter.status}
        onChange={(v) => patch({ status: v })}
        options={[
          { value: "all", label: "All" },
          { value: "open", label: "Open" },
          { value: "done", label: "Done" },
        ]}
      />

      <Pills<DueFilter>
        ariaLabel="Due"
        value={filter.due}
        onChange={(v) => patch({ due: v })}
        options={[
          { value: "all", label: "Any time" },
          { value: "this_week", label: "This week" },
          { value: "overdue", label: "Overdue" },
        ]}
      />

      <MultiSelect
        label="Workstreams"
        values={filter.workstreamIds}
        onChange={(next) =>
          // Clear stale milestones when workstream selection shrinks.
          patch({
            workstreamIds: next,
            milestoneIds: filter.milestoneIds.filter((mid) =>
              workstreams
                .filter((ws) => next.length === 0 || next.includes(ws.id))
                .some((ws) => ws.milestones.some((m) => m.id === mid)),
            ),
          })
        }
        options={workstreamOptions}
        width={240}
      />

      <MultiSelect
        label="Milestones"
        values={filter.milestoneIds}
        onChange={(next) => patch({ milestoneIds: next })}
        options={milestoneOptions}
        width={280}
      />

      <MultiSelect
        label="Owners"
        values={filter.ownerIds}
        onChange={(next) => patch({ ownerIds: next })}
        options={ownerOptions}
        width={240}
      />

      {view === "board" ? (
        <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
          Group by
          <select
            value={filter.groupBy}
            onChange={(e) => patch({ groupBy: e.target.value as GroupBy })}
            className="h-7 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] text-ink outline-none focus:border-accent"
          >
            {groupByOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/**
 * Returns true when a task matches the active filter. Shared by all three
 * views so they apply filters identically. Callers pass the milestone
 * and workstream context so the workstream/milestone filters can be
 * evaluated without re-walking the tree.
 */
export function taskMatchesFilter(
  task: { title: string; status: string; owner_ids: string[]; description: string | null; deadline?: string | null },
  milestone: { id: string },
  filter: ProjectFilter,
  workstreamId?: string,
): boolean {
  const ql = filter.q.trim().toLowerCase();
  if (ql) {
    const matchTitle = task.title.toLowerCase().includes(ql);
    const matchDesc = (task.description ?? "").toLowerCase().includes(ql);
    if (!matchTitle && !matchDesc) return false;
  }
  const done = ["done", "complete", "completed", "cancelled", "canceled"].includes(
    task.status.toLowerCase(),
  );
  if (filter.status !== "all") {
    if (filter.status === "done" && !done) return false;
    if (filter.status === "open" && done) return false;
  }
  if (filter.due !== "all") {
    // Closed tasks are excluded from both "this week" and "overdue" —
    // these filters are about what still needs attention.
    if (done) return false;
    if (!task.deadline) return false;
    const due = new Date(task.deadline);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Monday-anchored week (matches the gantt's startOfWeek option).
    const dow = todayStart.getDay(); // 0=Sun..6=Sat
    const daysSinceMon = (dow + 6) % 7;
    const weekStart = new Date(todayStart);
    weekStart.setDate(todayStart.getDate() - daysSinceMon);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7); // exclusive
    if (filter.due === "overdue") {
      if (!(due < todayStart)) return false;
    } else {
      // "this_week" = overdue OR within the current Mon–Sun window
      const isOverdue = due < todayStart;
      const isThisWeek = due >= weekStart && due < weekEnd;
      if (!isOverdue && !isThisWeek) return false;
    }
  }
  if (
    filter.ownerIds.length > 0 &&
    !filter.ownerIds.some((id) => task.owner_ids.includes(id))
  ) {
    return false;
  }
  if (
    filter.workstreamIds.length > 0 &&
    (!workstreamId || !filter.workstreamIds.includes(workstreamId))
  ) {
    return false;
  }
  if (
    filter.milestoneIds.length > 0 &&
    !filter.milestoneIds.includes(milestone.id)
  ) {
    return false;
  }
  return true;
}
