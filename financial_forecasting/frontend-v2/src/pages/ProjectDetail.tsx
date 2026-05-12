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
import { useAccounts } from "@/services/accounts";
import { useContacts } from "@/services/contacts";
import { useAwards } from "@/services/awards";
import { usePerm } from "@/services/permissions";
import {
  useActiveUsers,
  useCreateMilestone,
  useCreateTask,
  useCreateWorkstream,
  useDeleteTask,
  useProjectDetail,
  useUpdateMilestone,
  useUpdateProject,
  useUpdateTask,
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

function statusDotClass(status: string): string {
  const s = (status ?? "").toLowerCase();
  if (s === "in progress" || s === "in_progress") return "bg-blue-500";
  if (s === "blocked") return "bg-amber-500";
  if (s === "done" || s === "complete" || s === "completed") return "bg-green-500";
  if (s === "cancelled" || s === "canceled") return "bg-ink-4";
  return "border-2 border-ink-3 bg-transparent";
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
    <div ref={ref} className="relative flex items-center justify-center">
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => canEdit && setOpen((o) => !o)}
        className={cn(
          "h-3 w-3 rounded-full flex-shrink-0",
          statusDotClass(status),
          canEdit && "cursor-pointer hover:opacity-80",
        )}
        title={status}
      />
      {open && (
        <div className="absolute left-4 top-0 z-50 min-w-[140px] rounded-md border border-border-strong bg-surface shadow-lg">
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
                className={cn("h-2.5 w-2.5 rounded-full flex-shrink-0", statusDotClass(opt))}
              />
              {opt}
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
}: {
  task: ProjectTask;
  canEdit: boolean;
  projectId: string;
}) {
  const updateTask = useUpdateTask(projectId);
  const deleteTask = useDeleteTask(projectId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleVal, setTitleVal] = useState(task.title);
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);
  const [editingDate, setEditingDate] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
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
    <div className="group grid grid-cols-[36px_1fr_160px_110px_32px] items-center border-b border-border-strong hover:bg-surface-2/60 last:border-b-0">
      {/* Status dot */}
      <div className="flex items-center justify-center">
        <StatusDot
          status={task.status ?? "Not Started"}
          canEdit={canEdit}
          onSelect={(s) => updateTask.mutate({ taskId: task.id, patch: { status: s } })}
        />
      </div>

      {/* Title */}
      <div className="min-w-0 py-2 pr-2">
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
          <span
            className={cn(
              "block cursor-default truncate text-[13px]",
              closed && "text-ink-3 line-through",
              canEdit && "cursor-text",
            )}
            onClick={() => canEdit && setEditingTitle(true)}
          >
            {task.title}
          </span>
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
              <div className="absolute right-0 top-full z-50 min-w-[120px] rounded-md border border-border-strong bg-surface shadow-lg">
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
  return "bg-surface-2 text-ink-3";
}

function MilestoneBlock({
  milestone,
  canEdit,
  projectId,
}: {
  milestone: ProjectMilestone;
  canEdit: boolean;
  projectId: string;
}) {
  const updateMilestone = useUpdateMilestone(projectId);
  const [editingDate, setEditingDate] = useState(false);
  const overdue =
    !editingDate &&
    milestone.due_date &&
    new Date(milestone.due_date).getTime() < Date.now();

  return (
    <div className="border-b border-border-strong last:border-b-0">
      {/* Milestone header — full-width flex */}
      <div className="flex items-center gap-2 border-b border-border-strong bg-surface-2/50 px-4 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-2">
          {milestone.title}
        </span>
        {milestone.status ? (
          <span
            className={cn(
              "flex-shrink-0 rounded px-1.5 py-px text-[10.5px] font-medium",
              milestoneStatusCls(milestone.status),
            )}
          >
            {milestone.status}
          </span>
        ) : null}
        {/* Due date — click to edit */}
        {editingDate && canEdit ? (
          <input
            autoFocus
            type="date"
            defaultValue={milestone.due_date ?? ""}
            onBlur={(e) => {
              updateMilestone.mutate({ milestoneId: milestone.id, patch: { due_date: e.target.value || null } });
              setEditingDate(false);
            }}
            onKeyDown={(e) => { if (e.key === "Escape") setEditingDate(false); }}
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
      </div>

      {milestone.tasks.map((t) => (
        <TaskRow key={t.id} task={t} canEdit={canEdit} projectId={projectId} />
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
}: {
  ws: ProjectWorkstream;
  canEdit: boolean;
  projectId: string;
}) {
  const [open, setOpen] = useState(true);
  const [addingMilestone, setAddingMilestone] = useState(false);

  const milestoneCount = ws.milestones.length;
  const taskCount = ws.milestones.reduce((s, ms) => s + ms.tasks.length, 0);

  function handleAddMilestone() {
    setOpen(true);
    setAddingMilestone(true);
  }

  return (
    <div className="border-l-4 border-accent overflow-hidden rounded-lg border border-border-strong bg-surface shadow-sm mt-3 first:mt-0">
      {/* Workstream header */}
      <div className="flex items-center border-b border-border-strong bg-surface-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 px-4 py-2.5 text-left hover:bg-black/[0.02]"
        >
          {open ? (
            <ChevronDown size={13} className="flex-shrink-0 text-ink-3" />
          ) : (
            <ChevronRight size={13} className="flex-shrink-0 text-ink-3" />
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            {ws.name}
          </span>
          <span className="mono flex-shrink-0 text-[11px] text-ink-3">
            {milestoneCount} milestone{milestoneCount === 1 ? "" : "s"} · {taskCount} task{taskCount === 1 ? "" : "s"}
          </span>
        </button>
        {canEdit && (
          <button
            type="button"
            className="flex-shrink-0 border-l border-border-strong px-3 py-2.5 text-[12px] text-ink-3 hover:bg-black/[0.02] hover:text-ink"
            onClick={handleAddMilestone}
          >
            + Milestone
          </button>
        )}
      </div>

      {open && (
        <>
          {ws.milestones.map((ms) => (
            <MilestoneBlock
              key={ms.id}
              milestone={ms}
              canEdit={canEdit}
              projectId={projectId}
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

function LinkedOpportunitiesSection({ projectId }: { projectId: string }) {
  // Opportunities can be linked two ways:
  //   1. Explicit M2M (project_opportunity) — RM linked an opp directly,
  //      typically *before* the opp produced an award.
  //   2. Auto-derived from linked awards — the linked award's
  //      award.opportunity_id surfaces here read-only.
  // We merge both, marking auto-derived ones so the user knows they can't
  // be unlinked from here (they'd need to unlink the award instead).
  const explicitQ = useProjectOpportunities(projectId);
  const awardsQ = useProjectAwards(projectId);
  const { data: opps = [] } = useOpportunities();
  const qc = useQueryClient();

  const explicit = explicitQ.data ?? [];

  const linkedOpps = useMemo(() => {
    const byId = new Map(opps.map((o) => [o.Id, o]));
    const result: { oppId: string; opp: SfOpportunity | undefined; via: "direct" | "award" }[] = [];
    const seen = new Set<string>();
    for (const link of explicit) {
      if (seen.has(link.opportunity_id)) continue;
      seen.add(link.opportunity_id);
      result.push({ oppId: link.opportunity_id, opp: byId.get(link.opportunity_id), via: "direct" });
    }
    for (const award of awardsQ.data ?? []) {
      const oppId = award.opportunity_id;
      if (!oppId || seen.has(oppId)) continue;
      seen.add(oppId);
      result.push({ oppId, opp: byId.get(oppId), via: "award" });
    }
    return result;
  }, [explicit, awardsQ.data, opps]);

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

  const linkedIds = new Set(linkedOpps.map((l) => l.oppId));
  const availableOpps = opps.filter((o) => !linkedIds.has(o.Id));

  const loading = explicitQ.isLoading || awardsQ.isLoading;

  return (
    <SectionCard
      title={`Opportunities (${loading ? "…" : linkedOpps.length})`}
      action={
        availableOpps.length > 0 ? (
          <LinkPicker
            label="Link opportunity"
            options={availableOpps.map((o) => ({
              id: o.Id,
              name: o.Account?.Name ? `${o.Name} — ${o.Account.Name}` : o.Name ?? o.Id,
            }))}
            onSelect={(id) => linkOpp.mutate(id)}
          />
        ) : null
      }
    >
      {loading ? (
        <Empty>Loading…</Empty>
      ) : linkedOpps.length === 0 ? (
        <Empty>No opportunities linked yet. Link one to plan ahead — when it produces an award, the award will inherit this project automatically.</Empty>
      ) : (
        <ul className="flex flex-col">
          {linkedOpps.map(({ oppId, opp, via }) => (
            <li key={oppId} className="flex items-center gap-3 border-b border-border-strong px-5 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <Link to={`/opportunities/${oppId}`} className="block truncate text-[13px] font-medium hover:underline">
                  {opp?.Name ?? oppId}
                </Link>
                {opp?.Account?.Name ? (
                  <span className="block truncate text-[11.5px] text-ink-3">{opp.Account.Name}</span>
                ) : null}
              </div>
              {opp?.StageName ? (
                <span className="flex-shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">{opp.StageName}</span>
              ) : null}
              {via === "award" ? (
                <span
                  title="Inherited from a linked award — unlink the award to remove."
                  className="flex-shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-ink-4"
                >
                  via award
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => unlinkOpp.mutate(oppId)}
                  className="text-[11px] text-ink-4 hover:text-red"
                >
                  Unlink
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Accounts section (auto-derived from linked awards → opp → account) ───────

function LinkedAccountsSection({ projectId }: { projectId: string }) {
  const awardsQ = useProjectAwards(projectId);
  const { data: opps = [] } = useOpportunities();
  const { data: accounts = [] } = useAccounts();

  const linkedAccounts = useMemo(() => {
    const awardData = awardsQ.data ?? [];
    const oppById = new Map(opps.map((o) => [o.Id, o]));
    const acctById = new Map(accounts.map((a) => [a.Id, a]));
    const seen = new Set<string>();
    const result: { id: string; name: string }[] = [];
    for (const award of awardData) {
      const opp = oppById.get(award.opportunity_id);
      const acctId = opp?.AccountId;
      if (!acctId || seen.has(acctId)) continue;
      seen.add(acctId);
      const acct = acctById.get(acctId);
      result.push({ id: acctId, name: acct?.Name ?? opp?.Account?.Name ?? acctId });
    }
    return result;
  }, [awardsQ.data, opps, accounts]);

  if (!awardsQ.isLoading && linkedAccounts.length === 0) return null;

  return (
    <SectionCard title={`Accounts (${awardsQ.isLoading ? "…" : linkedAccounts.length})`}>
      {awardsQ.isLoading ? (
        <Empty>Loading…</Empty>
      ) : (
        <ul className="flex flex-col">
          {linkedAccounts.map((acct) => (
            <li key={acct.id} className="flex items-center gap-3 border-b border-border-strong px-5 py-2.5 last:border-b-0">
              <Link to={`/accounts/${acct.id}`} className="flex-1 truncate text-[13px] font-medium hover:underline">
                {acct.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
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

// ── Linked awards section (M2M via project_award) ────────────────────────────

function LinkedAwardsSection({ projectId }: { projectId: string }) {
  const linkedQ = useProjectAwards(projectId);
  const { data: awards = [] } = useAwards();
  const { data: opps = [] } = useOpportunities();
  const qc = useQueryClient();

  const unlink = useMutation({
    mutationFn: async (awardId: string) => {
      await api.delete(`/api/projects/${projectId}/awards/${awardId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-awards", projectId] }),
  });

  const linkAward = useMutation({
    mutationFn: async (entityId: string) => {
      await api.post(`/api/projects/${projectId}/awards`, { entity_id: entityId });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project-awards", projectId] }),
  });

  const data = linkedQ.data ?? [];
  const linkedAwardIds = new Set(data.map((a: any) => String(a.award_id)));
  const availableAwards = awards.filter((a) => !linkedAwardIds.has(String(a.id)));

  return (
    <SectionCard
      title={`Linked awards (${linkedQ.isLoading ? "…" : data.length})`}
      action={
        availableAwards.length > 0 ? (
          <LinkPicker
            label="Link award"
            options={availableAwards.map((a) => {
              const opp = opps.find((o) => o.Id === a.opportunity_id);
              const oppName = opp?.Name ?? "(unknown opportunity)";
              const acct = opp?.Account?.Name;
              return {
                id: String(a.id),
                name: acct ? `${oppName} — ${acct}` : oppName,
              };
            })}
            onSelect={(id) => linkAward.mutate(id)}
          />
        ) : null
      }
    >
      {linkedQ.isLoading ? (
        <Empty>Loading…</Empty>
      ) : data.length === 0 ? (
        <Empty>No awards linked yet.</Empty>
      ) : (
        <ul className="flex flex-col">
          {data.map((award: any) => {
            const opp = opps.find((o) => o.Id === award.opportunity_id);
            return (
            <li key={award.id} className="flex items-center gap-3 border-b border-border-strong px-5 py-2.5 last:border-b-0">
              <Link to={`/awards/${award.award_id}`} className="flex-1 truncate text-[13px] font-medium hover:underline">
                {opp?.Account?.Name ?? opp?.Name ?? award.opportunity_id}
              </Link>
              {award.award_status ? (
                <span className="rounded bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">{award.award_status}</span>
              ) : null}
              <button type="button" onClick={() => unlink.mutate(String(award.award_id))} className="text-[11px] text-ink-4 hover:text-red">
                Unlink
              </button>
            </li>
            );
          })}
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

export function ProjectDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const detailQ = useProjectDetail(id);
  const detail = detailQ.data;
  const canEdit = usePerm("edit_projects");

  const workstreams: ProjectWorkstream[] = detail?.workstreams ?? [];

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

      {/* Board */}
      <section className="mt-6">
        {workstreams.length === 0 ? (
          <div className="mt-2 rounded-lg border border-border-strong bg-surface px-5 py-10 text-center text-[12.5px] text-ink-3 shadow-sm">
            No workstreams on this project yet.
          </div>
        ) : (
          workstreams.map((ws) => (
            <WorkstreamSection
              key={ws.id}
              ws={ws}
              canEdit={canEdit}
              projectId={id}
            />
          ))
        )}
        {canEdit && <AddWorkstreamRow projectId={id} />}
      </section>

      {/* Linked sections */}
      <LinkedAwardsSection projectId={id} />
      <LinkedContactsSection projectId={id} />
      <LinkedOpportunitiesSection projectId={id} />
      <LinkedAccountsSection projectId={id} />
    </div>
  );
}
