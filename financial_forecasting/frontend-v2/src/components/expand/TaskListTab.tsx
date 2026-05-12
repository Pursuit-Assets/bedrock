import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";

import { InlineDate, InlineSelect } from "@/components/ui/InlineEdit";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { sortBy, useSort } from "@/lib/sort";
import { useUpdateTask } from "@/services/opportunities";
import { cn } from "@/lib/utils";
import type { SfTask } from "@/types/salesforce";

type TaskSortKey = "subject" | "status" | "due";

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
  // Tap the overdue counter to filter the list. State is local to the
  // panel so different parent records (per-account, per-owner) each
  // keep their own toggle.
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [query, setQuery] = useState("");
  const { sort, toggle } = useSort<TaskSortKey>();

  const open = useMemo(
    () => tasks.filter((t) => !isTaskClosed(t)),
    [tasks],
  );
  const overdueCount = useMemo(
    () => open.filter(isOverdue).length,
    [open],
  );
  const visible = useMemo(() => {
    const base = overdueOnly ? open.filter(isOverdue) : open;
    const q = query.trim().toLowerCase();
    const filtered = base.filter((t) => {
      if (!q) return true;
      if ((t.Subject ?? "").toLowerCase().includes(q)) return true;
      if ((t.Status ?? "").toLowerCase().includes(q)) return true;
      if ((t.WhatName ?? "").toLowerCase().includes(q)) return true;
      return false;
    });
    if (sort.key == null) return filtered;
    return sortBy(filtered, sort, (t, key) => {
      switch (key) {
        case "subject": return t.Subject ?? "";
        case "status": return t.Status ?? "";
        case "due": return t.ActivityDate ?? "";
      }
    });
  }, [open, overdueOnly, query, sort]);

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
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading ? "…" : `${visible.length} ${overdueOnly ? "overdue" : "open"}`}
          {overdueOnly ? (
            <button
              type="button"
              onClick={() => setOverdueOnly(false)}
              className="ml-1.5 normal-case text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              show all open ({open.length})
            </button>
          ) : null}
        </span>
        <div className="flex items-center gap-3">
          {overdueCount > 0 ? (
            <button
              type="button"
              onClick={() => setOverdueOnly((v) => !v)}
              className={cn(
                "font-semibold text-amber-700 underline-offset-2 hover:underline",
                overdueOnly && "underline",
              )}
              aria-pressed={overdueOnly}
              title={overdueOnly ? "Show all open tasks" : "Show overdue only"}
            >
              {overdueCount} overdue
            </button>
          ) : null}
          {open.length > 0 ? <TaskSearchBox value={query} onChange={setQuery} /> : null}
        </div>
      </div>

      {isLoading ? (
        <div className="text-[12px] text-ink-3">Loading tasks…</div>
      ) : visible.length === 0 ? (
        <>
          <div className="rounded border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-ink-3">
            {overdueOnly ? "No overdue tasks." : emptyMessage}
          </div>
          {onCreate && !overdueOnly ? (
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
                <th className="px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Subject" sortKey="subject" sort={sort} onToggle={toggle} />
                </th>
                <th className="w-[130px] px-3 py-1.5 text-left font-semibold">
                  <SortableHeader label="Status" sortKey="status" sort={sort} onToggle={toggle} />
                </th>
                <th className="w-[110px] px-3 py-1.5 text-right font-semibold">
                  <SortableHeader label="Due" sortKey="due" sort={sort} onToggle={toggle} align="right" />
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
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
          {onCreate && !overdueOnly ? (
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

function TaskSearchBox({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <div className="relative">
      <Search
        size={11}
        className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-ink-4"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter tasks…"
        className="h-6 w-[160px] rounded border border-border-strong bg-surface pl-5 pr-5 text-[11.5px] normal-case outline-none focus:border-accent"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
          aria-label="Clear"
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}
