import { useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { InlineDate, InlineSelect } from "@/components/ui/InlineEdit";
import { useUpdateTask } from "@/services/opportunities";
import { cn } from "@/lib/utils";
import type { SfTask } from "@/types/salesforce";

const STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Waiting on someone else", label: "Waiting" },
  { value: "Deferred", label: "Deferred" },
  { value: "Completed", label: "Completed" },
];

export function isTaskClosed(t: SfTask): boolean {
  if (t.IsClosed != null) return !!t.IsClosed;
  return t.Status === "Completed";
}

function isOverdue(t: SfTask): boolean {
  if (!t.ActivityDate || isTaskClosed(t)) return false;
  const due = new Date(t.ActivityDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return due < today;
}

/**
 * Editable task list rendered in the same Payments-style table the
 * other expand-tabs use: bordered card, sticky thead with column
 * labels, inline-edit cells. `onCreate` is optional — when provided,
 * the "add task" row sits inside the same card under the table.
 *
 * `contextResolver` returns a per-row label (e.g. parent opp name)
 * shown as a subtitle line under the subject — used by the Account
 * panel for tasks rolled up from child opps.
 */
export function TaskListTab({
  tasks,
  isLoading,
  emptyMessage = "No open tasks.",
  placeholder = "Add a task — press Enter to create",
  onCreate,
  contextResolver,
}: {
  tasks: SfTask[];
  isLoading: boolean;
  emptyMessage?: string;
  placeholder?: string;
  onCreate?: (subject: string) => Promise<void>;
  contextResolver?: (t: SfTask) => string | null;
}) {
  const updateTask = useUpdateTask();

  const open = useMemo(
    () => tasks.filter((t) => !isTaskClosed(t)),
    [tasks],
  );
  const overdueCount = useMemo(
    () => open.filter(isOverdue).length,
    [open],
  );

  const saveStatus = (id: string, status: string) =>
    updateTask.mutateAsync({ id, patch: { Status: status } }).then(() => undefined);
  const saveDate = (id: string, date: string | null) =>
    updateTask.mutateAsync({ id, patch: { ActivityDate: date } }).then(() => undefined);
  const toggleComplete = (t: SfTask) =>
    void updateTask.mutateAsync({
      id: t.Id,
      patch: { Status: isTaskClosed(t) ? "Not Started" : "Completed" },
    });

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wider text-ink-3">
        <span>{isLoading ? "…" : `${open.length} open`}</span>
        {overdueCount > 0 ? (
          <span className="font-semibold text-amber-700">
            {overdueCount} overdue
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading tasks…</div>
      ) : open.length === 0 ? (
        <>
          <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
            {emptyMessage}
          </div>
          {onCreate ? (
            <div className="mt-2 overflow-hidden rounded border border-border-strong bg-surface">
              <NewTaskRow placeholder={placeholder} onCreate={onCreate} />
            </div>
          ) : null}
        </>
      ) : (
        <div className="overflow-hidden rounded border border-border-strong bg-surface">
          <table className="w-full text-[12px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-[28px] px-3 py-1.5"></th>
                <th className="px-3 py-1.5 text-left font-semibold">Subject</th>
                <th className="w-[130px] px-3 py-1.5 text-left font-semibold">
                  Status
                </th>
                <th className="w-[110px] px-3 py-1.5 text-right font-semibold">
                  Due
                </th>
              </tr>
            </thead>
            <tbody>
              {open.map((t) => (
                <TaskRow
                  key={t.Id}
                  t={t}
                  contextLabel={contextResolver?.(t) ?? null}
                  onToggleComplete={() => toggleComplete(t)}
                  onSaveStatus={(s) => saveStatus(t.Id, s)}
                  onSaveDate={(d) => saveDate(t.Id, d)}
                />
              ))}
            </tbody>
          </table>
          {onCreate ? (
            <NewTaskRow placeholder={placeholder} onCreate={onCreate} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function TaskRow({
  t,
  contextLabel,
  onToggleComplete,
  onSaveStatus,
  onSaveDate,
}: {
  t: SfTask;
  contextLabel: string | null;
  onToggleComplete: () => void;
  onSaveStatus: (next: string) => Promise<void>;
  onSaveDate: (next: string | null) => Promise<void>;
}) {
  const closed = isTaskClosed(t);
  const overdue = isOverdue(t);
  return (
    <tr
      className={cn(
        "border-t border-border-strong",
        closed && "text-ink-3",
      )}
    >
      <td className="px-3 py-1.5 align-middle">
        <input
          type="checkbox"
          checked={closed}
          onChange={onToggleComplete}
          className="h-3.5 w-3.5 cursor-pointer"
          aria-label={closed ? "Reopen task" : "Mark complete"}
        />
      </td>
      <td className="px-3 py-1.5 align-middle">
        <span
          className={cn(
            "block truncate text-[12.5px]",
            closed && "line-through",
          )}
          title={t.Subject ?? ""}
        >
          {t.Subject ?? "(no subject)"}
        </span>
        {contextLabel ? (
          <span
            className="block truncate text-[10.5px] text-ink-3"
            title={contextLabel}
          >
            {contextLabel}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-1.5 align-middle">
        <InlineSelect
          value={t.Status ?? null}
          options={STATUS_OPTIONS}
          onSave={onSaveStatus}
        />
      </td>
      <td
        className={cn(
          "px-3 py-1.5 align-middle text-right",
          overdue && "text-red",
        )}
      >
        <InlineDate
          value={t.ActivityDate}
          onSave={onSaveDate}
          align="right"
          placeholder="—"
        />
      </td>
    </tr>
  );
}

function NewTaskRow({
  onCreate,
  placeholder,
}: {
  onCreate: (subject: string) => Promise<void>;
  placeholder: string;
}) {
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = subject.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onCreate(trimmed);
      setSubject("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 border-t border-border-strong bg-surface-2/40 px-4 py-1.5">
      <Plus size={13} className="flex-shrink-0 text-ink-3" />
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={busy}
        className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
      />
      {subject.trim() ? (
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded border border-ink bg-ink px-2 py-0.5 text-[11px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      ) : null}
    </div>
  );
}
