import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { BackLink as SharedBackLink } from "@/components/detail";
import { api } from "@/lib/api";
import { fmtDate, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useOpportunities } from "@/services/opportunities";
import type { SfOpportunity } from "@/types/salesforce";
import { useSalesforceStatus } from "@/services/auth";
import { DescriptionEditor } from "@/components/project/DescriptionEditor";
import { TaskDrawer } from "@/components/project/TaskDrawer";
import { MilestoneDrawer } from "@/components/project/MilestoneDrawer";
import { WorkstreamDrawer } from "@/components/project/WorkstreamDrawer";
import {
  ProjectViewSwitcher,
  useProjectView,
} from "@/components/project/ProjectViewSwitcher";
import {
  ProjectSubToolbar,
  DEFAULT_FILTER,
  isDefaultFilter,
  taskMatchesFilter,
  type ProjectFilter,
} from "@/components/project/ProjectSubToolbar";
import { ProjectBoardView } from "@/pages/project/ProjectBoardView";
import { ProjectTimelineView } from "@/pages/project/ProjectTimelineView";
import { useContacts } from "@/services/contacts";
import { useAwards } from "@/services/awards";
import { usePerm } from "@/services/permissions";
import {
  useActiveUsers,
  useCreateMilestone,
  useCreateTask,
  useCreateWorkstream,
  useDeleteMilestone,
  useDeleteTask,
  useDeleteWorkstream,
  useProjectDetail,
  useUpdateMilestone,
  useUpdateProject,
  useUpdateTask,
  useUpdateWorkstream,
  type ActiveUser,
  type ProjectMilestone,
  type ProjectTask,
  type ProjectWorkstream,
} from "@/services/projects";

// ── Types ─────────────────────────────────────────────────────────────────────

// ── Hooks ─────────────────────────────────────────────────────────────────────



function useProjectContacts(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-contacts", projectId],
    queryFn: async () => {
      const { data } = await api.get<{ data: { id: string; contact_id: string }[] }>(
        `/api/projects/${projectId}/contacts`,
      );
      return data.data ?? [];
    },
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

function useProjectAwards(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-awards", projectId],
    queryFn: async () => {
      const { data } = await api.get<{ data: any[] }>(
        `/api/projects/${projectId}/awards`,
      );
      return data.data ?? [];
    },
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

function useProjectOpportunities(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-opportunities", projectId],
    queryFn: async () => {
      const { data } = await api.get<{ data: { id: string; opportunity_id: string; role?: string }[] }>(
        `/api/projects/${projectId}/opportunities`,
      );
      return data.data ?? [];
    },
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DONE_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "cancelled",
  "canceled",
]);

function isClosedStatus(status: string) {
  return DONE_STATUSES.has(status.toLowerCase());
}

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

const STATUS_OPTIONS = [
  "Not Started",
  "In Progress",
  "Blocked",
  "Done",
  "Cancelled",
] as const;

/**
 * Text chip color for task statuses on the list view. Intuitive
 * mapping: grey = Not Started, blue = In Progress, red = Blocked,
 * green = Done. Cancelled gets muted grey with strikethrough.
 */
function statusChipClass(status: string): string {
  const s = (status ?? "").toLowerCase();
  if (s === "blocked") return "bg-red-100 text-red-700 border border-red-200";
  if (s === "in progress" || s === "in_progress") {
    return "bg-blue-100 text-blue-700 border border-blue-200";
  }
  if (s === "done" || s === "complete" || s === "completed") {
    return "bg-emerald-100 text-emerald-700 border border-emerald-200";
  }
  if (s === "cancelled" || s === "canceled") {
    return "bg-zinc-100 text-zinc-400 border border-zinc-200 line-through";
  }
  // Not Started / unknown — neutral grey.
  return "bg-zinc-100 text-zinc-600 border border-zinc-200";
}

function useOutsideClick(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose]);
}

// ── StatusDot ─────────────────────────────────────────────────────────────────

function StatusDot({
  status,
  canEdit,
  onSelect,
}: {
  status: string;
  canEdit: boolean;
  onSelect: (s: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false));

  return (
    <div ref={ref} className="relative flex items-center justify-start">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => canEdit && setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center justify-center rounded px-1.5 py-px text-[10.5px] font-medium",
          statusChipClass(status),
          canEdit && "cursor-pointer hover:ring-1 hover:ring-accent",
        )}
        title={canEdit ? `${status} — click to change` : status}
      >
        {status || "Not Started"}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-border-strong bg-surface shadow-lg">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
              onClick={() => {
                onSelect(opt);
                setOpen(false);
              }}
            >
              <span
                className={cn(
                  "inline-flex items-center rounded px-1.5 py-px text-[10.5px] font-medium",
                  statusChipClass(opt),
                )}
              >
                {opt}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── OwnerPicker ───────────────────────────────────────────────────────────────

function OwnerPicker({
  currentOwner,
  onSelect,
  onClose,
}: {
  currentOwner: string | null;
  onSelect: (user: ActiveUser | null) => void;
  onClose: () => void;
}) {
  const { data: users = [] } = useActiveUsers();
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, onClose);

  const filtered = users.filter(
    (u) =>
      u.display_name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-50 mt-1 w-52 rounded-md border border-border-strong bg-surface shadow-lg"
    >
      <div className="border-b border-border-strong p-1.5">
        <input
          autoFocus
          type="text"
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded bg-surface-2 px-2 py-1 text-[12px] outline-none placeholder:text-ink-4"
        />
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-3 hover:bg-surface-2"
          onClick={() => { onSelect(null); onClose(); }}
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[10px] text-ink-4">
            <X size={10} />
          </span>
          No owner
        </button>
        {filtered.map((u) => (
          <button
            key={u.id}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2",
              u.display_name === currentOwner && "bg-surface-2",
            )}
            onClick={() => { onSelect(u); onClose(); }}
          >
            <span
              className={cn(
                "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                avatarColor(u.display_name),
              )}
            >
              {initials(u.display_name)}
            </span>
            <span className="truncate">{u.display_name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── TaskRow ───────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  canEdit,
  projectId,
  onOpenDrawer,
}: {
  task: ProjectTask;
  canEdit: boolean;
  projectId: string;
  onOpenDrawer: () => void;
}) {
  const updateTask = useUpdateTask(projectId);
  const deleteTask = useDeleteTask(projectId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleVal, setTitleVal] = useState(task.title);
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Description expand is row-local — empty-and-noneditable hides the
  // chevron entirely; otherwise click toggles the description sub-row.
  const hasDescription = (task.description ?? "").trim().length > 0;
  const [descOpen, setDescOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const ownerRef = useRef<HTMLDivElement>(null);

  useOutsideClick(actionsRef, () => setActionsOpen(false));

  const closed = isClosedStatus(task.status ?? "");
  const overdue =
    !closed &&
    !!task.deadline &&
    !Number.isNaN(new Date(task.deadline).getTime()) &&
    new Date(task.deadline).getTime() < Date.now();

  function commitTitle() {
    const trimmed = titleVal.trim();
    if (trimmed && trimmed !== task.title) {
      updateTask.mutate({ taskId: task.id, patch: { title: trimmed } });
    } else {
      setTitleVal(task.title);
    }
    setEditingTitle(false);
  }

  function commitDate(val: string) {
    updateTask.mutate({ taskId: task.id, patch: { deadline: val || null } });
    setEditingDate(false);
  }

  return (
    <div className="group border-b border-border-strong last:border-b-0 hover:bg-surface-2/60">
    <div className="grid grid-cols-[110px_1fr_160px_110px_32px] items-center">
      {/* Status chip */}
      <div className="flex items-center justify-start px-2">
        <StatusDot
          status={task.status ?? "Not Started"}
          canEdit={canEdit}
          onSelect={(s) => updateTask.mutate({ taskId: task.id, patch: { status: s } })}
        />
      </div>

      {/* Title (+ description toggle on hover when collapsed) */}
      <div className="flex min-w-0 items-center gap-1 py-2 pr-2">
        {(hasDescription || canEdit) ? (
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            title={descOpen ? "Hide description" : (hasDescription ? "Show description" : "Add description")}
            className={cn(
              "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-ink-4 hover:bg-surface-2 hover:text-ink",
              hasDescription ? "opacity-100" : "opacity-0 group-hover:opacity-60",
              descOpen && "opacity-100 text-ink-2",
            )}
          >
            {descOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="h-4 w-4 flex-shrink-0" />
        )}
        {editingTitle && canEdit ? (
          <input
            autoFocus
            type="text"
            value={titleVal}
            onChange={(e) => setTitleVal(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") { setTitleVal(task.title); setEditingTitle(false); }
            }}
            className="w-full rounded bg-surface-2 px-1.5 py-0.5 text-[13px] outline-none ring-1 ring-accent"
          />
        ) : (
          <button
            type="button"
            className={cn(
              "block min-w-0 flex-1 cursor-pointer truncate rounded px-1 text-left text-[13px] hover:bg-black/[0.03] hover:text-accent-ink",
              closed && "text-ink-3 line-through",
            )}
            onClick={onOpenDrawer}
            title="Open task details"
          >
            {task.title}
          </button>
        )}
      </div>

      {/* Owner */}
      <div ref={ownerRef} className="relative flex items-center py-2 pr-2">
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => canEdit && setOwnerPickerOpen((o) => !o)}
          className={cn(
            "flex min-w-0 items-center gap-1.5 text-left",
            canEdit && "hover:opacity-80",
          )}
        >
          {task.owner ? (
            <>
              <span
                className={cn(
                  "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                  avatarColor(task.owner),
                )}
              >
                {initials(task.owner)}
              </span>
              <span className="truncate text-[12px] text-ink-2">{task.owner}</span>
            </>
          ) : (
            <span className="text-[12px] text-ink-4">—</span>
          )}
        </button>
        {ownerPickerOpen && (
          <OwnerPicker
            currentOwner={task.owner}
            onSelect={(user) => {
              updateTask.mutate({
                taskId: task.id,
                patch: user
                  ? { owner: user.display_name, owner_ids: [user.id] }
                  : { owner: undefined, owner_ids: [] },
              });
            }}
            onClose={() => setOwnerPickerOpen(false)}
          />
        )}
      </div>

      {/* Due date */}
      <div className="flex items-center py-2 pr-2">
        {editingDate && canEdit ? (
          <input
            autoFocus
            type="date"
            defaultValue={task.deadline?.slice(0, 10) ?? ""}
            onBlur={(e) => commitDate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDate((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setEditingDate(false);
            }}
            className="w-full rounded bg-surface-2 px-1 py-0.5 text-[12px] outline-none ring-1 ring-accent"
          />
        ) : (
          <span
            className={cn(
              "mono block truncate text-[12px]",
              overdue ? "font-semibold text-red-600" : "text-ink-3",
              canEdit && "cursor-pointer hover:text-ink",
            )}
            onClick={() => canEdit && setEditingDate(true)}
          >
            {task.deadline ? fmtDate(task.deadline) : "—"}
          </span>
        )}
      </div>

      {/* Actions */}
      <div ref={actionsRef} className="relative flex items-center justify-center">
        {canEdit && (
          <>
            <button
              type="button"
              onClick={() => setActionsOpen((o) => !o)}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-4 opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-ink"
            >
              <MoreHorizontal size={14} />
            </button>
            {actionsOpen && (
              <div className="absolute right-0 top-full z-50 min-w-[140px] rounded-md border border-border-strong bg-surface shadow-lg">
                <button
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
                  onClick={() => {
                    setEditingTitle(true);
                    setActionsOpen(false);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-surface-2"
                  onClick={() => {
                    deleteTask.mutate(task.id);
                    setActionsOpen(false);
                  }}
                >
                  <Trash2 size={12} />
                  Delete
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    {/* Task description sub-row — expanded inline editor. Indents to
        align with the title column above. */}
    {descOpen ? (
      <div className="border-t border-border bg-surface px-[126px] py-2">
        <DescriptionEditor
          value={task.description}
          canEdit={canEdit}
          placeholder="Add description"
          compact
          onSave={(d) =>
            new Promise<void>((resolve, reject) =>
              updateTask.mutate(
                { taskId: task.id, patch: { description: d } },
                { onSuccess: () => resolve(), onError: (e) => reject(e) },
              ),
            )
          }
        />
      </div>
    ) : null}
    </div>
  );
}

// ── AddTaskRow ────────────────────────────────────────────────────────────────

function AddTaskRow({
  milestoneId,
  projectId,
}: {
  milestoneId: string;
  projectId: string;
}) {
  const createTask = useCreateTask(projectId);
  const [active, setActive] = useState(false);
  const [val, setVal] = useState("");

  function commit() {
    const trimmed = val.trim();
    if (trimmed) {
      createTask.mutate({ milestoneId, title: trimmed });
    }
    setVal("");
    setActive(false);
  }

  if (!active) {
    return (
      <div className="grid grid-cols-[36px_1fr_160px_110px_32px] border-b border-border-strong hover:bg-surface-2/40 last:border-b-0">
        <div />
        <button
          type="button"
          onClick={() => setActive(true)}
          className="py-1.5 text-left text-[12px] text-ink-4 hover:text-ink-3"
        >
          + Add a task
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[36px_1fr_160px_110px_32px] items-center border-b border-border-strong last:border-b-0">
      <div />
      <div className="col-span-3 py-1.5 pr-2">
        <input
          autoFocus
          type="text"
          placeholder="Task name…"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setVal(""); setActive(false); }
          }}
          className="w-full rounded bg-surface-2 px-2 py-1 text-[13px] outline-none ring-1 ring-accent"
        />
      </div>
      <div />
    </div>
  );
}

// ── MilestoneBlock ─────────────────────────────────────────────────────────────

function milestoneStatusCls(s: string) {
  const l = s.toLowerCase();
  if (l === "on track") return "bg-green-100 text-green-700";
  if (l === "at risk" || l === "needs attention") return "bg-amber-100 text-amber-700";
  if (l === "blocked") return "bg-red-100 text-red-700";
  if (l === "done" || l === "complete" || l === "completed") return "bg-surface-2 text-ink-4";
  if (l === "in_progress" || l === "in progress") return "bg-accent/10 text-accent-ink";
  if (l === "not started" || l === "not_started") return "bg-zinc-200 text-zinc-700";
  return "bg-surface-2 text-ink-3";
}

const MILESTONE_STATUS_OPTIONS = [
  "Not Started",
  "On Track",
  "At Risk",
  "Blocked",
  "Done",
] as const;

function MilestoneBlock({
  milestone,
  canEdit,
  projectId,
  onOpenDrawer,
  onOpenTaskDrawer,
}: {
  milestone: ProjectMilestone;
  canEdit: boolean;
  projectId: string;
  onOpenDrawer: () => void;
  onOpenTaskDrawer: (taskId: string) => void;
}) {
  const updateMilestone = useUpdateMilestone(projectId);
  const deleteMilestone = useDeleteMilestone(projectId);
  const [editingDate, setEditingDate] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(milestone.title);
  const [statusOpen, setStatusOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  // Milestone description is collapsed by default — click the chevron
  // on the milestone header to reveal/edit it.
  const milestoneHasDescription = (milestone.description ?? "").trim().length > 0;
  const [descOpen, setDescOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useOutsideClick(statusRef, () => setStatusOpen(false));
  useOutsideClick(actionsRef, () => setActionsOpen(false));

  useEffect(() => setTitleDraft(milestone.title), [milestone.title]);

  const overdue =
    !editingDate &&
    milestone.due_date &&
    new Date(milestone.due_date).getTime() < Date.now();

  function commitTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== milestone.title) {
      updateMilestone.mutate({ milestoneId: milestone.id, patch: { title: trimmed } });
    } else {
      setTitleDraft(milestone.title);
    }
    setEditingTitle(false);
  }

  function handleDelete() {
    if (
      confirm(
        `Delete milestone "${milestone.title}"? This also removes its tasks.`,
      )
    ) {
      deleteMilestone.mutate(milestone.id);
    }
    setActionsOpen(false);
  }

  return (
    <div className="border-b border-border-strong last:border-b-0">
      {/* Milestone header — full-width flex */}
      <div className="flex items-center gap-2 border-b border-border-strong bg-surface-2/50 px-4 py-1.5">
        {milestoneHasDescription || canEdit ? (
          <button
            type="button"
            onClick={() => setDescOpen((v) => !v)}
            title={descOpen ? "Hide description" : (milestoneHasDescription ? "Show description" : "Add description")}
            className={cn(
              "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-ink-4 hover:bg-surface-2 hover:text-ink",
              milestoneHasDescription ? "opacity-100" : "opacity-40 hover:opacity-100",
              descOpen && "opacity-100 text-ink-2",
            )}
          >
            {descOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="h-4 w-4 flex-shrink-0" />
        )}
        {editingTitle && canEdit ? (
          <input
            autoFocus
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitleDraft(milestone.title);
                setEditingTitle(false);
              }
            }}
            className="min-w-0 flex-1 rounded bg-surface px-1.5 py-0.5 text-[12px] font-semibold outline-none ring-1 ring-accent"
          />
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 truncate rounded px-1 text-left text-[12px] font-semibold text-ink-2 hover:bg-black/[0.03] hover:text-accent-ink"
            onClick={onOpenDrawer}
            title="Open milestone details"
          >
            {milestone.title}
          </button>
        )}

        {/* Status chip — click to change. */}
        <div ref={statusRef} className="relative flex-shrink-0">
          <button
            type="button"
            disabled={!canEdit}
            onClick={() => canEdit && setStatusOpen((o) => !o)}
            className={cn(
              "rounded px-1.5 py-px text-[10.5px] font-medium",
              milestoneStatusCls(milestone.status || "On Track"),
              canEdit && "hover:ring-1 hover:ring-accent",
            )}
          >
            {milestone.status || (canEdit ? "Set status" : "—")}
          </button>
          {statusOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] rounded-md border border-border-strong bg-surface shadow-lg">
              {MILESTONE_STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    updateMilestone.mutate({
                      milestoneId: milestone.id,
                      patch: { status: s },
                    });
                    setStatusOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] hover:bg-surface-2",
                    s === milestone.status && "bg-surface-2",
                  )}
                >
                  <span
                    className={cn(
                      "rounded px-1.5 py-px text-[10.5px] font-medium",
                      milestoneStatusCls(s),
                    )}
                  >
                    {s}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Due date — click to edit. Commits on change (native date
            picker doesn't reliably fire blur after selection) and on
            blur as a safety net. */}
        {editingDate && canEdit ? (
          <input
            autoFocus
            type="date"
            defaultValue={milestone.due_date ?? ""}
            onChange={(e) => {
              updateMilestone.mutate({
                milestoneId: milestone.id,
                patch: { due_date: e.target.value || null },
              });
              setEditingDate(false);
            }}
            onBlur={(e) => {
              const next = e.target.value || null;
              if (next !== (milestone.due_date ?? null)) {
                updateMilestone.mutate({
                  milestoneId: milestone.id,
                  patch: { due_date: next },
                });
              }
              setEditingDate(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingDate(false);
              if (e.key === "Enter") {
                const val = (e.target as HTMLInputElement).value || null;
                updateMilestone.mutate({
                  milestoneId: milestone.id,
                  patch: { due_date: val },
                });
                setEditingDate(false);
              }
            }}
            className="mono h-6 rounded border border-accent bg-surface px-1.5 text-[11.5px] outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => canEdit && setEditingDate(true)}
            className={cn(
              "mono flex-shrink-0 text-[11px]",
              overdue ? "font-semibold text-red-600" : milestone.due_date ? "text-ink-3" : "text-ink-4",
              canEdit && "hover:text-ink",
            )}
          >
            {milestone.due_date ? fmtDate(milestone.due_date) : canEdit ? "Set due date" : "—"}
          </button>
        )}
        <span className="flex-shrink-0 text-[11px] text-ink-4">
          {milestone.tasks.length} task{milestone.tasks.length === 1 ? "" : "s"}
        </span>

        {canEdit && (
          <div ref={actionsRef} className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setActionsOpen((o) => !o)}
              className="flex h-6 w-6 items-center justify-center rounded text-ink-4 hover:bg-surface-2 hover:text-ink"
              aria-label="Milestone actions"
            >
              <MoreHorizontal size={13} />
            </button>
            {actionsOpen && (
              <div className="absolute right-0 top-full z-50 min-w-[160px] rounded-md border border-border-strong bg-surface shadow-lg">
                <button
                  type="button"
                  onClick={() => { setEditingTitle(true); setActionsOpen(false); }}
                  className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-surface-2"
                >
                  <Trash2 size={12} />
                  Delete milestone
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Milestone description row — collapsed by default, toggled via
          the chevron on the milestone header. */}
      {descOpen ? (
        <div className="border-b border-border bg-surface px-4 py-1.5">
          <DescriptionEditor
            value={milestone.description}
            canEdit={canEdit}
            placeholder="Add a description for this milestone"
            compact
            onSave={(d) =>
              updateMilestone.mutateAsync({
                milestoneId: milestone.id,
                patch: { description: d },
              }).then(() => undefined)
            }
          />
        </div>
      ) : null}

      {milestone.tasks.map((t) => (
        <TaskRow
          key={t.id}
          task={t}
          canEdit={canEdit}
          projectId={projectId}
          onOpenDrawer={() => onOpenTaskDrawer(t.id)}
        />
      ))}
      {canEdit && (
        <AddTaskRow milestoneId={milestone.id} projectId={projectId} />
      )}
    </div>
  );
}

// ── AddMilestoneRow ────────────────────────────────────────────────────────────

function AddMilestoneRow({
  workstreamId,
  projectId,
  active,
  onSetActive,
}: {
  workstreamId: string;
  projectId: string;
  active: boolean;
  onSetActive: (v: boolean) => void;
}) {
  const createMilestone = useCreateMilestone(projectId);
  const [val, setVal] = useState("");

  function commit() {
    const trimmed = val.trim();
    if (trimmed) {
      createMilestone.mutate({ workstreamId, title: trimmed });
    }
    setVal("");
    onSetActive(false);
  }

  if (!active) {
    return (
      <button
        type="button"
        onClick={() => onSetActive(true)}
        className="block w-full px-4 py-2 text-left text-[12px] text-ink-4 hover:text-ink-3 hover:bg-surface-2/40"
      >
        + Add milestone
      </button>
    );
  }

  return (
    <div className="px-4 py-2">
      <input
        autoFocus
        type="text"
        placeholder="Milestone name…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setVal(""); onSetActive(false); }
        }}
        className="w-full rounded bg-surface-2 px-2 py-1 text-[13px] outline-none ring-1 ring-accent"
      />
    </div>
  );
}

// ── WorkstreamSection ─────────────────────────────────────────────────────────

function WorkstreamSection({
  ws,
  canEdit,
  projectId,
  onOpenDrawer,
  onOpenMilestoneDrawer,
  onOpenTaskDrawer,
}: {
  ws: ProjectWorkstream;
  canEdit: boolean;
  projectId: string;
  onOpenDrawer: () => void;
  onOpenMilestoneDrawer: (msId: string) => void;
  onOpenTaskDrawer: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(ws.name);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  useOutsideClick(actionsRef, () => setActionsOpen(false));

  const updateWorkstream = useUpdateWorkstream(projectId);
  const deleteWorkstream = useDeleteWorkstream(projectId);

  const milestoneCount = ws.milestones.length;
  const taskCount = ws.milestones.reduce((s, ms) => s + ms.tasks.length, 0);

  useEffect(() => setNameDraft(ws.name), [ws.name]);

  function handleAddMilestone() {
    setOpen(true);
    setAddingMilestone(true);
  }

  function commitName() {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== ws.name) {
      updateWorkstream.mutate({ workstreamId: ws.id, patch: { name: trimmed } });
    } else {
      setNameDraft(ws.name);
    }
    setEditingName(false);
  }

  function handleDelete() {
    if (
      confirm(
        `Delete workstream "${ws.name}"? This also removes its milestones and tasks.`,
      )
    ) {
      deleteWorkstream.mutate(ws.id);
    }
    setActionsOpen(false);
  }

  return (
    <div className="border-l-4 border-accent rounded-lg border border-border-strong bg-surface shadow-sm mt-3 first:mt-0">
      {/* Workstream header */}
      <div className="flex items-center border-b border-border-strong bg-surface-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-shrink-0 items-center px-3 py-2.5 hover:bg-black/[0.02]"
          aria-label={open ? "Collapse workstream" : "Expand workstream"}
        >
          {open ? (
            <ChevronDown size={13} className="text-ink-3" />
          ) : (
            <ChevronRight size={13} className="text-ink-3" />
          )}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pr-2">
          {editingName && canEdit ? (
            <input
              autoFocus
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") {
                  setNameDraft(ws.name);
                  setEditingName(false);
                }
              }}
              className="min-w-0 flex-1 rounded bg-surface px-1.5 py-0.5 text-[13px] font-semibold outline-none ring-1 ring-accent"
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded px-1 text-left text-[13px] font-semibold text-ink hover:bg-black/[0.03] hover:text-accent-ink"
              onClick={onOpenDrawer}
              title="Open workstream details"
            >
              {ws.name}
            </button>
          )}
          <span className="mono flex-shrink-0 text-[11px] text-ink-3">
            {milestoneCount} milestone{milestoneCount === 1 ? "" : "s"} · {taskCount} task{taskCount === 1 ? "" : "s"}
          </span>
        </div>
        {canEdit && (
          <button
            type="button"
            className="flex-shrink-0 border-l border-border-strong px-3 py-2.5 text-[12px] text-ink-3 hover:bg-black/[0.02] hover:text-ink"
            onClick={handleAddMilestone}
          >
            + Milestone
          </button>
        )}
        {canEdit && (
          <div ref={actionsRef} className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setActionsOpen((o) => !o)}
              className="flex h-full items-center border-l border-border-strong px-2.5 text-ink-4 hover:bg-black/[0.02] hover:text-ink"
              aria-label="Workstream actions"
            >
              <MoreHorizontal size={14} />
            </button>
            {actionsOpen && (
              <div className="absolute right-0 top-full z-50 min-w-[160px] rounded-md border border-border-strong bg-surface shadow-lg">
                <button
                  type="button"
                  onClick={() => { setEditingName(true); setActionsOpen(false); }}
                  className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-surface-2"
                >
                  <Trash2 size={12} />
                  Delete workstream
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {open && (
        <>
          <div className="border-b border-border bg-surface px-4 py-2">
            <DescriptionEditor
              value={ws.description}
              canEdit={canEdit}
              placeholder="Add a description for this workstream"
              onSave={(d) =>
                updateWorkstream.mutateAsync({
                  workstreamId: ws.id,
                  patch: { description: d },
                }).then(() => undefined)
              }
            />
          </div>
          {ws.milestones.map((ms) => (
            <MilestoneBlock
              key={ms.id}
              milestone={ms}
              canEdit={canEdit}
              projectId={projectId}
              onOpenDrawer={() => onOpenMilestoneDrawer(ms.id)}
              onOpenTaskDrawer={onOpenTaskDrawer}
            />
          ))}
          {milestoneCount === 0 && !addingMilestone ? (
            <div className="px-5 py-5 text-center text-[12.5px] text-ink-3">
              No milestones yet.
            </div>
          ) : null}
          {canEdit && (
            <AddMilestoneRow
              workstreamId={ws.id}
              projectId={projectId}
              active={addingMilestone}
              onSetActive={setAddingMilestone}
            />
          )}
        </>
      )}
    </div>
  );
}

// ── AddWorkstreamRow ──────────────────────────────────────────────────────────

function AddWorkstreamRow({ projectId }: { projectId: string }) {
  const createWorkstream = useCreateWorkstream(projectId);
  const [active, setActive] = useState(false);
  const [val, setVal] = useState("");

  function commit() {
    const trimmed = val.trim();
    if (trimmed) {
      createWorkstream.mutate(trimmed);
    }
    setVal("");
    setActive(false);
  }

  if (!active) {
    return (
      <button
        type="button"
        onClick={() => setActive(true)}
        className="mt-3 block w-full rounded-lg border border-dashed border-border-strong py-3 text-center text-[12.5px] text-ink-4 hover:border-ink-3 hover:text-ink-3"
      >
        + Add workstream
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-border-strong bg-surface p-3 shadow-sm">
      <input
        autoFocus
        type="text"
        placeholder="Workstream name…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setVal(""); setActive(false); }
        }}
        className="w-full rounded bg-surface-2 px-2 py-1.5 text-[13px] outline-none ring-1 ring-accent"
      />
    </div>
  );
}

// ── Linked opportunities section ──────────────────────────────────────────────

function SectionCard({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-border-strong bg-surface-2 px-5 py-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-wider text-ink-3">
          {title}
        </span>
        {action ?? null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
      {children}
    </div>
  );
}

/**
 * Unified Awards + Opportunities table for a project.
 *
 * Each row represents one *deal* — keyed on the SF opportunity id when
 * available — and shows the most-specific record we know about it:
 *
 *   - If an award row is linked to this project, that's what surfaces:
 *     award name + account, status badge, "Open award" + "Open opp"
 *     navigations, "Unlink" against the project_award row.
 *   - If only an opportunity is linked (project_opportunity, no award
 *     attached yet), the row shows the opp name + account + a
 *     "(not yet awarded)" subtitle, with a single "Open opp" navigation
 *     and "Unlink" against the project_opportunity row.
 *
 * When the opp eventually produces an award, the cascade in the awards
 * service adds the project_award row automatically; the row swaps from
 * the "not yet awarded" state to the full award treatment without the
 * RM having to touch anything.
 */
function LinkedRevenueSection({ projectId }: { projectId: string }) {
  const explicitOppsQ = useProjectOpportunities(projectId);
  const awardsQ = useProjectAwards(projectId);
  const { data: opps = [] } = useOpportunities();
  const { data: allAwards = [] } = useAwards();
  const qc = useQueryClient();

  const oppById = useMemo(() => new Map(opps.map((o) => [o.Id, o])), [opps]);

  type Row =
    | {
        kind: "award";
        opportunityId: string;
        opp: SfOpportunity | undefined;
        // award is the row from /api/projects/{id}/awards — its `award_id`
        // field is the bedrock.award uuid we link/unlink against.
        award: any;
      }
    | {
        kind: "opp";
        opportunityId: string;
        opp: SfOpportunity | undefined;
      };

  // Merge sources: every linked award is one row; explicit opp links that
  // *don't* have a corresponding award (yet) get a "not yet awarded" row.
  // Keyed by opportunity_id so the same deal can't appear twice.
  const rows: Row[] = useMemo(() => {
    const out = new Map<string, Row>();
    for (const a of awardsQ.data ?? []) {
      out.set(a.opportunity_id, {
        kind: "award",
        opportunityId: a.opportunity_id,
        opp: oppById.get(a.opportunity_id),
        award: a,
      });
    }
    for (const link of explicitOppsQ.data ?? []) {
      if (out.has(link.opportunity_id)) continue;
      out.set(link.opportunity_id, {
        kind: "opp",
        opportunityId: link.opportunity_id,
        opp: oppById.get(link.opportunity_id),
      });
    }
    return [...out.values()].sort((a, b) => {
      // Awards above pending opps; within each group, alphabetize on
      // opp name so the list is stable.
      if (a.kind !== b.kind) return a.kind === "award" ? -1 : 1;
      const an = a.opp?.Name ?? a.opportunityId;
      const bn = b.opp?.Name ?? b.opportunityId;
      return an.localeCompare(bn);
    });
  }, [awardsQ.data, explicitOppsQ.data, oppById]);

  // Linking mutations:
  //   - "Link award" picks from awards globally and creates project_award
  //   - "Link opportunity" picks from opps that aren't already covered
  //     (either as an award or as a pending opp here)
  const linkAward = useMutation({
    mutationFn: async (awardId: string) => {
      await api.post(`/api/projects/${projectId}/awards`, { entity_id: awardId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-awards", projectId] }),
  });
  const unlinkAward = useMutation({
    mutationFn: async (awardId: string) => {
      await api.delete(`/api/projects/${projectId}/awards/${awardId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-awards", projectId] }),
  });
  const linkOpp = useMutation({
    mutationFn: async (oppId: string) => {
      await api.post(`/api/projects/${projectId}/opportunities`, { opportunity_id: oppId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-opportunities", projectId] }),
  });
  const unlinkOpp = useMutation({
    mutationFn: async (oppId: string) => {
      await api.delete(`/api/projects/${projectId}/opportunities/${oppId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-opportunities", projectId] }),
  });

  const linkedAwardIds = new Set((awardsQ.data ?? []).map((a: any) => String(a.award_id)));
  const availableAwards = allAwards.filter((a) => !linkedAwardIds.has(String(a.id)));
  const coveredOppIds = new Set(rows.map((r) => r.opportunityId));
  const availableOpps = opps.filter((o) => !coveredOppIds.has(o.Id));

  const loading = explicitOppsQ.isLoading || awardsQ.isLoading;

  const headerAction = (
    <div className="flex items-center gap-2">
      {availableOpps.length > 0 ? (
        <LinkPicker
          label="Link opportunity"
          options={availableOpps.map((o) => ({
            id: o.Id,
            name: o.Account?.Name ? `${o.Name} — ${o.Account.Name}` : o.Name ?? o.Id,
          }))}
          onSelect={(id) => linkOpp.mutate(id)}
        />
      ) : null}
      {availableAwards.length > 0 ? (
        <LinkPicker
          label="Link award"
          options={availableAwards.map((a) => {
            const opp = oppById.get(a.opportunity_id);
            const oppName = opp?.Name ?? "(unknown opportunity)";
            const acct = opp?.Account?.Name;
            return {
              id: String(a.id),
              name: acct ? `${oppName} — ${acct}` : oppName,
            };
          })}
          onSelect={(id) => linkAward.mutate(id)}
        />
      ) : null}
    </div>
  );

  return (
    <SectionCard
      title={`Awards & opportunities (${loading ? "…" : rows.length})`}
      action={headerAction}
    >
      {loading ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>
          Nothing linked yet. Link an opportunity to plan ahead — when it produces an award, the award will inherit this project automatically.
        </Empty>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <RevenueRow
              key={row.opportunityId}
              row={row}
              onUnlinkAward={(awardId) => unlinkAward.mutate(awardId)}
              onUnlinkOpp={(oppId) => unlinkOpp.mutate(oppId)}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RevenueRow({
  row,
  onUnlinkAward,
  onUnlinkOpp,
}: {
  row:
    | { kind: "award"; opportunityId: string; opp: SfOpportunity | undefined; award: any }
    | { kind: "opp"; opportunityId: string; opp: SfOpportunity | undefined };
  onUnlinkAward: (awardId: string) => void;
  onUnlinkOpp: (oppId: string) => void;
}) {
  const oppName = row.opp?.Name ?? row.opportunityId;
  const acctName = row.opp?.Account?.Name;

  if (row.kind === "award") {
    const award = row.award;
    return (
      <li className="flex items-center gap-3 border-b border-border-strong px-5 py-2.5 last:border-b-0">
        <Link
          to={`/awards/${award.award_id}`}
          className="flex min-w-0 flex-1 flex-col leading-tight hover:underline"
        >
          <span className="truncate text-[13px] font-medium text-ink">{oppName}</span>
          {acctName ? (
            <span className="truncate text-[11.5px] text-ink-3">{acctName}</span>
          ) : null}
        </Link>
        {award.award_status ? (
          <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">
            {award.award_status}
          </span>
        ) : null}
        <Link
          to={`/opportunities/${row.opportunityId}`}
          className="text-[11px] text-ink-3 hover:text-accent hover:underline"
          title="View opportunity"
        >
          View opp
        </Link>
        <button
          type="button"
          onClick={() => onUnlinkAward(String(award.award_id))}
          className="text-[11px] text-ink-4 hover:text-red"
        >
          Unlink
        </button>
      </li>
    );
  }

  // Opportunity-only row — no award yet.
  return (
    <li className="flex items-center gap-3 border-b border-border-strong px-5 py-2.5 last:border-b-0">
      <Link
        to={`/opportunities/${row.opportunityId}`}
        className="flex min-w-0 flex-1 flex-col leading-tight hover:underline"
      >
        <span className="truncate text-[13px] font-medium text-ink">{oppName}</span>
        <span className="truncate text-[11.5px] text-ink-3">
          {acctName ? `${acctName} · ` : ""}(not yet awarded)
        </span>
      </Link>
      {row.opp?.StageName ? (
        <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">
          {row.opp.StageName}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onUnlinkOpp(row.opportunityId)}
        className="text-[11px] text-ink-4 hover:text-red"
      >
        Unlink
      </button>
    </li>
  );
}

// ── Linked contacts section (M2M via project_contact) ────────────────────────

function LinkedContactsSection({ projectId }: { projectId: string }) {
  const linkedQ = useProjectContacts(projectId);
  const { data: contacts = [] } = useContacts();
  const qc = useQueryClient();

  const linkedContacts = useMemo(() => {
    const links = linkedQ.data ?? [];
    const byId = new Map(contacts.map((c) => [c.Id, c]));
    return links.map((link) => ({ link, contact: byId.get(link.contact_id) }));
  }, [linkedQ.data, contacts]);

  const unlink = useMutation({
    mutationFn: async (contactId: string) => {
      await api.delete(`/api/projects/${projectId}/contacts/${contactId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-contacts", projectId] }),
  });

  const linkContact = useMutation({
    mutationFn: async (entityId: string) => {
      await api.post(`/api/projects/${projectId}/contacts`, { entity_id: entityId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-contacts", projectId] }),
  });

  const linkedIds = new Set(linkedContacts.map((l) => l.link.contact_id));
  const availableContacts = contacts.filter((c) => !linkedIds.has(c.Id));

  return (
    <SectionCard
      title={`Linked contacts (${linkedQ.isLoading ? "…" : linkedContacts.length})`}
      action={
        availableContacts.length > 0 ? (
          <LinkPicker
            label="Link contact"
            options={availableContacts.map((c) => ({ id: c.Id, name: c.Name ?? c.Id }))}
            onSelect={(id) => linkContact.mutate(id)}
          />
        ) : null
      }
    >
      {linkedQ.isLoading ? (
        <Empty>Loading…</Empty>
      ) : linkedContacts.length === 0 ? (
        <Empty>No contacts linked yet.</Empty>
      ) : (
        <ul className="flex flex-col">
          {linkedContacts.map(({ link, contact }) => (
            <li key={link.id} className="flex items-center gap-3 border-b border-border-strong px-5 py-2.5 last:border-b-0">
              <Link to={`/contacts/${link.contact_id}`} className="flex-1 truncate text-[13px] font-medium hover:underline">
                {contact?.Name ?? link.contact_id}
              </Link>
              {contact?.Account?.Name ? (
                <span className="truncate text-[11px] text-ink-3">{contact.Account.Name}</span>
              ) : null}
              <button type="button" onClick={() => unlink.mutate(link.contact_id)} className="text-[11px] text-ink-4 hover:text-red">
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Link picker (shared search dropdown) ─────────────────────────────────────

/**
 * Search dropdown rendered into a portal so it can escape SectionCard's
 * `overflow-hidden` (which would otherwise clip the popup against the
 * card's right edge — the bug previously visible on ProjectDetail).
 *
 * The trigger stays inline in the header; the popup is anchored to the
 * trigger's bounding rect and recomputes on scroll/resize so it tracks
 * the header during page scroll.
 */
function LinkPicker({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: { id: string; name: string }[];
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Popup placement — anchored to the trigger's right edge, opens downward.
  // Width is fixed at 320px so the column "Account Name — Opp Name" labels
  // don't truncate aggressively.
  const POPUP_WIDTH = 320;
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      // Anchor under the trigger, right-aligned. Clamp to viewport so the
      // popup never spills off the left edge for narrow windows.
      const left = Math.max(8, rect.right - POPUP_WIDTH);
      setCoords({ top: rect.bottom + 4, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Focus the search field when the popup opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside click / escape.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
      setQ("");
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        setQ("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = useMemo(
    () => options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 50),
    [options, q],
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-accent hover:underline"
      >
        + {label}
      </button>

      {open && coords
        ? createPortal(
            <div
              ref={popoverRef}
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                width: POPUP_WIDTH,
                zIndex: 50,
              }}
              className="rounded-md border border-border-strong bg-surface shadow-lg"
            >
              <div className="border-b border-border-strong px-3 py-2">
                <input
                  ref={inputRef}
                  placeholder={`Search to ${label.toLowerCase()}…`}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="h-7 w-full rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent"
                />
              </div>
              <ul className="max-h-72 overflow-auto py-1">
                {filtered.length === 0 ? (
                  <li className="px-3 py-2 text-[12px] text-ink-3">
                    {options.length === 0 ? "Nothing left to link." : "No matches."}
                  </li>
                ) : (
                  filtered.map((o) => (
                    <li key={o.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(o.id);
                          setOpen(false);
                          setQ("");
                        }}
                        className="w-full truncate px-3 py-1.5 text-left text-[12.5px] hover:bg-surface-2"
                        title={o.name}
                      >
                        {o.name}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function BackLink() {
  return <SharedBackLink defaultTo="/projects" defaultLabel="Projects" />;
}

// ── Editable project name ─────────────────────────────────────────────────────

function EditableProjectName({
  name,
  projectId,
  canEdit,
}: {
  name: string;
  projectId: string;
  canEdit: boolean;
}) {
  const updateProject = useUpdateProject(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  function save() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) {
      updateProject.mutate({ name: trimmed });
    } else {
      setDraft(name);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") { setDraft(name); setEditing(false); }
        }}
        className="w-full rounded bg-transparent text-[26px] font-bold leading-tight tracking-tight text-ink outline-none ring-1 ring-accent"
      />
    );
  }

  return (
    <h1
      className={cn(
        "text-[26px] font-bold leading-tight tracking-tight text-ink",
        canEdit && "cursor-text rounded hover:bg-surface-2/60",
      )}
      onClick={() => canEdit && setEditing(true)}
    >
      {name}
    </h1>
  );
}

// ── Editable project description ─────────────────────────────────────────────

function EditableProjectDescription({
  description,
  projectId,
  canEdit,
}: {
  description: string;
  projectId: string;
  canEdit: boolean;
}) {
  const updateProject = useUpdateProject(projectId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description);

  function save() {
    const trimmed = draft.trim();
    if (trimmed !== description) {
      updateProject.mutate({ description: trimmed });
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setDraft(description); setEditing(false); }
        }}
        rows={3}
        className="mt-2 w-full max-w-2xl rounded bg-transparent text-[13px] text-ink-2 outline-none ring-1 ring-accent resize-none"
      />
    );
  }

  return (
    <p
      className={cn(
        "mt-2 max-w-2xl whitespace-pre-wrap text-[13px] text-ink-2",
        canEdit && "cursor-text rounded hover:bg-surface-2/60",
        !description && canEdit && "text-ink-4 italic",
      )}
      onClick={() => canEdit && setEditing(true)}
    >
      {description || (canEdit ? "Add a description…" : null)}
    </p>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

interface ProjectListViewProps {
  workstreams: ProjectWorkstream[];
  canEdit: boolean;
  projectId: string;
  /** Hide the "+ Add workstream" affordance when a filter is active —
   *  otherwise the empty filtered tree looks like the project itself is
   *  empty. */
  showAddWorkstream: boolean;
}

function ProjectListView({
  workstreams,
  canEdit,
  projectId,
  showAddWorkstream,
}: ProjectListViewProps) {
  // Side panel state — clicking a workstream/milestone/task name opens
  // the relevant drawer. The existing inline-edit flows are still
  // reachable via the `⋯` menu's "Rename" item.
  const [openWsId, setOpenWsId] = useState<string | null>(null);
  const [openMsId, setOpenMsId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  // Resolve the latest object from the workstream tree each render so
  // the drawer reflects up-to-date data (e.g. after an inline edit).
  const openWs = openWsId
    ? workstreams.find((w) => w.id === openWsId) ?? null
    : null;
  const openMsCtx = (() => {
    if (!openMsId) return null;
    for (const w of workstreams) {
      const m = w.milestones.find((x) => x.id === openMsId);
      if (m) return { ws: w, ms: m };
    }
    return null;
  })();
  const openTaskCtx = (() => {
    if (!openTaskId) return null;
    for (const w of workstreams) {
      for (const m of w.milestones) {
        const t = m.tasks.find((x) => x.id === openTaskId);
        if (t) return { ws: w, ms: m, task: t };
      }
    }
    return null;
  })();

  return (
    <>
      {workstreams.length === 0 ? (
        <div className="mt-2 rounded-lg border border-border-strong bg-surface px-5 py-10 text-center text-[12.5px] text-ink-3 shadow-sm">
          {showAddWorkstream
            ? "No workstreams on this project yet."
            : "No tasks match the current filter."}
        </div>
      ) : (
        workstreams.map((ws) => (
          <WorkstreamSection
            key={ws.id}
            ws={ws}
            canEdit={canEdit}
            projectId={projectId}
            onOpenDrawer={() => setOpenWsId(ws.id)}
            onOpenMilestoneDrawer={(msId) => setOpenMsId(msId)}
            onOpenTaskDrawer={(taskId) => setOpenTaskId(taskId)}
          />
        ))
      )}
      {canEdit && showAddWorkstream ? <AddWorkstreamRow projectId={projectId} /> : null}

      {openWs ? (
        <WorkstreamDrawer
          workstream={openWs}
          projectId={projectId}
          canEdit={canEdit}
          onClose={() => setOpenWsId(null)}
          onOpenMilestone={(m) => {
            setOpenWsId(null);
            setOpenMsId(m.id);
          }}
        />
      ) : null}

      {openMsCtx ? (
        <MilestoneDrawer
          milestone={openMsCtx.ms}
          workstream={openMsCtx.ws}
          projectId={projectId}
          canEdit={canEdit}
          onClose={() => setOpenMsId(null)}
          onOpenTask={(t) => {
            setOpenMsId(null);
            setOpenTaskId(t.id);
          }}
        />
      ) : null}

      {openTaskCtx ? (
        <TaskDrawer
          task={openTaskCtx.task}
          milestone={openTaskCtx.ms}
          workstream={openTaskCtx.ws}
          projectId={projectId}
          canEdit={canEdit}
          onClose={() => setOpenTaskId(null)}
        />
      ) : null}
    </>
  );
}

export function ProjectDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const detailQ = useProjectDetail(id);
  const detail = detailQ.data;
  const canEdit = usePerm("edit_projects");

  const [view, setView] = useProjectView();
  const [filter, setFilter] = useState<ProjectFilter>(DEFAULT_FILTER);
  const { data: activeUsers = [] } = useActiveUsers();

  const workstreams: ProjectWorkstream[] = detail?.workstreams ?? [];

  // Filter tree for the List view. Workstreams + milestones disappear
  // when nothing inside them survives the filter — keeps the view honest
  // about what's hidden.
  const filteredWorkstreams = useMemo(() => {
    if (isDefaultFilter(filter)) return workstreams;
    return workstreams
      .map((ws) => ({
        ...ws,
        milestones: ws.milestones
          .map((ms) => ({
            ...ms,
            tasks: ms.tasks.filter((t) => taskMatchesFilter(t, ms, filter, ws.id)),
          }))
          .filter((ms) => ms.tasks.length > 0),
      }))
      .filter((ws) => ws.milestones.length > 0);
  }, [workstreams, filter]);

  if (detailQ.isLoading) {
    return (
      <div className="mx-auto max-w-[1320px] px-7 py-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-ink-3 shadow-sm">
          Loading project…
        </div>
      </div>
    );
  }

  if (detailQ.isError || !detail) {
    return (
      <div className="mx-auto max-w-[1320px] px-7 py-6">
        <BackLink />
        <div className="mt-6 rounded-lg border border-border-strong bg-surface p-10 text-center text-[13px] text-red-600 shadow-sm">
          Failed to load project.
        </div>
      </div>
    );
  }

  const subtitle = [
    detail.owner_email ?? null,
    detail.created_at ? `Created ${fmtDate(detail.created_at)}` : null,
    detail.updated_at ? `Updated ${fmtDate(detail.updated_at)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto max-w-[1320px] px-7 py-6 pb-20">
      <BackLink />

      {/* Header */}
      <div className="mt-4">
        <EditableProjectName name={detail.name} projectId={id} canEdit={canEdit} />
        {subtitle ? (
          <p className="mt-1 text-[12.5px] text-ink-3">{subtitle}</p>
        ) : null}
        <EditableProjectDescription
          description={detail.description}
          projectId={id}
          canEdit={canEdit}
        />
      </div>

      {/* View switcher */}
      <div className="mt-5 flex items-center gap-3">
        <ProjectViewSwitcher value={view} onChange={setView} />
      </div>

      {/* Sub-toolbar — applies to all three views */}
      <ProjectSubToolbar
        view={view}
        filter={filter}
        onChange={setFilter}
        owners={activeUsers}
        workstreams={workstreams}
      />

      {/* Selected view */}
      <section className="mt-4">
        {view === "list" ? (
          <ProjectListView
            workstreams={filteredWorkstreams}
            canEdit={canEdit}
            projectId={id}
            showAddWorkstream={isDefaultFilter(filter)}
          />
        ) : view === "board" ? (
          <ProjectBoardView detail={detail} filter={filter} canEdit={canEdit} />
        ) : (
          <ProjectTimelineView detail={detail} filter={filter} canEdit={canEdit} />
        )}
      </section>

      {/* Linked sections — these pull from Salesforce; when SF isn't
          connected they render empty (the hooks degrade to []) so we
          surface a banner so the empty state isn't mysterious. */}
      <SalesforceOfflineBanner />
      <LinkedRevenueSection projectId={id} />
      <LinkedContactsSection projectId={id} />
    </div>
  );
}

function SalesforceOfflineBanner() {
  const sf = useSalesforceStatus();
  if (sf.isLoading) return null;
  if (sf.data?.connected) return null;
  return (
    <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
      <span className="font-medium">Salesforce not connected.</span>{" "}
      The Awards/Opportunities and Contacts sections below need a Salesforce session to populate. Project workstreams, milestones, and tasks above work without it.{" "}
      <a href="/settings" className="underline">
        Connect →
      </a>
    </div>
  );
}
