import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import {
  useDeleteMilestone,
  useUpdateMilestone,
  type ProjectMilestone,
  type ProjectTask,
  type ProjectWorkstream,
} from "@/services/projects";
import { DescriptionEditor } from "@/components/project/DescriptionEditor";

const MILESTONE_STATUS_OPTIONS = [
  "Not Started",
  "On Track",
  "At Risk",
  "Blocked",
  "Done",
] as const;

function milestoneStatusCls(s: string) {
  const l = (s ?? "").toLowerCase();
  if (l === "on track") return "bg-green-100 text-green-700 border-green-200";
  if (l === "at risk" || l === "needs attention") {
    return "bg-amber-100 text-amber-700 border-amber-200";
  }
  if (l === "blocked") return "bg-red-100 text-red-700 border-red-200";
  if (l === "done" || l === "complete" || l === "completed") {
    return "bg-emerald-100 text-emerald-700 border-emerald-200";
  }
  if (l === "not started" || l === "not_started") {
    return "bg-zinc-100 text-zinc-700 border-zinc-200";
  }
  return "bg-surface-2 text-ink-3 border-border";
}

interface MilestoneDrawerProps {
  milestone: ProjectMilestone;
  workstream: ProjectWorkstream;
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
  /** Click a task in the list → caller opens the TaskDrawer for it. */
  onOpenTask: (t: ProjectTask) => void;
}

export function MilestoneDrawer({
  milestone,
  workstream,
  projectId,
  canEdit,
  onClose,
  onOpenTask,
}: MilestoneDrawerProps) {
  const updateMilestone = useUpdateMilestone(projectId);
  const deleteMilestone = useDeleteMilestone(projectId);

  const [titleDraft, setTitleDraft] = useState(milestone.title);
  useEffect(() => setTitleDraft(milestone.title), [milestone.title]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function commitTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== milestone.title) {
      updateMilestone.mutate({ milestoneId: milestone.id, patch: { title: trimmed } });
    } else {
      setTitleDraft(milestone.title);
    }
  }

  const overdue =
    !!milestone.due_date &&
    new Date(milestone.due_date).getTime() < Date.now();

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`Milestone: ${milestone.title}`}
    >
      <div className="flex-1 bg-black/30" onClick={onClose} aria-hidden />
      <aside className="flex h-full w-[440px] flex-col border-l border-border-strong bg-surface shadow-2xl">
        <div className="flex items-start gap-2 border-b border-border-strong px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wider text-ink-4">
              {workstream.name}
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
                {milestone.title}
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

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Status + Due date row */}
          <div className="grid grid-cols-[90px_1fr] gap-y-3 text-[12.5px]">
            <span className="self-center text-ink-4">Status</span>
            <select
              disabled={!canEdit}
              value={milestone.status || "On Track"}
              onChange={(e) =>
                updateMilestone.mutate({
                  milestoneId: milestone.id,
                  patch: { status: e.target.value },
                })
              }
              className={cn(
                "h-7 rounded border px-2 text-[12px] font-medium outline-none focus:border-accent disabled:opacity-60",
                milestoneStatusCls(milestone.status),
              )}
            >
              {MILESTONE_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <span className="self-center text-ink-4">Due</span>
            <input
              type="date"
              disabled={!canEdit}
              defaultValue={milestone.due_date ?? ""}
              onChange={(e) =>
                updateMilestone.mutate({
                  milestoneId: milestone.id,
                  patch: { due_date: e.target.value || null },
                })
              }
              className={cn(
                "mono h-7 rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent disabled:opacity-60",
                overdue && "border-red-300 text-red-600",
              )}
            />

            {milestone.due_date && overdue ? (
              <>
                <span />
                <p className="text-[11px] font-medium text-red-600">
                  Overdue · {fmtDate(milestone.due_date)}
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
              value={milestone.description}
              canEdit={canEdit}
              placeholder="Add a description for this milestone"
              onSave={(d) =>
                updateMilestone.mutateAsync({
                  milestoneId: milestone.id,
                  patch: { description: d },
                }).then(() => undefined)
              }
            />
          </div>

          {/* Tasks list */}
          <div className="mt-5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Tasks ({milestone.tasks.length})
            </p>
            {milestone.tasks.length === 0 ? (
              <p className="text-[12px] text-ink-4">No tasks yet.</p>
            ) : (
              <ul className="space-y-1">
                {milestone.tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onOpenTask(t)}
                      className="flex w-full items-center gap-2 rounded border border-border bg-surface px-3 py-1.5 text-left text-[12.5px] hover:border-accent hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">{t.title}</span>
                      {t.deadline ? (
                        <span className="mono flex-shrink-0 text-[10.5px] text-ink-4">
                          {fmtDate(t.deadline)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {canEdit ? (
          <div className="flex items-center justify-between border-t border-border-strong px-5 py-3">
            <button
              type="button"
              onClick={() => {
                if (confirm(`Delete milestone "${milestone.title}"? This removes its tasks.`)) {
                  deleteMilestone.mutate(milestone.id);
                  onClose();
                }
              }}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
            >
              <Trash2 size={12} />
              Delete milestone
            </button>
            <span className="text-[11px] text-ink-4">Edits save automatically</span>
          </div>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}
