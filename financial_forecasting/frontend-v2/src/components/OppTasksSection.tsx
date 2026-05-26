import { useMemo, useState } from "react";
import { Plus, ChevronDown, ChevronRight } from "lucide-react";

import { InlineDate, InlineSelect } from "@/components/ui/InlineEdit";
import {
  useCreateTask,
  useOpportunityTasks,
  useUpdateTask,
} from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";
import { cn } from "@/lib/utils";
import type { SfTask } from "@/types/salesforce";

const STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Waiting on someone else", label: "Waiting" },
  { value: "Deferred", label: "Deferred" },
  { value: "Completed", label: "Completed" },
];

// IsClosed is the SF-computed truth, but the v2 endpoint doesn't always
// emit it (older deployments stripped it from the SOQL). Derive a
// fallback from Status so the UI is correct even if the backend hasn't
// been restarted with the SELECT IsClosed fix.
function isTaskClosed(t: SfTask): boolean {
  if (t.IsClosed != null) return !!t.IsClosed;
  return t.Status === "Completed";
}

const PRIORITY_OPTIONS = [
  { value: "Low", label: "Low" },
  { value: "Normal", label: "Normal" },
  { value: "High", label: "High" },
];

const OPEN_LIST_MAX_H = 280; // px — ~6 rows; scrolls past
const CLOSED_LIST_MAX_H = 240; // px — ~5 rows

/**
 * Tasks list for a single opportunity. Open and completed tasks live in
 * visually distinct sections so the daily-work surface (open) doesn't
 * scroll past historical work. Inline edit on Status, Priority, Owner,
 * and ActivityDate; complete-checkbox shortcut; "+ New task" footer row.
 */
export function OppTasksSection({
  opportunityId,
  heading,
}: {
  opportunityId: string;
  heading?: string;
}) {
  const { data: tasks = [], isLoading } = useOpportunityTasks(opportunityId);
  const updateTask = useUpdateTask();
  const createTask = useCreateTask();
  const usersQ = useActiveUsers();

  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({
        value: u.Id,
        label: u.Name,
      })),
    [usersQ.data],
  );

  const [showClosed, setShowClosed] = useState(false);
  const open = tasks.filter((t) => !isTaskClosed(t));
  const closed = tasks.filter((t) => isTaskClosed(t));

  const saveStatus = (id: string, status: string) =>
    updateTask
      .mutateAsync({ id, patch: { Status: status } })
      .then(() => undefined);

  const savePriority = (id: string, priority: string) =>
    updateTask
      .mutateAsync({ id, patch: { Priority: priority } })
      .then(() => undefined);

  const saveDate = (id: string, date: string | null) =>
    updateTask
      .mutateAsync({ id, patch: { ActivityDate: date } })
      .then(() => undefined);

  const saveOwner = (id: string, ownerId: string) =>
    updateTask
      .mutateAsync({ id, patch: { OwnerId: ownerId } })
      .then(() => undefined);

  const toggleComplete = (t: SfTask) => {
    const nextStatus = isTaskClosed(t) ? "Not Started" : "Completed";
    void updateTask.mutateAsync({
      id: t.Id,
      patch: { Status: nextStatus },
    });
  };

  const baseHeading = heading ?? "Tasks";

  return (
    <div className="mt-6 flex flex-col gap-4">
      {/* Open tasks */}
      <SectionShell title={`${baseHeading} · Open (${open.length})`}>
        {isLoading ? (
          <div className="px-5 py-6 text-center text-[12.5px] text-ink-3">
            Loading tasks…
          </div>
        ) : open.length === 0 ? (
          <Empty>No open tasks.</Empty>
        ) : (
          <ScrollList maxH={OPEN_LIST_MAX_H}>
            {open.map((t) => (
              <TaskRow
                key={t.Id}
                t={t}
                ownerOptions={ownerOptions}
                onToggleComplete={() => toggleComplete(t)}
                onSaveStatus={(s) => saveStatus(t.Id, s)}
                onSavePriority={(p) => savePriority(t.Id, p)}
                onSaveDate={(d) => saveDate(t.Id, d)}
                onSaveOwner={(o) => saveOwner(t.Id, o)}
              />
            ))}
          </ScrollList>
        )}

        <NewTaskRow
          disabled={createTask.isPending}
          ownerOptions={ownerOptions}
          onCreate={async ({ subject, ownerId, activityDate }) => {
            await createTask.mutateAsync({
              opportunityId,
              body: {
                Subject: subject,
                OwnerId: ownerId ?? undefined,
                ActivityDate: activityDate ?? undefined,
              },
            });
          }}
        />
      </SectionShell>

      {/* Completed tasks — collapsible */}
      {closed.length > 0 ? (
        <section className="overflow-hidden rounded-lg border border-border-strong bg-surface-2/50 shadow-sm">
          <button
            onClick={() => setShowClosed((v) => !v)}
            className="flex w-full items-center gap-1.5 border-b border-border-strong bg-surface-2/70 px-5 py-2.5 text-[12px] font-semibold uppercase tracking-wider text-ink-4 hover:text-ink-3"
          >
            {showClosed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {baseHeading} · Completed ({closed.length})
          </button>
          {showClosed && (
            <ScrollList maxH={CLOSED_LIST_MAX_H}>
              {closed.map((t) => (
                <TaskRow
                  key={t.Id}
                  t={t}
                  ownerOptions={ownerOptions}
                  onToggleComplete={() => toggleComplete(t)}
                  onSaveStatus={(s) => saveStatus(t.Id, s)}
                  onSavePriority={(p) => savePriority(t.Id, p)}
                  onSaveDate={(d) => saveDate(t.Id, d)}
                  onSaveOwner={(o) => saveOwner(t.Id, o)}
                />
              ))}
            </ScrollList>
          )}
        </section>
      ) : null}
    </div>
  );
}

function SectionShell({
  title,
  children,
  dim,
}: {
  title: string;
  children: React.ReactNode;
  dim?: boolean;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border-strong shadow-sm",
        dim ? "bg-surface-2/50" : "bg-surface",
      )}
    >
      <div
        className={cn(
          "border-b border-border-strong px-5 py-2.5 text-[12px] font-semibold uppercase tracking-wider",
          dim ? "bg-surface-2/70 text-ink-4" : "bg-surface-2 text-ink-3",
        )}
      >
        {title}
      </div>
      {children}
    </section>
  );
}

function ScrollList({
  children,
  maxH,
}: {
  children: React.ReactNode;
  maxH: number;
}) {
  return (
    <ul
      className="flex flex-col overflow-auto"
      style={{ maxHeight: `${maxH}px` }}
    >
      {children}
    </ul>
  );
}

function TaskRow({
  t,
  ownerOptions,
  onToggleComplete,
  onSaveStatus,
  onSavePriority,
  onSaveDate,
  onSaveOwner,
}: {
  t: SfTask;
  ownerOptions: { value: string; label: string }[];
  onToggleComplete: () => void;
  onSaveStatus: (next: string) => Promise<void>;
  onSavePriority: (next: string) => Promise<void>;
  onSaveDate: (next: string | null) => Promise<void>;
  onSaveOwner: (next: string) => Promise<void>;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-b border-border-strong px-5 py-2 last:border-b-0",
        isTaskClosed(t) && "text-ink-3",
      )}
    >
      <input
        type="checkbox"
        checked={isTaskClosed(t)}
        onChange={onToggleComplete}
        className="h-4 w-4 cursor-pointer"
        aria-label={isTaskClosed(t) ? "Reopen task" : "Mark complete"}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[13px]",
          isTaskClosed(t) && "line-through",
        )}
        title={t.Subject ?? ""}
      >
        {t.Subject ?? "(no subject)"}
      </span>
      <div className="w-[140px] flex-shrink-0">
        <InlineSelect
          value={t.Status ?? null}
          options={STATUS_OPTIONS}
          onSave={onSaveStatus}
        />
      </div>
      <div className="w-[90px] flex-shrink-0">
        <InlineSelect
          value={t.Priority ?? null}
          options={PRIORITY_OPTIONS}
          onSave={onSavePriority}
        />
      </div>
      <div className="w-[140px] flex-shrink-0">
        <InlineSelect
          value={t.OwnerId ?? null}
          options={ownerOptions}
          onSave={onSaveOwner}
          renderValue={() => (
            <span className="truncate text-[12.5px] text-ink-2">
              {t.OwnerName ??
                ownerOptions.find((o) => o.value === t.OwnerId)?.label ??
                "—"}
            </span>
          )}
        />
      </div>
      <div className="w-[130px] flex-shrink-0">
        <InlineDate
          value={t.ActivityDate}
          onSave={onSaveDate}
          align="right"
          placeholder="—"
        />
      </div>
    </li>
  );
}

function NewTaskRow({
  onCreate,
  disabled,
  ownerOptions,
}: {
  onCreate: (input: { subject: string; ownerId?: string | null; activityDate?: string | null }) => Promise<void>;
  disabled?: boolean;
  ownerOptions?: { value: string; label: string }[];
}) {
  const [subject, setSubject] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [dueDate, setDueDate] = useState("");

  const submit = async () => {
    const trimmed = subject.trim();
    if (!trimmed || disabled) return;
    await onCreate({
      subject: trimmed,
      ownerId: ownerId || null,
      activityDate: dueDate || null,
    });
    setSubject("");
    setOwnerId("");
    setDueDate("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-strong bg-surface-2/40 px-5 py-2">
      <Plus size={14} className="flex-shrink-0 text-ink-3" />
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Add a task — press Enter to create"
        disabled={disabled}
        className="min-w-[180px] flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
      />
      {ownerOptions && ownerOptions.length > 0 ? (
        <select
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          disabled={disabled}
          title="Assignee"
          className="h-7 max-w-[160px] flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent disabled:opacity-50"
        >
          <option value="">Assignee…</option>
          {ownerOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : null}
      <input
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        disabled={disabled}
        title="Due date"
        className="h-7 flex-shrink-0 rounded border border-border-strong bg-surface px-1.5 text-[12px] text-ink outline-none focus:border-accent disabled:opacity-50"
      />
      {subject.trim() ? (
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="rounded border border-ink bg-ink px-2.5 py-0.5 text-[11px] font-medium text-surface hover:opacity-90 disabled:opacity-50"
        >
          Create
        </button>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-6 text-center text-[12.5px] text-ink-3">
      {children}
    </div>
  );
}
