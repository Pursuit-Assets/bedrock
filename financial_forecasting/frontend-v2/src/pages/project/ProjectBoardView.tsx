import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQueryClient } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { fmtDate, initials } from "@/lib/format";
import {
  useUpdateTask,
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

const STATUS_COLUMNS = ["Not Started", "In Progress", "Blocked", "Done"] as const;
type ColumnKey = (typeof STATUS_COLUMNS)[number];

const STATUS_COLOR: Record<ColumnKey, string> = {
  "Not Started": "bg-zinc-200 text-zinc-700",
  "In Progress": "bg-blue-100 text-blue-700",
  "Blocked": "bg-red-100 text-red-700",
  "Done": "bg-emerald-100 text-emerald-700",
};

const AVATAR_COLORS = [
  "bg-blue-400",
  "bg-purple-400",
  "bg-green-400",
  "bg-amber-400",
  "bg-rose-400",
  "bg-cyan-400",
] as const;

function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) ?? 0) % AVATAR_COLORS.length];
}

interface BoardTask {
  task: ProjectTask;
  milestone: ProjectMilestone;
  workstream: ProjectWorkstream;
}

interface ProjectBoardViewProps {
  detail: ProjectDetail;
  filter: ProjectFilter;
  canEdit: boolean;
}

function normalizeStatus(status: string): ColumnKey {
  const s = status.toLowerCase();
  if (s.includes("progress")) return "In Progress";
  if (s.includes("block")) return "Blocked";
  if (["done", "complete", "completed", "cancelled", "canceled"].includes(s)) return "Done";
  return "Not Started";
}

export function ProjectBoardView({ detail, filter, canEdit }: ProjectBoardViewProps) {
  const qc = useQueryClient();
  const updateTask = useUpdateTask(detail.id);

  const all: BoardTask[] = useMemo(() => {
    const out: BoardTask[] = [];
    for (const ws of detail.workstreams) {
      for (const ms of ws.milestones) {
        for (const t of ms.tasks) {
          out.push({ task: t, milestone: ms, workstream: ws });
        }
      }
    }
    return out;
  }, [detail]);

  const filteredTasks = useMemo(
    () =>
      all.filter(({ task, milestone, workstream }) =>
        taskMatchesFilter(task, milestone, filter, workstream.id),
      ),
    [all, filter],
  );

  // Group by the chosen dimension. v1 supports status (default) +
  // workstream + milestone — when grouping by status the columns are the
  // fixed kanban statuses; otherwise the column set is data-driven.
  const groups = useMemo(() => {
    if (filter.groupBy !== "workstream" && filter.groupBy !== "milestone") {
      const buckets: Record<string, BoardTask[]> = Object.fromEntries(
        STATUS_COLUMNS.map((s) => [s, []]),
      );
      for (const bt of filteredTasks) {
        buckets[normalizeStatus(bt.task.status)].push(bt);
      }
      return STATUS_COLUMNS.map((key) => ({
        key,
        label: key,
        kind: "status" as const,
        items: buckets[key],
      }));
    }
    if (filter.groupBy === "workstream") {
      return detail.workstreams.map((ws) => ({
        key: ws.id,
        label: ws.name,
        kind: "workstream" as const,
        items: filteredTasks.filter((bt) => bt.workstream.id === ws.id),
      }));
    }
    // milestone
    const all: { key: string; label: string; kind: "milestone"; items: BoardTask[] }[] = [];
    for (const ws of detail.workstreams) {
      for (const ms of ws.milestones) {
        all.push({
          key: ms.id,
          label: `${ws.name} · ${ms.title}`,
          kind: "milestone",
          items: filteredTasks.filter((bt) => bt.milestone.id === ms.id),
        });
      }
    }
    return all;
  }, [filteredTasks, filter.groupBy, detail.workstreams]);

  // ── DnD ──────────────────────────────────────────────────────────────
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeBoardTask = activeId ? all.find((bt) => bt.task.id === activeId) : null;

  function findContainer(taskId: string): string | undefined {
    for (const g of groups) {
      if (g.items.some((bt) => bt.task.id === taskId)) return g.key;
    }
    return undefined;
  }

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    if (!canEdit) return;
    const activeTaskId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId) return;

    // Only status grouping triggers a real mutation in v1 — workstream /
    // milestone grouping is read-only since changing a task's milestone
    // would require a different API surface.
    if (filter.groupBy === "workstream" || filter.groupBy === "milestone") return;

    const fromCol = findContainer(activeTaskId);
    // The "over" id is either a column key (dropped on empty area) or
    // another task's id (sorted within or across columns).
    let toCol: string | undefined;
    if (STATUS_COLUMNS.includes(overId as ColumnKey)) {
      toCol = overId;
    } else {
      toCol = findContainer(overId);
    }
    if (!toCol || !fromCol || toCol === fromCol) return;

    const bt = all.find((x) => x.task.id === activeTaskId);
    if (!bt) return;

    // Optimistic update — patch the cached detail so the card moves
    // immediately. Server confirms via invalidation in useUpdateTask.
    qc.setQueryData<ProjectDetail | undefined>(
      ["project-detail", detail.id],
      (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          workstreams: prev.workstreams.map((ws) => ({
            ...ws,
            milestones: ws.milestones.map((ms) => ({
              ...ms,
              tasks: ms.tasks.map((t) =>
                t.id === activeTaskId ? { ...t, status: toCol! } : t,
              ),
            })),
          })),
        };
      },
    );
    updateTask.mutate({ taskId: activeTaskId, patch: { status: toCol } });
  }

  // ── Drawer ───────────────────────────────────────────────────────────
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const drawerTask = drawerTaskId ? all.find((bt) => bt.task.id === drawerTaskId) : null;

  return (
    <div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {groups.map((g) => (
            <Column
              key={g.key}
              colKey={g.key}
              label={g.label}
              kind={g.kind}
              items={g.items}
              onOpen={(id) => setDrawerTaskId(id)}
            />
          ))}
        </div>

        <DragOverlay>
          {activeBoardTask ? (
            <Card bt={activeBoardTask} dragging />
          ) : null}
        </DragOverlay>
      </DndContext>

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

function Column({
  colKey,
  label,
  kind,
  items,
  onOpen,
}: {
  colKey: string;
  label: string;
  kind: "status" | "workstream" | "milestone";
  items: BoardTask[];
  onOpen: (taskId: string) => void;
}) {
  const { setNodeRef, isOver } = useSortable({ id: colKey });
  const headerStyle =
    kind === "status"
      ? STATUS_COLOR[label as ColumnKey] ?? "bg-zinc-200 text-zinc-700"
      : "bg-surface-2 text-ink-2";

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-[280px] flex-shrink-0 flex-col rounded-md border border-border-strong bg-surface-2",
        isOver && "ring-1 ring-accent",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between rounded-t-md px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wider",
          headerStyle,
        )}
      >
        <span className="truncate">{label}</span>
        <span className="rounded bg-surface/40 px-1.5 text-[10.5px]">
          {items.length}
        </span>
      </div>
      <SortableContext items={items.map((bt) => bt.task.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1.5 p-2">
          {items.map((bt) => (
            <SortableCard key={bt.task.id} bt={bt} onOpen={onOpen} />
          ))}
          {items.length === 0 ? (
            <div className="rounded border border-dashed border-border px-3 py-4 text-center text-[11.5px] text-ink-4">
              Drop tasks here
            </div>
          ) : null}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableCard({ bt, onOpen }: { bt: BoardTask; onOpen: (id: string) => void }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: bt.task.id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-0")}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(bt.task.id)}
    >
      <Card bt={bt} />
    </div>
  );
}

function Card({ bt, dragging }: { bt: BoardTask; dragging?: boolean }) {
  const { task, milestone, workstream } = bt;
  const overdue =
    !!task.deadline &&
    !["done", "complete", "completed", "cancelled", "canceled"].includes(
      task.status.toLowerCase(),
    ) &&
    new Date(task.deadline).getTime() < Date.now();

  return (
    <div
      className={cn(
        "cursor-pointer rounded border border-border-strong bg-surface px-3 py-2 text-[12px] shadow-sm hover:border-accent",
        dragging && "shadow-lg ring-1 ring-accent",
      )}
    >
      <p
        className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-4"
        title={workstream.name}
      >
        {workstream.name}
      </p>
      <p className="mt-1 line-clamp-2 font-medium leading-snug text-ink">{task.title}</p>
      <p className="mt-0.5 truncate text-[11px] text-ink-3" title={milestone.title}>
        {milestone.title}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {task.owner ? (
            <span
              className={cn(
                "flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white",
                avatarColor(task.owner),
              )}
              title={task.owner}
            >
              {initials(task.owner)}
            </span>
          ) : (
            <span className="text-[11px] text-ink-4">—</span>
          )}
        </div>
        {task.deadline ? (
          <span
            className={cn(
              "mono text-[10.5px]",
              overdue ? "font-semibold text-red-600" : "text-ink-3",
            )}
          >
            {fmtDate(task.deadline)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
