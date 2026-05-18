import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Flag, Inbox } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SfMyTask } from "@/services/tasks";
import { useActiveUsers } from "@/services/users";
import type { FlatTask } from "@/components/TaskDrawer";

const URGENT_OVERRIDE_KEY = "pursuit-urgent-overrides";
const MIN_INBOX_HEIGHT = 200;
const MAX_INBOX_HEIGHT = 720;
const RESIZE_HANDLE_HEIGHT = 6;

export interface TaskInboxProps {
  tasks: SfMyTask[];
  loading?: boolean;
  /** Current user's SF id — defaults the assignee filter to "mine". */
  currentUserId?: string | null;
  /** Persisted max height in px. Caller owns persistence — call onHeightChange. */
  maxHeight?: number;
  onHeightChange?: (px: number) => void;
  /**
   * Click a row → caller opens TaskDrawer. Receives a FlatTask shape so the
   * drawer's edit hooks can patch through directly.
   */
  onTaskClick?: (task: FlatTask) => void;
  /** Optional decoration on the header (icon + title come from this slot). */
  headerSlot?: React.ReactNode;
  className?: string;
}

type AssigneeFilter = "me" | "all" | string;
type Sort = "deadline-asc" | "deadline-desc" | "priority" | "subject";

/**
 * Daily-work inbox for SF tasks owned by the current user (or anyone).
 *
 * Source of truth is `useMyTasks` upstream — the caller passes the array
 * so this component stays purely presentational. Click handler hands back
 * a FlatTask the TaskDrawer can edit. Urgent toggles persist to
 * `pursuit-urgent-overrides` to match the legacy frontend's key (zero
 * migration friction for users who already had flags).
 */
export function TaskInbox({
  tasks,
  loading = false,
  currentUserId,
  maxHeight = 400,
  onHeightChange,
  onTaskClick,
  headerSlot,
  className,
}: TaskInboxProps) {
  const usersQ = useActiveUsers();

  const [filter, setFilter] = useState<AssigneeFilter>(
    currentUserId ? "me" : "all",
  );
  const [sort, setSort] = useState<Sort>("deadline-asc");
  const [urgent, setUrgent] = useState<Record<string, boolean>>(() =>
    readUrgent(),
  );

  // ── urgent override persistence ────────────────────────────────────────
  const persistUrgent = useCallback((next: Record<string, boolean>) => {
    setUrgent(next);
    try {
      window.localStorage.setItem(URGENT_OVERRIDE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  const toggleUrgent = useCallback(
    (id: string) => {
      persistUrgent({ ...urgent, [id]: !urgent[id] });
    },
    [urgent, persistUrgent],
  );

  // ── filter + sort ──────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const openOnly = tasks.filter(
      (t) => t.Status !== "Completed" && !t.IsClosed,
    );
    const byOwner = openOnly.filter((t) => {
      if (filter === "all") return true;
      if (filter === "me") return t.OwnerId === currentUserId;
      return t.OwnerId === filter;
    });
    const compared = [...byOwner].sort((a, b) => {
      // Urgent always floats to the top.
      const ua = urgent[a.Id] ? 0 : 1;
      const ub = urgent[b.Id] ? 0 : 1;
      if (ua !== ub) return ua - ub;
      if (sort === "subject") {
        return (a.Subject ?? "").localeCompare(b.Subject ?? "");
      }
      if (sort === "priority") {
        return priorityRank(a.Priority) - priorityRank(b.Priority);
      }
      const da = a.ActivityDate ?? "9999-12-31";
      const db = b.ActivityDate ?? "9999-12-31";
      const cmp = da.localeCompare(db);
      return sort === "deadline-asc" ? cmp : -cmp;
    });
    return compared;
  }, [tasks, filter, currentUserId, sort, urgent]);

  // ── resize handle ──────────────────────────────────────────────────────
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [draftHeight, setDraftHeight] = useState(maxHeight);
  useEffect(() => setDraftHeight(maxHeight), [maxHeight]);

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: draftHeight };
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clamp(d.startH + (e.clientY - d.startY), MIN_INBOX_HEIGHT, MAX_INBOX_HEIGHT);
    setDraftHeight(next);
  };
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    onHeightChange?.(draftHeight);
  };

  // ── render ─────────────────────────────────────────────────────────────
  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  return (
    <section
      className={cn(
        "flex h-full flex-col rounded-lg border border-border-strong bg-surface",
        className,
      )}
    >
      <header className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-3 py-2">
        {headerSlot ?? (
          <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Inbox size={15} className="text-accent" /> Inbox
          </div>
        )}
        <span className="ml-0.5 rounded bg-surface px-1.5 py-px text-[11px] font-semibold text-ink-3">
          {visible.length}
        </span>
        <div className="flex-1" />
        <FilterSelect
          ariaLabel="Assignee filter"
          value={filter}
          onChange={(v) => setFilter(v as AssigneeFilter)}
          options={[
            { value: "me", label: "Mine" },
            { value: "all", label: "All" },
            ...ownerOptions,
          ]}
        />
        <FilterSelect
          ariaLabel="Sort"
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          options={[
            { value: "deadline-asc", label: "Due ↑" },
            { value: "deadline-desc", label: "Due ↓" },
            { value: "priority", label: "Priority" },
            { value: "subject", label: "Subject" },
          ]}
        />
      </header>

      <div
        className="flex-1 overflow-y-auto"
        style={{ maxHeight: draftHeight - RESIZE_HANDLE_HEIGHT }}
      >
        {loading ? (
          <SkeletonRows />
        ) : visible.length === 0 ? (
          <Empty
            mineFiltered={filter === "me"}
            onAll={() => setFilter("all")}
          />
        ) : (
          <ul className="flex flex-col">
            {visible.map((t) => (
              <TaskRow
                key={t.Id}
                task={t}
                urgent={!!urgent[t.Id]}
                onToggleUrgent={() => toggleUrgent(t.Id)}
                onClick={() => onTaskClick?.(toFlatTask(t))}
              />
            ))}
          </ul>
        )}
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize inbox height"
        aria-valuemin={MIN_INBOX_HEIGHT}
        aria-valuemax={MAX_INBOX_HEIGHT}
        aria-valuenow={draftHeight}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        className="group flex h-1.5 flex-shrink-0 cursor-row-resize items-center justify-center border-t border-border-strong bg-surface-2 hover:bg-accent-soft"
      >
        <span className="h-[2px] w-10 rounded bg-border-strong transition-colors group-hover:bg-accent" />
      </div>
    </section>
  );
}

function TaskRow({
  task,
  urgent,
  onClick,
  onToggleUrgent,
}: {
  task: SfMyTask;
  urgent: boolean;
  onClick: () => void;
  onToggleUrgent: () => void;
}) {
  const badge = dueBadge(task.ActivityDate);
  return (
    <li
      className={cn(
        "group flex items-center gap-2 border-b border-border-strong px-3 py-2 last:border-b-0 hover:bg-surface-2",
        urgent && "bg-red-soft/40",
      )}
    >
      <button
        type="button"
        onClick={onToggleUrgent}
        title={urgent ? "Unflag" : "Flag urgent"}
        aria-pressed={urgent}
        className={cn(
          "flex-shrink-0 rounded p-1 text-ink-4 hover:bg-surface-2 hover:text-red",
          urgent && "text-red",
        )}
      >
        <Flag size={14} fill={urgent ? "currentColor" : "none"} />
      </button>

      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left focus:outline-none"
      >
        <div className="flex w-full items-center gap-2">
          <span className="truncate text-[13px] font-medium text-ink">
            {task.Subject ?? "(no subject)"}
          </span>
          {task.Priority && task.Priority !== "Normal" ? (
            <Tag variant={task.Priority === "High" ? "red" : "default"}>
              {task.Priority}
            </Tag>
          ) : null}
          {badge ? <Tag variant={badge.variant}>{badge.label}</Tag> : null}
        </div>
        {task.WhatName ? (
          <span className="truncate text-[11.5px] text-ink-3">
            {task.WhatName}
          </span>
        ) : null}
      </button>

      <span className="mono w-20 flex-shrink-0 text-right text-[11px] tabular-nums text-ink-3">
        {fmtDate(task.ActivityDate ?? null)}
      </span>
    </li>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
}) {
  return (
    <label className="relative flex h-7 items-center">
      <span className="sr-only">{ariaLabel}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 cursor-pointer appearance-none rounded border border-border-strong bg-surface px-2 pr-6 text-[11.5px] font-medium text-ink hover:bg-surface-2 focus:outline-none focus:ring-1 focus:ring-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={11}
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-3"
      />
    </label>
  );
}

function SkeletonRows() {
  return (
    <ul className="flex flex-col" aria-busy>
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-3 py-2">
          <div className="h-4 w-4 animate-pulse rounded bg-surface-2" />
          <div className="h-4 flex-1 animate-pulse rounded bg-surface-2" />
          <div className="h-4 w-16 animate-pulse rounded bg-surface-2" />
        </li>
      ))}
    </ul>
  );
}

function Empty({
  mineFiltered,
  onAll,
}: {
  mineFiltered: boolean;
  onAll: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="text-[13px] font-medium text-ink">Inbox zero.</div>
      <div className="text-[11.5px] text-ink-3">
        {mineFiltered
          ? "No open tasks owned by you."
          : "No open tasks in this view."}
      </div>
      {mineFiltered ? (
        <button
          type="button"
          onClick={onAll}
          className="mt-1 rounded border border-border-strong px-2 py-1 text-[11px] font-medium text-ink-2 hover:bg-surface-2"
        >
          Show all
        </button>
      ) : null}
    </div>
  );
}

function readUrgent(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(URGENT_OVERRIDE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function priorityRank(p: string | null | undefined): number {
  switch (p) {
    case "High":
      return 0;
    case "Normal":
      return 1;
    case "Low":
      return 2;
    default:
      return 3;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function dueBadge(
  iso: string | null | undefined,
): { label: string; variant: "red" | "amber" | "default" } | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso);
  due.setHours(0, 0, 0, 0);
  const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return { label: `${Math.abs(diff)}d overdue`, variant: "red" };
  if (diff === 0) return { label: "Due today", variant: "amber" };
  if (diff === 1) return { label: "Tomorrow", variant: "amber" };
  return null;
}

function toFlatTask(t: SfMyTask): FlatTask {
  return {
    source: "crm",
    id: t.Id,
    title: t.Subject ?? "(no subject)",
    status: t.Status ?? "Not Started",
    priority: t.Priority ?? null,
    owner: t.OwnerName ?? null,
    ownerId: t.OwnerId ?? null,
    deadline: t.ActivityDate ?? null,
    description: t.Description ?? null,
    parentLabel: t.WhatName ?? null,
    parentLink: t.WhatId ? `/opportunities/${t.WhatId}` : null,
    type: t.Type ?? null,
  };
}
