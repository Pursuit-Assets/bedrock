import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtDate, initials } from "@/lib/format";
import {
  useActiveUsers,
  useDeleteTask,
  useUpdateTask,
  type ActiveUser,
  type ProjectMilestone,
  type ProjectTask,
  type ProjectWorkstream,
} from "@/services/projects";
import { DescriptionEditor } from "@/components/project/DescriptionEditor";
import { TaskComments } from "@/components/project/TaskComments";

const STATUS_OPTIONS = ["Not Started", "In Progress", "Blocked", "Done"] as const;

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

interface TaskDrawerProps {
  task: ProjectTask;
  workstream: ProjectWorkstream;
  milestone: ProjectMilestone;
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
}

export function TaskDrawer({
  task,
  workstream,
  milestone,
  projectId,
  canEdit,
  onClose,
}: TaskDrawerProps) {
  const updateTask = useUpdateTask(projectId);
  const deleteTask = useDeleteTask(projectId);
  const { data: users = [] } = useActiveUsers();

  const [titleDraft, setTitleDraft] = useState(task.title);
  useEffect(() => setTitleDraft(task.title), [task.title]);

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function commitTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      updateTask.mutate({ taskId: task.id, patch: { title: trimmed } });
    } else {
      setTitleDraft(task.title);
    }
  }

  function setOwner(user: ActiveUser | null) {
    updateTask.mutate({
      taskId: task.id,
      patch: user
        ? { owner: user.display_name, owner_ids: [user.id] }
        : { owner: undefined, owner_ids: [] },
    });
  }

  const overdue =
    !!task.deadline &&
    !["done", "complete", "completed", "cancelled", "canceled"].includes(
      task.status.toLowerCase(),
    ) &&
    new Date(task.deadline).getTime() < Date.now();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`Task: ${task.title}`}
    >
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/30"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <aside className="flex h-full w-[440px] flex-col border-l border-border-strong bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-start gap-2 border-b border-border-strong px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wider text-ink-4">
              {workstream.name} <span className="text-ink-3">/</span> {milestone.title}
            </p>
            {canEdit ? (
              <textarea
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    (e.target as HTMLTextAreaElement).blur();
                  }
                }}
                rows={2}
                className="mt-1 w-full resize-none rounded border border-transparent bg-transparent px-1 py-0.5 text-[16px] font-semibold leading-snug text-ink outline-none hover:border-border focus:border-accent"
              />
            ) : (
              <h2 className="mt-1 text-[16px] font-semibold leading-snug text-ink">
                {task.title}
              </h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex-shrink-0 rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Field grid */}
          <div className="grid grid-cols-[90px_1fr] gap-y-3 text-[12.5px]">
            <span className="self-center text-ink-4">Status</span>
            <select
              disabled={!canEdit}
              value={task.status || "Not Started"}
              onChange={(e) =>
                updateTask.mutate({ taskId: task.id, patch: { status: e.target.value } })
              }
              className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent disabled:opacity-60"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <span className="self-center text-ink-4">Owner</span>
            <div className="flex items-center gap-2">
              {task.owner ? (
                <span
                  className={cn(
                    "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white",
                    avatarColor(task.owner),
                  )}
                >
                  {initials(task.owner)}
                </span>
              ) : null}
              <select
                disabled={!canEdit}
                value={task.owner_ids[0] ?? ""}
                onChange={(e) => {
                  const id = e.target.value;
                  if (!id) return setOwner(null);
                  const u = users.find((x) => x.id === id);
                  if (u) setOwner(u);
                }}
                className="h-7 flex-1 rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent disabled:opacity-60"
              >
                <option value="">No owner</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name || u.email}
                  </option>
                ))}
              </select>
            </div>

            <span className="self-center text-ink-4">Start</span>
            <input
              type="date"
              disabled={!canEdit}
              defaultValue={task.startDate?.slice(0, 10) ?? ""}
              onBlur={(e) =>
                updateTask.mutate({
                  taskId: task.id,
                  patch: { start_date: e.target.value || null },
                })
              }
              className="mono h-7 rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent disabled:opacity-60"
            />

            <span className="self-center text-ink-4">Due</span>
            <input
              type="date"
              disabled={!canEdit}
              defaultValue={task.deadline?.slice(0, 10) ?? ""}
              onBlur={(e) =>
                updateTask.mutate({
                  taskId: task.id,
                  patch: { deadline: e.target.value || null },
                })
              }
              className={cn(
                "mono h-7 rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent disabled:opacity-60",
                overdue && "text-red-600",
              )}
            />

            {task.deadline && overdue ? (
              <>
                <span />
                <p className="text-[11px] font-medium text-red-600">
                  Overdue · {fmtDate(task.deadline)}
                </p>
              </>
            ) : null}
          </div>

          {/* Description */}
          <div className="mt-5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Description
            </p>
            <DescriptionEditor
              value={task.description}
              canEdit={canEdit}
              placeholder="Add description"
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

          {/* Links — read-only in v1 */}
          {task.links.length > 0 ? (
            <div className="mt-5">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                Links
              </p>
              <ul className="space-y-1">
                {task.links.map((href) => (
                  <li key={href}>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="break-all text-[12px] text-accent hover:underline"
                    >
                      {href}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Comments — pulls from public.org_comments via /api/comments. */}
          <div className="mt-5 border-t border-border pt-4">
            <TaskComments taskId={task.id} />
          </div>
        </div>

        {/* Footer */}
        {canEdit ? (
          <div className="flex items-center justify-between border-t border-border-strong px-5 py-3">
            <button
              type="button"
              onClick={() => {
                if (confirm("Delete this task?")) {
                  deleteTask.mutate(task.id);
                  onClose();
                }
              }}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
            >
              <Trash2 size={12} />
              Delete task
            </button>
            <span className="text-[11px] text-ink-4">
              Updated changes save automatically
            </span>
          </div>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}
