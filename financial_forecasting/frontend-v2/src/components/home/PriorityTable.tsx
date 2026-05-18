import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  Flame,
  Inbox,
  Plus,
  Repeat,
} from "lucide-react";
import { toast } from "sonner";

import { AccountAvatar } from "@/components/AccountAvatar";
import {
  InlineDate,
  InlineSelect,
  InlineText,
} from "@/components/ui/InlineEdit";
import { SavedViewsPicker } from "@/components/ui/SavedViewsPicker";
import { StageChip } from "@/components/ui/StageChip";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtDate, fmtMoneyFull } from "@/lib/format";
import {
  computeUrgency,
  computeWeightedPriority,
  countOverdueTasks,
} from "@/lib/priorityScoring";
import { useSort } from "@/lib/sort";
import { useLayoutPrefs } from "@/lib/useLayoutPrefs";
import { SF_STAGE_OPTIONS, stageStatus } from "@/lib/stages";
import { cn } from "@/lib/utils";
import {
  useCreateTask,
  useOpportunities,
  useUpdateOpportunity,
  useUpdateOpportunityStage,
} from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useMyTasks } from "@/services/tasks";
import { useActiveUsers } from "@/services/users";
import type { SfOpportunity, SfTask } from "@/types/salesforce";

const STORAGE_KEY_COLS = "bedrock:home:jp:priorities:cols";
const STORAGE_KEY_PREFS = "bedrock:home:jp:priorities:prefs";
const TOP_N_DEFAULT = 20;
const TOP_N_MIN = 1;
const TOP_N_MAX = 50;

type ColKey =
  | "alerts"
  | "name"
  | "stage"
  | "amount"
  | "probability"
  | "close"
  | "tasks"
  | "lastActivity";

const COLUMN_ORDER: ColKey[] = [
  "alerts",
  "name",
  "stage",
  "amount",
  "probability",
  "close",
  "tasks",
  "lastActivity",
];

const COL_LABELS: Record<ColKey, string> = {
  alerts: "",
  name: "Opportunity",
  stage: "Stage",
  amount: "Amount",
  probability: "Prob.",
  close: "Close",
  tasks: "Tasks",
  lastActivity: "Last activity",
};

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  alerts: 90,
  name: 280,
  stage: 160,
  amount: 130,
  probability: 80,
  close: 110,
  tasks: 70,
  lastActivity: 110,
};

type OwnerFilter = "me" | "all" | string;

interface PriorityFilters {
  ownerFilter: OwnerFilter;
  topN: number;
  sortKey: ColKey | null;
  sortDir: "asc" | "desc";
}

export interface PriorityTableProps {
  currentUserId?: string | null;
  /** Click an opportunity name → caller opens OpportunityDrawer. */
  onOpportunityClick?: (opp: SfOpportunity) => void;
  className?: string;
}

/**
 * Top-N weighted-priority opportunities for the home page.
 *
 * Always sorted by `computeWeightedPriority` descending (the user can
 * override with column-click sort). Inline edits flow through the same
 * mutations the OpportunityDrawer uses, so the table and the drawer
 * stay consistent without bespoke wiring. Stage transitions go through
 * `useUpdateOpportunityStage` so the server's award auto-create runs.
 *
 * Behavior parity with `frontend/src/components/PriorityTable.tsx`,
 * trimmed to the columns most useful on the home surface.
 */
export function PriorityTable({
  currentUserId,
  onOpportunityClick,
  className,
}: PriorityTableProps) {
  const oppsQ = useOpportunities();
  const tasksQ = useMyTasks();
  const usersQ = useActiveUsers();

  const updateOpp = useUpdateOpportunity();
  const updateStage = useUpdateOpportunityStage();
  const canEditOwn = usePerm("edit_own_opportunities");
  const canEditAll = usePerm("edit_all_opportunities");
  const canEdit = canEditOwn || canEditAll;

  // ── controls ───────────────────────────────────────────────────────────
  const { prefs: tablePrefs, setPrefs: setTablePrefs } = useLayoutPrefs<{
    ownerFilter: OwnerFilter;
    topN: number;
  }>(STORAGE_KEY_PREFS, {
    ownerFilter: currentUserId ? "me" : "all",
    topN: TOP_N_DEFAULT,
  });
  const ownerFilter = tablePrefs.ownerFilter;
  const topN = tablePrefs.topN;
  const setOwnerFilter = (v: OwnerFilter) => setTablePrefs({ ownerFilter: v });
  const setTopN = (n: number) =>
    setTablePrefs({ topN: Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, n)) });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { widths, startResize } = useColumnWidths<ColKey>(
    STORAGE_KEY_COLS,
    DEFAULT_WIDTHS,
  );

  const { sort, toggle, setSort } = useSort<ColKey>({
    key: null,
    direction: "asc",
  });
  // The base ordering is always weighted-priority descending. If the user
  // clicks any column header, that sort overlays on top via `sort.key`.
  // Cleared sort (third click) returns to weighted-priority order.
  const userSorting = sort.key != null;

  // ── data join ──────────────────────────────────────────────────────────
  const tasksByOpp = useMemo(() => {
    const m = new Map<string, SfTask[]>();
    for (const t of tasksQ.data ?? []) {
      const w = t.WhatId;
      if (!w) continue;
      const list = m.get(w) ?? [];
      list.push(asFullTask(t));
      m.set(w, list);
    }
    return m;
  }, [tasksQ.data]);

  const visible = useMemo(() => {
    const all = oppsQ.data ?? [];
    const openOnly = all.filter((o) => !o.IsClosed);
    const byOwner = openOnly.filter((o) => {
      if (ownerFilter === "all") return true;
      if (ownerFilter === "me") return o.OwnerId === currentUserId;
      return o.OwnerId === ownerFilter;
    });
    const enriched = byOwner.map((o) => {
      const tasks = tasksByOpp.get(o.Id) ?? [];
      const weight = computeWeightedPriority(o);
      const urgency = computeUrgency(o, tasks);
      return { opp: o, tasks, weight, urgency };
    });
    enriched.sort((a, b) => b.weight - a.weight);
    const topNClamped = Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, topN));
    const top = enriched.slice(0, topNClamped);
    if (userSorting && sort.key != null) {
      const sortKey = sort.key;
      top.sort((a, b) => {
        const dir = sort.direction === "desc" ? -1 : 1;
        const av = pickSortVal(a.opp, sortKey);
        const bv = pickSortVal(b.opp, sortKey);
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });
    }
    return top;
  }, [oppsQ.data, ownerFilter, currentUserId, tasksByOpp, topN, sort, userSorting]);

  // ── inline-edit savers ─────────────────────────────────────────────────
  // Each saver re-throws on failure so the in-cell red-icon affordance
  // from InlineEdit still fires. The toast adds a hard-to-miss top-level
  // notification in case the user has moved focus away from the cell.
  const withToast = useCallback(
    async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Save failed";
        toast.error(`${label}: ${msg}`);
        throw e;
      }
    },
    [],
  );

  const saveStage = useCallback(
    (id: string, stage: string) =>
      withToast("Stage save failed", () =>
        updateStage.mutateAsync({ id, newStage: stage }),
      ),
    [updateStage, withToast],
  );

  const saveAmount = useCallback(
    (id: string, raw: string) =>
      withToast("Amount save failed", async () => {
        const cleaned = raw.replace(/[$,\s]/g, "");
        const parsed = cleaned === "" ? null : Number(cleaned);
        if (parsed != null && !Number.isFinite(parsed)) {
          throw new Error("Not a number");
        }
        await updateOpp.mutateAsync({ id, patch: { Amount: parsed } });
      }),
    [updateOpp, withToast],
  );

  const saveProbability = useCallback(
    (id: string, raw: string) =>
      withToast("Probability save failed", async () => {
        const cleaned = raw.replace(/[%\s]/g, "");
        const parsed = cleaned === "" ? null : Number.parseInt(cleaned, 10);
        if (parsed != null && (!Number.isFinite(parsed) || parsed < 0 || parsed > 100)) {
          throw new Error("0–100");
        }
        await updateOpp.mutateAsync({
          id,
          patch: { Manager_Probability_Override__c: parsed },
        });
      }),
    [updateOpp, withToast],
  );

  const saveCloseDate = useCallback(
    (id: string, next: string | null) =>
      withToast("Close date save failed", () =>
        updateOpp.mutateAsync({ id, patch: { CloseDate: next } }),
      ),
    [updateOpp, withToast],
  );

  // ── render ─────────────────────────────────────────────────────────────
  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const tableMinWidth = totalWidth(widths);
  const loading = oppsQ.isLoading;

  return (
    <section
      className={cn(
        "flex flex-col rounded-lg border border-border-strong bg-surface",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Flame size={15} className="text-red" /> Priorities
        </div>
        <Tag>{visible.length}</Tag>
        <div className="flex-1" />
        <OwnerFilterControl
          value={ownerFilter}
          onChange={setOwnerFilter}
          users={ownerOptions}
        />
        <TopNStepper value={topN} onChange={setTopN} />
        {userSorting ? (
          <button
            type="button"
            onClick={() => setSort({ key: null, direction: "asc" })}
            className="h-7 rounded border border-border-strong bg-surface px-2 text-[11.5px] font-medium text-ink-2 hover:bg-surface-2"
            title="Restore weighted-priority order"
          >
            Reset sort
          </button>
        ) : null}
        <SavedViewsPicker<PriorityFilters>
          scopeKey="home-priorities"
          currentFilters={{
            ownerFilter,
            topN,
            sortKey: sort.key,
            sortDir: sort.direction,
          }}
          onLoad={(f) => {
            setOwnerFilter(f.ownerFilter);
            setTopN(Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, f.topN)));
            setSort({ key: f.sortKey, direction: f.sortDir });
          }}
        />
      </header>

      <div className="flex-1 overflow-x-auto">
        <table
          className="w-full border-separate border-spacing-0 text-[12.5px]"
          style={{ minWidth: tableMinWidth, tableLayout: "fixed" }}
        >
          <ColGroup widths={widths} order={COLUMN_ORDER} />
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {COLUMN_ORDER.map((key) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  className={cn(
                    "border-b border-border-strong px-2 py-1 text-left",
                    key === "amount" || key === "probability"
                      ? "text-right"
                      : "",
                  )}
                >
                  {key === "alerts" ? (
                    <span className="sr-only">Alerts</span>
                  ) : (
                    <SortableHeader<ColKey>
                      label={COL_LABELS[key]}
                      sortKey={key}
                      sort={sort}
                      onToggle={toggle}
                      align={
                        key === "amount" || key === "probability"
                          ? "right"
                          : "left"
                      }
                    />
                  )}
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <SkeletonRow key={i} />
                ))
              : visible.map(({ opp, tasks, urgency }) => (
                  <PriorityRow
                    key={opp.Id}
                    opp={opp}
                    tasks={tasks}
                    urgency={urgency}
                    canEdit={canEdit}
                    isExpanded={expandedId === opp.Id}
                    onToggleExpand={() =>
                      setExpandedId(expandedId === opp.Id ? null : opp.Id)
                    }
                    onClick={() => onOpportunityClick?.(opp)}
                    onSaveStage={(s) => saveStage(opp.Id, s)}
                    onSaveAmount={(s) => saveAmount(opp.Id, s)}
                    onSaveProbability={(s) => saveProbability(opp.Id, s)}
                    onSaveCloseDate={(s) => saveCloseDate(opp.Id, s)}
                  />
                ))}
            {!loading && visible.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMN_ORDER.length}
                  className="px-6 py-12 text-center text-[12.5px] text-ink-3"
                >
                  No open opportunities match the current filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface PriorityRowProps {
  opp: SfOpportunity;
  tasks: SfTask[];
  urgency: { score: number; reasons: string[] };
  canEdit: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onClick: () => void;
  onSaveStage: (next: string) => Promise<void>;
  onSaveAmount: (raw: string) => Promise<void>;
  onSaveProbability: (raw: string) => Promise<void>;
  onSaveCloseDate: (next: string | null) => Promise<void>;
}

function PriorityRow({
  opp,
  tasks,
  urgency,
  canEdit,
  isExpanded,
  onToggleExpand,
  onClick,
  onSaveStage,
  onSaveAmount,
  onSaveProbability,
  onSaveCloseDate,
}: PriorityRowProps) {
  const openTaskCount = tasks.filter(
    (t) => t.Status !== "Completed" && !t.IsClosed,
  ).length;
  const overdueCount = countOverdueTasks(tasks);

  return (
    <>
      <tr className="group hover:bg-surface-2">
        <td className="border-b border-border-strong px-2 py-1.5">
          <AlertChips urgency={urgency} overdueCount={overdueCount} />
        </td>
        <td className="border-b border-border-strong px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? "Collapse tasks" : "Expand tasks"}
              className="flex-shrink-0 text-ink-4 hover:text-ink-2"
            >
              {isExpanded ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </button>
            <AccountAvatar name={opp.Account?.Name ?? "—"} logoUrl={null} size={18} />
            <button
              type="button"
              onClick={onClick}
              className="flex min-w-0 flex-1 flex-col items-start text-left leading-tight"
            >
              <span
                className="truncate font-medium text-ink hover:underline"
                title={opp.Name}
              >
                {opp.Name}
              </span>
              <span
                className="truncate text-[11px] text-ink-3"
                title={opp.Account?.Name ?? undefined}
              >
                {opp.Account?.Name ?? "—"}
              </span>
            </button>
          </div>
        </td>
        <td className="border-b border-border-strong px-2 py-1.5">
          {canEdit ? (
            <InlineSelect
              value={opp.StageName}
              options={SF_STAGE_OPTIONS}
              onSave={onSaveStage}
              renderValue={(v) =>
                v ? (
                  <StageChip stage={v} status={stageStatus(opp)} />
                ) : (
                  <span className="text-ink-4">—</span>
                )
              }
              emptyLabel="—"
            />
          ) : opp.StageName ? (
            <StageChip stage={opp.StageName} status={stageStatus(opp)} />
          ) : (
            <span className="text-ink-4">—</span>
          )}
        </td>
        <td className="border-b border-border-strong px-2 py-1.5 text-right tabular-nums">
          {canEdit ? (
            <InlineText
              value={opp.Amount != null ? String(opp.Amount) : ""}
              onSave={onSaveAmount}
              formatDisplay={(raw) => {
                const n = Number(raw);
                return Number.isFinite(n) && n > 0 ? fmtMoneyFull(n) : "—";
              }}
              placeholder="0"
              emptyLabel="—"
              className="justify-end text-right"
            />
          ) : (
            <span className={cn(opp.Amount && opp.Amount > 0 && "font-semibold")}>
              {opp.Amount != null ? fmtMoneyFull(opp.Amount) : "—"}
            </span>
          )}
        </td>
        <td className="border-b border-border-strong px-2 py-1.5 text-right tabular-nums">
          {canEdit ? (
            <InlineText
              value={
                opp.Manager_Probability_Override__c != null
                  ? String(opp.Manager_Probability_Override__c)
                  : opp.Probability != null
                    ? String(opp.Probability)
                    : ""
              }
              onSave={onSaveProbability}
              formatDisplay={(raw) => {
                const n = Number(raw);
                return Number.isFinite(n) ? `${n}%` : "—";
              }}
              placeholder="—"
              className="justify-end text-right"
            />
          ) : (
            <span>
              {opp.Probability != null ? `${opp.Probability}%` : "—"}
            </span>
          )}
        </td>
        <td className="mono border-b border-border-strong px-2 py-1.5 tabular-nums">
          {canEdit ? (
            <InlineDate
              value={opp.CloseDate ?? null}
              onSave={onSaveCloseDate}
              variant="short"
            />
          ) : (
            <span>{fmtDate(opp.CloseDate)}</span>
          )}
        </td>
        <td className="border-b border-border-strong px-2 py-1.5 text-center">
          <span
            className={cn(
              "inline-flex h-5 min-w-[20px] items-center justify-center rounded px-1 text-[11px] font-medium",
              openTaskCount === 0
                ? "bg-surface-2 text-ink-3"
                : overdueCount > 0
                  ? "bg-red-soft text-red"
                  : "bg-accent-soft text-accent-ink",
            )}
          >
            {openTaskCount}
          </span>
        </td>
        <td className="mono border-b border-border-strong px-2 py-1.5 text-[11px] tabular-nums text-ink-3">
          {fmtDate(opp.LastModifiedDate ?? null)}
        </td>
      </tr>
      {isExpanded ? (
        <tr>
          <td
            colSpan={COLUMN_ORDER.length}
            className="border-b border-border-strong bg-surface-2/40 px-3 py-2"
          >
            <ExpandedTasks opportunityId={opp.Id} tasks={tasks} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AlertChips({
  urgency,
  overdueCount,
}: {
  urgency: { score: number; reasons: string[] };
  overdueCount: number;
}) {
  const icons = useMemo(() => {
    const out: { key: string; icon: React.ReactNode; label: string }[] = [];
    const r = urgency.reasons;
    if (r.some((x) => x.startsWith("Overdue"))) {
      out.push({
        key: "overdue",
        icon: <AlertCircle size={13} className="text-red" />,
        label: r.find((x) => x.startsWith("Overdue")) ?? "Overdue",
      });
    } else if (r.some((x) => x.startsWith("Closing in"))) {
      out.push({
        key: "closing",
        icon: <CalendarClock size={13} className="text-amber" />,
        label: r.find((x) => x.startsWith("Closing in")) ?? "Closing soon",
      });
    }
    if (overdueCount > 0) {
      out.push({
        key: "overdue-tasks",
        icon: <Clock size={13} className="text-red" />,
        label: `${overdueCount} overdue task${overdueCount > 1 ? "s" : ""}`,
      });
    }
    if (r.some((x) => x.startsWith("Stale") || x.startsWith("Quiet"))) {
      out.push({
        key: "stale",
        icon: <Repeat size={13} className="text-ink-3" />,
        label: r.find((x) => x.startsWith("Stale") || x.startsWith("Quiet")) ?? "Stale",
      });
    }
    if (r.includes("No tasks assigned")) {
      out.push({
        key: "no-tasks",
        icon: <Inbox size={13} className="text-ink-3" />,
        label: "No tasks assigned",
      });
    }
    return out;
  }, [urgency.reasons, overdueCount]);

  if (icons.length === 0) {
    return <span className="text-[11px] text-ink-4">—</span>;
  }
  return (
    <div className="flex items-center gap-1">
      {icons.map((i) => (
        <Tooltip key={i.key} content={i.label}>
          <span className="grid h-5 w-5 place-items-center rounded">
            {i.icon}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function ExpandedTasks({
  opportunityId,
  tasks,
}: {
  opportunityId: string;
  tasks: SfTask[];
}) {
  const open = tasks.filter((t) => t.Status !== "Completed" && !t.IsClosed);
  const closed = tasks.filter((t) => t.Status === "Completed" || t.IsClosed);
  return (
    <div className="flex flex-col gap-1.5 text-[11.5px]">
      {open.length === 0 && closed.length === 0 ? (
        <div className="py-1 italic text-ink-3">
          No tasks on this opportunity yet.
        </div>
      ) : null}
      {open.length > 0 ? (
        <ul className="flex flex-col">
          {open.map((t) => (
            <SubTaskRow key={t.Id} t={t} />
          ))}
        </ul>
      ) : null}
      <QuickCreateTask opportunityId={opportunityId} />
      {closed.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-ink-3 hover:text-ink">
            {closed.length} closed
          </summary>
          <ul className="mt-1 flex flex-col">
            {closed.slice(0, 10).map((t) => (
              <SubTaskRow key={t.Id} t={t} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function QuickCreateTask({ opportunityId }: { opportunityId: string }) {
  const createTask = useCreateTask();
  const canCreate = usePerm("create_tasks");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!canCreate) return null;

  const submit = async () => {
    const subject = draft.trim();
    if (!subject) return;
    setError(null);
    try {
      await createTask.mutateAsync({
        opportunityId,
        body: { Subject: subject, Status: "Not Started" },
      });
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex items-center gap-2 py-0.5"
    >
      <span
        aria-hidden
        className="grid h-5 w-5 place-items-center text-ink-4"
      >
        <Plus size={12} />
      </span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a task — Enter to save"
        aria-label="New task subject"
        disabled={createTask.isPending}
        className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[12px] text-ink placeholder:text-ink-4 hover:border-border-strong focus:border-accent focus:bg-surface focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
      />
      {error ? (
        <span role="alert" className="text-[10.5px] text-red">
          {error}
        </span>
      ) : null}
    </form>
  );
}

function SubTaskRow({ t }: { t: SfTask }) {
  return (
    <li className="flex items-center gap-2 py-0.5">
      <span
        className={cn(
          "inline-flex w-20 flex-shrink-0 items-center justify-center rounded px-1 py-px text-[10px] font-medium",
          t.IsClosed
            ? "bg-surface-2 text-ink-3"
            : "bg-amber-soft text-amber",
        )}
      >
        {t.Status ?? "Open"}
      </span>
      <span className="min-w-0 flex-1 truncate text-ink">
        {t.Subject ?? "(no subject)"}
      </span>
      <span className="mono w-20 flex-shrink-0 text-right text-[10.5px] tabular-nums text-ink-3">
        {fmtDate(t.ActivityDate)}
      </span>
    </li>
  );
}

function SkeletonRow() {
  return (
    <tr>
      {COLUMN_ORDER.map((k) => (
        <td
          key={k}
          className="border-b border-border-strong px-2 py-1.5"
          aria-busy
        >
          <div className="h-4 animate-pulse rounded bg-surface-2" />
        </td>
      ))}
    </tr>
  );
}

function OwnerFilterControl({
  value,
  onChange,
  users,
}: {
  value: OwnerFilter;
  onChange: (v: OwnerFilter) => void;
  users: { value: string; label: string }[];
}) {
  return (
    <label className="relative flex h-7 items-center">
      <span className="sr-only">Owner filter</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as OwnerFilter)}
        className="h-7 cursor-pointer appearance-none rounded border border-border-strong bg-surface pl-2 pr-6 text-[11.5px] font-medium text-ink hover:bg-surface-2 focus:outline-none focus:ring-1 focus:ring-accent"
      >
        <option value="me">Mine</option>
        <option value="all">All owners</option>
        {users.map((u) => (
          <option key={u.value} value={u.value}>
            {u.label}
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

function TopNStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="inline-flex h-7 items-center overflow-hidden rounded border border-border-strong">
      <button
        type="button"
        onClick={() => onChange(Math.max(TOP_N_MIN, value - 5))}
        className="grid h-7 w-7 place-items-center bg-surface text-ink-2 hover:bg-surface-2"
        aria-label="Show fewer"
      >
        −
      </button>
      <span className="mono w-12 border-x border-border-strong text-center text-[11.5px] tabular-nums">
        Top {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(TOP_N_MAX, value + 5))}
        className="grid h-7 w-7 place-items-center bg-surface text-ink-2 hover:bg-surface-2"
        aria-label="Show more"
      >
        +
      </button>
    </div>
  );
}

function pickSortVal(o: SfOpportunity, key: ColKey): number | string | null {
  switch (key) {
    case "name":
      return o.Name ?? "";
    case "stage":
      return o.StageName ?? "";
    case "amount":
      return o.Amount ?? 0;
    case "probability":
      return o.Manager_Probability_Override__c ?? o.Probability ?? 0;
    case "close":
      return o.CloseDate ?? "9999-12-31";
    case "lastActivity":
      return o.LastModifiedDate ?? "0000-01-01";
    case "tasks":
    case "alerts":
      return null;
  }
}

/**
 * SfMyTask → SfTask widening. The mutation cache in services/opportunities
 * uses the broader SfTask shape; SfMyTask is a subset that's missing some
 * SfTask fields. Filling the missing fields with null keeps types happy
 * without changing runtime behavior (the row only reads what's present).
 */
function asFullTask(t: import("@/services/tasks").SfMyTask): SfTask {
  return {
    Id: t.Id,
    Subject: t.Subject ?? null,
    Status: t.Status ?? null,
    Priority: t.Priority ?? null,
    ActivityDate: t.ActivityDate ?? null,
    Description: t.Description ?? null,
    IsClosed: t.IsClosed ?? null,
    OwnerId: t.OwnerId ?? null,
    OwnerName: t.OwnerName ?? null,
    WhoId: t.WhoId ?? null,
    WhoName: t.WhoName ?? null,
    WhatId: t.WhatId ?? null,
    WhatName: t.WhatName ?? null,
    Type: t.Type ?? null,
    TaskSubtype: null,
    CreatedDate: t.CreatedDate ?? null,
    LastModifiedDate: null,
  };
}

