import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";

import {
  useDeleteWorkstream,
  useUpdateWorkstream,
  type ProjectMilestone,
  type ProjectWorkstream,
} from "@/services/projects";
import { DescriptionEditor } from "@/components/project/DescriptionEditor";

interface WorkstreamDrawerProps {
  workstream: ProjectWorkstream;
  projectId: string;
  canEdit: boolean;
  onClose: () => void;
  /** Click a milestone in the list → caller opens that milestone's drawer. */
  onOpenMilestone: (m: ProjectMilestone) => void;
}

export function WorkstreamDrawer({
  workstream,
  projectId,
  canEdit,
  onClose,
  onOpenMilestone,
}: WorkstreamDrawerProps) {
  const updateWorkstream = useUpdateWorkstream(projectId);
  const deleteWorkstream = useDeleteWorkstream(projectId);

  const [nameDraft, setNameDraft] = useState(workstream.name);
  useEffect(() => setNameDraft(workstream.name), [workstream.name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function commitName() {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== workstream.name) {
      updateWorkstream.mutate({ workstreamId: workstream.id, patch: { name: trimmed } });
    } else {
      setNameDraft(workstream.name);
    }
  }

  const taskCount = workstream.milestones.reduce((s, m) => s + m.tasks.length, 0);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`Workstream: ${workstream.name}`}
    >
      <div className="flex-1 bg-black/30" onClick={onClose} aria-hidden />
      <aside className="flex h-full w-[440px] flex-col border-l border-border-strong bg-surface shadow-2xl">
        <div className="flex items-start gap-2 border-b border-border-strong px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wider text-ink-4">Workstream</p>
            {canEdit ? (
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") {
                    setNameDraft(workstream.name);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className="mt-1 w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[16px] font-semibold leading-snug text-ink outline-none hover:border-border focus:border-accent"
              />
            ) : (
              <h2 className="mt-1 text-[16px] font-semibold leading-snug text-ink">
                {workstream.name}
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
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <Stat label="Milestones" value={workstream.milestones.length} />
            <Stat label="Tasks" value={taskCount} />
            <Stat
              label="Open"
              value={workstream.milestones.reduce(
                (s, m) =>
                  s + m.tasks.filter((t) => !isClosedStatus(t.status)).length,
                0,
              )}
            />
          </div>

          <div className="mt-5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Description
            </p>
            <DescriptionEditor
              value={workstream.description}
              canEdit={canEdit}
              placeholder="Add a description for this workstream"
              onSave={(d) =>
                updateWorkstream.mutateAsync({
                  workstreamId: workstream.id,
                  patch: { description: d },
                }).then(() => undefined)
              }
            />
          </div>

          <div className="mt-5">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              Milestones
            </p>
            {workstream.milestones.length === 0 ? (
              <p className="text-[12px] text-ink-4">No milestones yet.</p>
            ) : (
              <ul className="space-y-1">
                {workstream.milestones.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => onOpenMilestone(m)}
                      className="flex w-full items-center gap-2 rounded border border-border bg-surface px-3 py-1.5 text-left text-[12.5px] hover:border-accent hover:bg-surface-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-ink">{m.title}</span>
                      <span className="flex-shrink-0 text-[11px] text-ink-3">
                        {m.tasks.length} task{m.tasks.length === 1 ? "" : "s"}
                      </span>
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
                if (
                  confirm(
                    `Delete workstream "${workstream.name}"? This removes its milestones and tasks.`,
                  )
                ) {
                  deleteWorkstream.mutate(workstream.id);
                  onClose();
                }
              }}
              className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] text-red-600 hover:bg-red-50"
            >
              <Trash2 size={12} />
              Delete workstream
            </button>
            <span className="text-[11px] text-ink-4">Edits save automatically</span>
          </div>
        ) : null}
      </aside>
    </div>,
    document.body,
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-surface-2/50 px-2.5 py-1.5">
      <p className="text-[10.5px] uppercase tracking-wider text-ink-4">{label}</p>
      <p className="mt-0.5 text-[14px] font-semibold text-ink">{value}</p>
    </div>
  );
}

function isClosedStatus(s: string) {
  const l = (s ?? "").toLowerCase();
  return ["done", "complete", "completed", "cancelled", "canceled"].includes(l);
}
