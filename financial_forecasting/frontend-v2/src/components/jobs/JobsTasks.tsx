import { useMemo, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { useActiveUsers } from "@/services/projects";
import { cn } from "@/lib/utils";
import {
  useCreateJobsTask,
  useDeleteJobsTask,
  useJobsTasks,
  useUpdateJobsTask,
  type JobsTask,
  type JobsTaskParentType,
  type JobsTaskStatus,
} from "@/services/jobsTasks";

const STATUS_OPTIONS: { value: JobsTaskStatus; label: string }[] = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Blocked", label: "Blocked" },
  { value: "On Hold", label: "On Hold" },
  { value: "Completed", label: "Completed" },
];

interface JobsTasksProps {
  parentType: JobsTaskParentType;
  parentId: string;
}

/** Compact tasks list for a jobs opportunity or prospect. Inline add row,
 *  inline status/title/deadline edit, complete checkbox, delete. Backed by
 *  /api/jobs/jobs-tasks. */
export function JobsTasks({ parentType, parentId }: JobsTasksProps) {
  const { data: tasks = [], isLoading } = useJobsTasks(parentType, parentId);
  const { data: users = [] } = useActiveUsers();
  const createTask = useCreateJobsTask(parentType, parentId);
  const updateTask = useUpdateJobsTask(parentType, parentId);
  const deleteTask = useDeleteJobsTask(parentType, parentId);

  const ownerOptions = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.display_name || u.email })),
    [users],
  );

  const isClosed = (t: JobsTask) => t.status === "Completed";

  const saveTitle = (id: string, title: string) =>
    updateTask.mutateAsync({ taskId: id, patch: { title } }).then(() => undefined);
  const saveStatus = (id: string, status: string) =>
    updateTask.mutateAsync({ taskId: id, patch: { status: status as JobsTaskStatus } }).then(() => undefined);
  const saveDeadline = (id: string, deadline: string | null) =>
    updateTask.mutateAsync({ taskId: id, patch: { deadline } }).then(() => undefined);
  const saveOwner = (id: string, ownerId: string) =>
    updateTask.mutateAsync({ taskId: id, patch: { owner_ids: ownerId ? [ownerId] : [] } }).then(() => undefined);
  const toggleComplete = (t: JobsTask) =>
    void updateTask.mutateAsync({
      taskId: t.id,
      patch: { status: isClosed(t) ? "Not Started" : "Completed" },
    });
  const removeTask = (t: JobsTask) => {
    if (!window.confirm(`Delete task "${t.title || "(untitled)"}"?`)) return;
    void deleteTask.mutateAsync(t.id);
  };

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
        Tasks {tasks.length > 0 ? `(${tasks.length})` : null}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-ink-3">
          <Loader2 size={12} className="animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong bg-surface">
          <table className="w-full table-fixed text-[12px]">
            <colgroup>
              <col style={{ width: 32 }} />
              <col />
              <col style={{ width: 130 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 36 }} />
            </colgroup>
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="px-2 py-1.5"></th>
                <th className="px-2 py-1.5 text-left font-semibold">Title</th>
                <th className="px-2 py-1.5 text-left font-semibold">Status</th>
                <th className="px-2 py-1.5 text-left font-semibold">Owner</th>
                <th className="px-2 py-1.5 text-right font-semibold">Deadline</th>
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {tasks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-4 text-center text-[12px] italic text-ink-3">
                    No tasks yet.
                  </td>
                </tr>
              ) : (
                tasks.map((t) => {
                  const closed = isClosed(t);
                  return (
                    <tr key={t.id} className={cn("group border-t border-border-strong", closed && "text-ink-3")}>
                      <td className="px-2 py-1.5 align-middle">
                        <input
                          type="checkbox"
                          checked={closed}
                          onChange={() => toggleComplete(t)}
                          className="h-3.5 w-3.5 cursor-pointer"
                          aria-label={closed ? "Reopen task" : "Mark complete"}
                        />
                      </td>
                      <td className="px-2 py-1.5 align-middle">
                        <InlineText
                          value={t.title}
                          onSave={(v) => saveTitle(t.id, v)}
                          placeholder="(untitled)"
                          className={cn("text-[12.5px]", closed && "line-through")}
                        />
                      </td>
                      <td className="px-2 py-1.5 align-middle">
                        <InlineSelect
                          value={t.status}
                          options={STATUS_OPTIONS}
                          onSave={(v) => saveStatus(t.id, v)}
                        />
                      </td>
                      <td className="px-2 py-1.5 align-middle">
                        {ownerOptions.length > 0 ? (
                          <InlineSelect
                            value={t.owner_ids[0] ?? null}
                            options={ownerOptions}
                            onSave={(v) => saveOwner(t.id, v)}
                            emptyLabel="—"
                          />
                        ) : (
                          <span className="text-[12px] text-ink-3">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 align-middle text-right">
                        <InlineDate
                          value={t.deadline}
                          onSave={(d) => saveDeadline(t.id, d)}
                          align="right"
                          placeholder="—"
                        />
                      </td>
                      <td className="px-1 py-1.5 align-middle text-right">
                        <button
                          type="button"
                          onClick={() => removeTask(t)}
                          aria-label="Delete task"
                          title="Delete task"
                          className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                        >
                          <Trash2 size={13} className="text-ink-3 hover:text-red" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          <NewTaskRow
            ownerOptions={ownerOptions}
            submitting={createTask.isPending}
            onCreate={(input) => createTask.mutateAsync(input).then(() => undefined)}
          />
        </div>
      )}
    </div>
  );
}

function NewTaskRow({
  ownerOptions,
  submitting,
  onCreate,
}: {
  ownerOptions: { value: string; label: string }[];
  submitting: boolean;
  onCreate: (input: { title: string; owner_ids?: string[]; deadline?: string | null }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [deadline, setDeadline] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const payload = {
      title: trimmed,
      owner_ids: ownerId ? [ownerId] : undefined,
      deadline: deadline || undefined,
    };
    setTitle("");
    setOwnerId("");
    setDeadline("");
    void onCreate(payload);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-strong bg-surface-2/40 px-3 py-1.5">
      <Plus size={13} className="flex-shrink-0 text-ink-3" />
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Add a task — press Enter"
        className="min-w-[160px] flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4"
      />
      {ownerOptions.length > 0 ? (
        <select
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          title="Owner"
          className="h-6 max-w-[140px] flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] text-ink outline-none focus:border-accent"
        >
          <option value="">Owner…</option>
          {ownerOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : null}
      <input
        type="date"
        value={deadline}
        onChange={(e) => setDeadline(e.target.value)}
        title="Deadline"
        className="h-6 flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[11.5px] text-ink outline-none focus:border-accent"
      />
      {title.trim() ? (
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="inline-flex items-center gap-1 rounded border border-ink bg-ink px-2 py-0.5 text-[11px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? <Loader2 size={11} className="animate-spin" /> : null}
          Create
        </button>
      ) : null}
    </div>
  );
}
