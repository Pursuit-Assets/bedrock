import { useMemo, useState } from "react";
import { Plus, ChevronDown, ChevronRight, Trash2 } from "lucide-react";

import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { useCollapsible } from "@/lib/collapsible";
import {
  useAccountTasks,
  useCreateAccountTask,
  useDeleteTask,
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

const PRIORITY_OPTIONS = [
  { value: "Low", label: "Low" },
  { value: "Normal", label: "Normal" },
  { value: "High", label: "High" },
];

const OPEN_LIST_MAX_H = 360;

type TaskScope = "open" | "completed" | "all";

function isTaskClosed(t: SfTask): boolean {
  if (t.IsClosed != null) return !!t.IsClosed;
  return t.Status === "Completed";
}

/**
 * All tasks for an account: ones tied directly (WhatId = account_id) and
 * ones tied to the account's opportunities. The backend unions both in
 * a single SOQL; here we just render them with a small "→ Opp Name"
 * context badge so users can see which is which.
 *
 * New-task creation defaults to account-level (WhatId = account_id). To
 * create an opp-tied task, open the opportunity's detail page.
 */
export function AccountTasksSection({
  accountId,
}: {
  accountId: string;
}) {
  const { data: tasks = [], isLoading } = useAccountTasks(accountId);
  const updateTask = useUpdateTask();
  const createTask = useCreateAccountTask();
  const deleteTask = useDeleteTask();
  const usersQ = useActiveUsers();

  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({
        value: u.Id,
        label: u.Name,
      })),
    [usersQ.data],
  );

  const [scope, setScope] = useState<TaskScope>("open");
  const [clobberWarning, setClobberWarning] = useState<{
    intended: string;
    saved: string | null;
    field: string;
  } | null>(null);
  // SF returns ORDER BY ActivityDate DESC NULLS LAST, which sinks any
  // task without a due date to the bottom — including the one the user
  // just created. Re-sort by CreatedDate DESC so newly-added tasks
  // always appear at the top of the open list. Falls back to
  // ActivityDate if CreatedDate is missing for some reason.
  const sortByCreated = (a: SfTask, b: SfTask) => {
    const ad = a.CreatedDate ?? a.ActivityDate ?? "";
    const bd = b.CreatedDate ?? b.ActivityDate ?? "";
    return bd.localeCompare(ad);
  };
  const open = tasks.filter((t) => !isTaskClosed(t)).sort(sortByCreated);
  const closed = tasks.filter((t) => isTaskClosed(t)).sort(sortByCreated);
  const visibleTasks =
    scope === "open" ? open : scope === "completed" ? closed : [...open, ...closed];

  const saveStatus = (id: string, status: string) =>
    updateTask.mutateAsync({ id, patch: { Status: status } }).then(() => undefined);
  const savePriority = (id: string, priority: string) =>
    updateTask.mutateAsync({ id, patch: { Priority: priority } }).then(() => undefined);
  const saveDate = (id: string, date: string | null) =>
    updateTask.mutateAsync({ id, patch: { ActivityDate: date } }).then(() => undefined);
  const saveOwner = (id: string, ownerId: string) =>
    updateTask.mutateAsync({ id, patch: { OwnerId: ownerId } }).then(() => undefined);
  const saveSubject = (id: string, subject: string) =>
    updateTask.mutateAsync({ id, patch: { Subject: subject } }).then(() => undefined);
  const saveDescription = async (id: string, description: string) => {
    const result = await updateTask.mutateAsync({
      id,
      patch: { Description: description },
    });
    if (result?.data?.clobbered_fields?.includes("Description")) {
      const saved =
        (result.data.saved_values?.Description as string | undefined) ?? "(empty)";
      setClobberWarning({ intended: description, saved, field: "Description" });
    }
  };
  const removeTask = (id: string) => {
    if (typeof window !== "undefined" && !window.confirm("Delete this task?")) return;
    void deleteTask.mutateAsync(id);
  };

  const toggleComplete = (t: SfTask) => {
    const nextStatus = isTaskClosed(t) ? "Not Started" : "Completed";
    void updateTask.mutateAsync({
      id: t.Id,
      patch: { Status: nextStatus },
    });
  };

  return (
    <div className="mt-6 flex flex-col gap-4">
      {clobberWarning ? (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
          <span className="mt-0.5">⚠️</span>
          <div className="flex-1">
            <p className="font-semibold">
              Salesforce overwrote the task {clobberWarning.field.toLowerCase()}.
            </p>
            <p className="mt-0.5">
              You entered <strong>"{clobberWarning.intended}"</strong>, but
              Salesforce saved it as{" "}
              <strong>"{clobberWarning.saved ?? "(empty)"}"</strong>. This is
              almost always an Apex Trigger or Flow on the Task object —
              ask a Salesforce admin to investigate (we tried to restore your
              value once and it was overwritten again).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setClobberWarning(null)}
            className="text-amber-700 hover:text-amber-900"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ) : null}
      <SectionShell title="Tasks" defaultOpen={open.length > 0}>
        <div className="flex items-center gap-1.5 border-b border-border-strong bg-surface-2/40 px-5 py-2">
          {(["open", "completed", "all"] as const).map((s) => {
            const label =
              s === "open" ? "Open" : s === "completed" ? "Completed" : "All";
            const n =
              s === "open" ? open.length : s === "completed" ? closed.length : tasks.length;
            const active = scope === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={cn(
                  "rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium transition-colors",
                  active
                    ? "border-accent bg-accent/10 text-ink"
                    : "border-border-strong bg-surface text-ink-3 hover:bg-surface-2",
                )}
              >
                {label} · {n}
              </button>
            );
          })}
        </div>
        {isLoading ? (
          <Loading />
        ) : visibleTasks.length === 0 ? (
          <Empty>
            No {scope === "open" ? "open" : scope === "completed" ? "completed" : ""} tasks.
          </Empty>
        ) : (
          <ScrollList maxH={OPEN_LIST_MAX_H}>
            {visibleTasks.map((t) => (
              <TaskRow
                key={t.Id}
                t={t}
                accountId={accountId}
                ownerOptions={ownerOptions}
                onToggleComplete={() => toggleComplete(t)}
                onSaveStatus={(s) => saveStatus(t.Id, s)}
                onSavePriority={(p) => savePriority(t.Id, p)}
                onSaveDate={(d) => saveDate(t.Id, d)}
                onSaveOwner={(o) => saveOwner(t.Id, o)}
                onSaveSubject={(s) => saveSubject(t.Id, s)}
                onSaveDescription={(d) => saveDescription(t.Id, d)}
                onDelete={() => removeTask(t.Id)}
              />
            ))}
          </ScrollList>
        )}
        <NewTaskRow
          disabled={createTask.isPending}
          onCreate={async (subject) => {
            const result = await createTask.mutateAsync({
              accountId,
              body: { Subject: subject },
            });
            if (result?.data?.subject_clobbered) {
              setClobberWarning({
                intended: subject,
                saved: result.data.saved_subject ?? null,
                field: "Subject",
              });
            }
          }}
        />
      </SectionShell>
    </div>
  );
}

function SectionShell({
  title,
  children,
  dim,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  dim?: boolean;
  defaultOpen?: boolean;
}) {
  const { open, toggle } = useCollapsible(
    `bedrock-v2:section:account-tasks${dim ? "-closed" : ""}`,
    defaultOpen,
  );
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border-strong shadow-sm",
        dim ? "bg-surface-2/50" : "bg-surface",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 border-b border-border-strong px-5 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wider",
          dim ? "bg-surface-2/70 text-ink-4" : "bg-surface-2 text-ink-3",
        )}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
      </button>
      {open ? children : null}
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
  accountId,
  ownerOptions,
  onToggleComplete,
  onSaveStatus,
  onSavePriority,
  onSaveDate,
  onSaveOwner,
  onSaveSubject,
  onSaveDescription,
  onDelete,
}: {
  t: SfTask;
  accountId: string;
  ownerOptions: { value: string; label: string }[];
  onToggleComplete: () => void;
  onSaveStatus: (next: string) => Promise<void>;
  onSavePriority: (next: string) => Promise<void>;
  onSaveDate: (next: string | null) => Promise<void>;
  onSaveOwner: (next: string) => Promise<void>;
  onSaveSubject: (next: string) => Promise<void>;
  onSaveDescription: (next: string) => Promise<void>;
  onDelete: () => void;
}) {
  // SF Id prefixes: 001 = Account, 006 = Opportunity. Anything else (or
  // the same account_id) we treat as an account-level task.
  const tiedToOpp = t.WhatId && t.WhatId.startsWith("006");
  const tiedToAccount = t.WhatId === accountId;
  const [expanded, setExpanded] = useState(false);
  const closed = isTaskClosed(t);

  return (
    <li className={cn("border-b border-border-strong last:border-b-0", closed && "text-ink-3")}>
      <div className="group flex items-center gap-3 px-5 py-2 hover:bg-surface-2/40">
        <input
          type="checkbox"
          checked={closed}
          onChange={onToggleComplete}
          className="h-4 w-4 cursor-pointer flex-shrink-0"
          aria-label={closed ? "Reopen task" : "Mark complete"}
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-shrink-0 text-ink-4 hover:text-ink-2"
          aria-label={expanded ? "Collapse details" : "View details"}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "flex min-w-0 flex-1 flex-col leading-tight text-left",
            closed && "line-through",
          )}
        >
          <span className="truncate text-[13px]" title={t.Subject ?? ""}>
            {t.Subject ?? "(no subject)"}
          </span>
          <span className="truncate text-[11px] text-ink-4">
            {tiedToOpp && t.WhatName
              ? `→ ${t.WhatName}`
              : tiedToAccount
                ? "Account-level"
                : tiedToOpp
                  ? "→ Opportunity"
                  : "—"}
          </span>
        </button>
        <div className="w-[130px] flex-shrink-0">
          <InlineSelect
            value={t.Status ?? null}
            options={STATUS_OPTIONS}
            onSave={onSaveStatus}
          />
        </div>
        <div className="w-[80px] flex-shrink-0">
          <InlineSelect
            value={t.Priority ?? null}
            options={PRIORITY_OPTIONS}
            onSave={onSavePriority}
          />
        </div>
        <div className="w-[130px] flex-shrink-0">
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
        <button
          type="button"
          onClick={onDelete}
          className="flex-shrink-0 rounded p-1 text-ink-4 opacity-0 transition-opacity hover:text-red focus:opacity-100 group-hover:opacity-100"
          aria-label="Delete task"
          title="Delete task"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-border-strong bg-surface-2/30 px-5 py-3">
          <div className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-2 text-[12.5px]">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Subject
            </span>
            <InlineText
              value={t.Subject ?? ""}
              onSave={onSaveSubject}
              placeholder="(no subject)"
            />

            <span className="pt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
              Description
            </span>
            <InlineText
              value={t.Description ?? ""}
              onSave={onSaveDescription}
              placeholder="Add details…"
              multiline
            />

            {t.Type ? (
              <>
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                  Type
                </span>
                <span className="text-ink-2">{t.Type}</span>
              </>
            ) : null}

            {t.CreatedDate || t.LastModifiedDate ? (
              <>
                <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
                  Audit
                </span>
                <span className="mono text-[11px] text-ink-3">
                  {t.CreatedDate
                    ? `Created ${new Date(t.CreatedDate).toLocaleDateString()}`
                    : null}
                  {t.CreatedDate && t.LastModifiedDate ? " · " : null}
                  {t.LastModifiedDate
                    ? `Updated ${new Date(t.LastModifiedDate).toLocaleDateString()}`
                    : null}
                </span>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function NewTaskRow({
  onCreate,
  disabled,
}: {
  onCreate: (subject: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [subject, setSubject] = useState("");

  const submit = async () => {
    const trimmed = subject.trim();
    if (!trimmed || disabled) return;
    await onCreate(trimmed);
    setSubject("");
  };

  return (
    <div className="flex items-center gap-3 border-t border-border-strong bg-surface-2/40 px-5 py-2">
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
        placeholder="Add an account-level task — press Enter to create"
        disabled={disabled}
        className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4 disabled:opacity-50"
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

function Loading() {
  return (
    <div className="px-5 py-6 text-center text-[12.5px] text-ink-3">
      Loading tasks…
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
