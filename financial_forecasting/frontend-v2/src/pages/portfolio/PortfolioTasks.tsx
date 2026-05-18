/**
 * Portfolio · Tasks — homebase task list.
 *
 * Aggregates two task sources for the user:
 *   1. Salesforce tasks where Task.OwnerId = sfUserId
 *      (/api/salesforce/users/:id/tasks). Parent is the SF What — opp,
 *      account, contact, or "Other".
 *   2. Bedrock project tasks inside any project owned by this user.
 *      Pulled by fetching each project's full detail and flattening
 *      workstream → milestone → tasks.
 *
 * Both sources are normalized into `UnifiedTask` so the rendering and
 * sorting are uniform. Grouping is by parent (opportunity / account /
 * project); within each group rows sort by risk (overdue → due-soon →
 * on-track → no-date → done) then by date.
 *
 * Inline edits go through the underlying service:
 *   - SF tasks  → PUT /api/salesforce/tasks/{id}   (useUpdateTask · SF)
 *   - Project tasks → PUT /api/project-tasks/{id}  (useUpdateTask · proj)
 *
 * Done tasks aren't shown by default to keep the homebase actionable —
 * a "show done" toggle reveals them.
 */
import { useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, FolderOpen, GitBranch, Building2, ClipboardList } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { riskForTask, riskTextClass, type RiskLevel } from "@/lib/risk";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { SectionCard, withReferrer } from "@/components/detail";
import { useUpdateTask as useUpdateSfTask, useUserTasks as useSfUserTasks } from "@/services/opportunities";
import { useUpdateTask as useUpdateProjectTask, type BedrockProject } from "@/services/projects";
import type { SfTask } from "@/types/salesforce";

const SF_STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Waiting on someone else", label: "Waiting" },
  { value: "Deferred", label: "Deferred" },
  { value: "Completed", label: "Completed" },
];

// Project tasks have their own status enum (see ProjectTaskCreate in
// routes/projects.py). The labels mirror what ProjectDetail renders.
const PROJECT_STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Blocked", label: "Blocked" },
  { value: "Done", label: "Done" },
];

type TaskSource = "sf" | "project";

type ParentKind = "opportunity" | "account" | "contact" | "project" | "other";

interface UnifiedTask {
  source: TaskSource;
  id: string;
  title: string;
  status: string | null;
  deadline: string | null;
  done: boolean;
  parent: {
    kind: ParentKind;
    id: string;
    /** Display label for the parent record. May be the SF What.Name,
     *  the project name, or just the parent id when nothing else is
     *  resolvable. */
    label: string;
  };
  /** Carrier-specific tail used by the inline editor — kept here so the
   *  mutation hook can hand the right argument shape back. */
  meta: { projectId?: string };
}

interface PortfolioTasksProps {
  sfUserId: string | null;
  projects: BedrockProject[];
  projectsLoading: boolean;
}

/** Two-mode filter:
 *   - "focus": overdue + tasks due within the next 7 days (the homebase default)
 *   - "all":   everything open (and done if the show-done box is on)
 *
 * "This week" deliberately *includes* overdue rather than splitting them
 * into a separate bucket — an overdue task is, by definition, on this
 * week's plate whether or not its deadline lands inside it.
 */
type Scope = "focus" | "all";

const SCOPE_STORAGE_KEY = "bedrock-v2:portfolio:tasks:scope";

function readStoredScope(): Scope {
  try {
    const v = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (v === "all" || v === "focus") return v;
  } catch {}
  return "focus";
}

function isInFocusWindow(deadline: string | null, done: boolean): boolean {
  // Overdue and due-soon both belong in the focus view. A task with no
  // deadline only makes the cut once the user expands to "All".
  if (done) return false;
  const risk = riskForTask(deadline, done);
  return risk === "overdue" || risk === "due-soon";
}

export function PortfolioTasks({ sfUserId, projects, projectsLoading }: PortfolioTasksProps) {
  const sfTasksQ = useSfUserTasks(sfUserId ?? undefined);
  const projectTasksQs = useUserProjectTaskQueries(projects);

  const [showDone, setShowDone] = useState(false);
  const [scope, setScope] = useState<Scope>(readStoredScope);

  // Persist scope so the user's preference rides through refreshes —
  // mirrors how SectionCard's collapsed state survives. Wrapped in
  // try/catch in case storage is unavailable (Safari private, etc).
  function changeScope(next: Scope) {
    setScope(next);
    try {
      localStorage.setItem(SCOPE_STORAGE_KEY, next);
    } catch {}
  }

  const unifiedTasks = useMemo<UnifiedTask[]>(() => {
    const projById = new Map(projects.map((p) => [p.id, p]));
    const out: UnifiedTask[] = [];

    for (const t of sfTasksQ.data ?? []) {
      out.push(normalizeSfTask(t));
    }
    for (const { projectId, tasks } of projectTasksQs) {
      const p = projById.get(projectId);
      for (const t of tasks) {
        out.push(normalizeProjectTask(t, projectId, p?.name ?? projectId));
      }
    }

    return out;
  }, [sfTasksQ.data, projectTasksQs, projects]);

  // Done filter applies first, then scope. "Show done" only makes sense
  // in the "All" view (no point in seeing a completed task during focus).
  const openTasks = showDone ? unifiedTasks : unifiedTasks.filter((t) => !t.done);
  const filtered = scope === "focus"
    ? openTasks.filter((t) => isInFocusWindow(t.deadline, t.done))
    : openTasks;

  const groups = useMemo(() => groupByParent(filtered), [filtered]);

  const overdueCount = openTasks.filter((t) => riskForTask(t.deadline, t.done) === "overdue").length;
  const dueSoonCount = openTasks.filter((t) => riskForTask(t.deadline, t.done) === "due-soon").length;
  // For the "All" toggle we surface the total it'd expand to, so the
  // user can see the cost before clicking.
  const allCount = openTasks.length;
  const focusCount = openTasks.filter((t) => isInFocusWindow(t.deadline, t.done)).length;

  const isLoading = sfTasksQ.isLoading || projectsLoading;

  return (
    <SectionCard
      title={`My tasks (${filtered.length})`}
      storageScope="portfolio"
      defaultOpen
      action={
        <div className="flex items-center gap-3 text-[11.5px]">
          {overdueCount > 0 ? (
            <span className="font-semibold text-red">{overdueCount} overdue</span>
          ) : null}
          {dueSoonCount > 0 && scope === "all" ? (
            <span className="font-semibold text-amber-700">{dueSoonCount} due soon</span>
          ) : null}
          <ScopeToggle
            value={scope}
            onChange={changeScope}
            focusCount={focusCount}
            allCount={allCount}
          />
          {scope === "all" ? (
            <label className="flex items-center gap-1.5 text-ink-3">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
                className="h-3 w-3 cursor-pointer"
              />
              Show done
            </label>
          ) : null}
        </div>
      }
    >
      {!sfUserId && projects.length === 0 ? (
        <EmptyState>Connect Salesforce and own at least one project to see tasks here.</EmptyState>
      ) : isLoading ? (
        <EmptyState>Loading tasks…</EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState>
          {scope === "focus"
            ? "Nothing overdue or due this week. Switch to All to see what's further out."
            : "No open tasks. Nice — go enjoy yourself."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col">
          {groups.map((g) => (
            <ParentGroup key={`${g.kind}:${g.id}`} group={g} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

// ── Project-tasks loader ─────────────────────────────────────────────────

/**
 * One useQuery per project, parallelized via useQueries. We rely on the
 * existing project-detail endpoint (it already includes workstreams →
 * milestones → tasks) rather than adding a new "all tasks for user"
 * endpoint, because project ownership is local to bedrock and the
 * project list is small (<50 per RM in practice).
 */
function useUserProjectTaskQueries(projects: BedrockProject[]) {
  const queries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["portfolio-project-tasks", p.id],
      enabled: Boolean(p.id),
      staleTime: 60_000,
      queryFn: async () => {
        const { data } = await api.get<{ data: any }>(`/api/projects/${p.id}`);
        const detail = data?.data;
        const out: ProjectTaskRaw[] = [];
        for (const ws of detail?.workstreams ?? []) {
          for (const ms of ws.milestones ?? []) {
            for (const t of ms.tasks ?? []) {
              out.push(t);
            }
          }
        }
        return out;
      },
    })),
  });

  return projects.map((p, i) => ({
    projectId: p.id,
    tasks: (queries[i]?.data ?? []) as ProjectTaskRaw[],
  }));
}

interface ProjectTaskRaw {
  id: string;
  title: string;
  status: string;
  deadline: string | null;
  owner: string | null;
  owner_ids: string[];
}

// ── Normalizers ──────────────────────────────────────────────────────────

function normalizeSfTask(t: SfTask): UnifiedTask {
  return {
    source: "sf",
    id: t.Id,
    title: t.Subject ?? "(no subject)",
    status: t.Status ?? null,
    deadline: t.ActivityDate ?? null,
    done: isSfDone(t),
    parent: resolveSfParent(t),
    meta: {},
  };
}

function normalizeProjectTask(t: ProjectTaskRaw, projectId: string, projectName: string): UnifiedTask {
  return {
    source: "project",
    id: t.id,
    title: t.title,
    status: t.status,
    deadline: t.deadline,
    done: t.status === "Done",
    parent: { kind: "project", id: projectId, label: projectName },
    meta: { projectId },
  };
}

function isSfDone(t: SfTask): boolean {
  if (t.IsClosed != null) return Boolean(t.IsClosed);
  return t.Status === "Completed";
}

/** Map a Salesforce WhatId/WhoId prefix to a known entity kind so we
 *  can route the row to the right detail page. Falls back to "other". */
function resolveSfParent(t: SfTask): UnifiedTask["parent"] {
  const id = t.WhatId ?? t.WhoId;
  const name = t.WhatName ?? t.WhoName ?? "—";
  if (!id) return { kind: "other", id: "__none__", label: "Other tasks" };
  const prefix = id.slice(0, 3);
  if (prefix === "006") return { kind: "opportunity", id, label: name };
  if (prefix === "001") return { kind: "account", id, label: name };
  if (prefix === "003") return { kind: "contact", id, label: name };
  return { kind: "other", id, label: name };
}

// ── Grouping & sorting ───────────────────────────────────────────────────

interface ParentGroupData {
  kind: ParentKind;
  id: string;
  label: string;
  tasks: UnifiedTask[];
  overdueCount: number;
}

function groupByParent(tasks: UnifiedTask[]): ParentGroupData[] {
  const map = new Map<string, ParentGroupData>();
  for (const t of tasks) {
    const key = `${t.parent.kind}:${t.parent.id}`;
    const existing = map.get(key);
    if (existing) {
      existing.tasks.push(t);
    } else {
      map.set(key, {
        kind: t.parent.kind,
        id: t.parent.id,
        label: t.parent.label,
        tasks: [t],
        overdueCount: 0,
      });
    }
  }

  // Sort tasks within each group by risk, then by date.
  for (const g of map.values()) {
    g.tasks.sort(taskSorter);
    g.overdueCount = g.tasks.filter((t) => riskForTask(t.deadline, t.done) === "overdue").length;
  }

  // Groups sorted by overdue count desc → group risk-weighted total desc
  // → label asc.
  return [...map.values()].sort((a, b) => {
    if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
    if (a.tasks.length !== b.tasks.length) return b.tasks.length - a.tasks.length;
    return a.label.localeCompare(b.label);
  });
}

const RISK_RANK: Record<RiskLevel, number> = {
  overdue: 0,
  "due-soon": 1,
  "on-track": 2,
  none: 3,
  done: 4,
};

function taskSorter(a: UnifiedTask, b: UnifiedTask): number {
  const ra = riskForTask(a.deadline, a.done);
  const rb = riskForTask(b.deadline, b.done);
  if (RISK_RANK[ra] !== RISK_RANK[rb]) return RISK_RANK[ra] - RISK_RANK[rb];
  if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
  if (a.deadline) return -1;
  if (b.deadline) return 1;
  return a.title.localeCompare(b.title);
}

// ── Render: per-parent group ─────────────────────────────────────────────

function ParentGroup({ group }: { group: ParentGroupData }) {
  const [open, setOpen] = useState(true);

  return (
    <li className="border-b border-border-strong last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 bg-surface-2/50 px-5 py-1.5 hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0 text-ink-3" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-ink-3" />
        )}
        <ParentIcon kind={group.kind} />
        <ParentLabel kind={group.kind} id={group.id} label={group.label} />
        <span className="ml-auto flex items-center gap-2 text-[11px] text-ink-3">
          {group.overdueCount > 0 ? (
            <span className="font-semibold text-red">{group.overdueCount} overdue</span>
          ) : null}
          <span>
            {group.tasks.length} task{group.tasks.length === 1 ? "" : "s"}
          </span>
        </span>
      </button>

      {open ? (
        <table className="w-full">
          <colgroup>
            <col style={{ width: 28 }} />
            <col />
            <col style={{ width: 140 }} />
            <col style={{ width: 130 }} />
            <col style={{ width: 30 }} />
          </colgroup>
          <tbody>
            {group.tasks.map((t) => (
              <TaskRow key={`${t.source}:${t.id}`} task={t} />
            ))}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

function ParentIcon({ kind }: { kind: ParentKind }) {
  const Icon = kind === "opportunity"
    ? GitBranch
    : kind === "account"
      ? Building2
      : kind === "project"
        ? FolderOpen
        : ClipboardList;
  return <Icon size={13} className="flex-shrink-0 text-ink-3" />;
}

function ParentLabel({ kind, id, label }: { kind: ParentKind; id: string; label: string }) {
  if (kind === "opportunity") {
    return (
      <Link
        to={`/opportunities/${id}`}
        state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
        className="truncate text-[12.5px] font-semibold text-ink hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Link>
    );
  }
  if (kind === "account") {
    return (
      <Link
        to={`/accounts/${id}`}
        state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
        className="truncate text-[12.5px] font-semibold text-ink hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Link>
    );
  }
  if (kind === "contact") {
    return (
      <Link
        to={`/contacts/${id}`}
        state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
        className="truncate text-[12.5px] font-semibold text-ink hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Link>
    );
  }
  if (kind === "project") {
    return (
      <Link
        to={`/projects/${id}`}
        state={withReferrer({ pathname: "/portfolio", label: "Portfolio" })}
        className="truncate text-[12.5px] font-semibold text-ink hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {label}
      </Link>
    );
  }
  return <span className="truncate text-[12.5px] font-semibold text-ink-3">{label}</span>;
}

// ── Render: per-task row with inline edit ────────────────────────────────

function TaskRow({ task }: { task: UnifiedTask }) {
  const qc = useQueryClient();
  const updateSf = useUpdateSfTask();
  const updateProj = useUpdateProjectTask(task.meta.projectId ?? "");
  const risk = riskForTask(task.deadline, task.done);

  // Status options + done predicate differ by source.
  const statusOptions = task.source === "sf" ? SF_STATUS_OPTIONS : PROJECT_STATUS_OPTIONS;
  const doneValue = task.source === "sf" ? "Completed" : "Done";

  // After any mutation we invalidate the *Portfolio* slices specifically
  // — relying solely on the service hooks' invalidation would miss the
  // per-project list cached under "portfolio-project-tasks".
  function invalidatePortfolio() {
    qc.invalidateQueries({ queryKey: ["portfolio-project-tasks"] });
    qc.invalidateQueries({ queryKey: ["user-tasks"] });
  }

  async function saveStatus(next: string) {
    if (task.source === "sf") {
      await updateSf.mutateAsync({ id: task.id, patch: { Status: next } });
    } else {
      await updateProj.mutateAsync({ taskId: task.id, patch: { status: next } });
    }
    invalidatePortfolio();
  }

  async function saveDeadline(next: string | null) {
    if (task.source === "sf") {
      await updateSf.mutateAsync({ id: task.id, patch: { ActivityDate: next } });
    } else {
      await updateProj.mutateAsync({ taskId: task.id, patch: { deadline: next } });
    }
    invalidatePortfolio();
  }

  async function saveTitle(next: string) {
    const trimmed = next.trim();
    if (!trimmed) return;
    if (task.source === "sf") {
      await updateSf.mutateAsync({ id: task.id, patch: { Subject: trimmed } });
    } else {
      await updateProj.mutateAsync({ taskId: task.id, patch: { title: trimmed } });
    }
    invalidatePortfolio();
  }

  async function toggleDone() {
    const next = task.done
      ? task.source === "sf" ? "Not Started" : "Not Started"
      : doneValue;
    await saveStatus(next);
  }

  return (
    <tr className={cn("border-t border-border-strong", task.done && "text-ink-3")}>
      <td className="px-3 py-1.5 align-middle">
        <input
          type="checkbox"
          checked={task.done}
          onChange={toggleDone}
          className="h-3.5 w-3.5 cursor-pointer"
          aria-label={task.done ? "Reopen task" : "Mark complete"}
        />
      </td>
      <td className="px-3 py-1.5 align-middle">
        <div className={cn("flex flex-col leading-tight", task.done && "line-through")}>
          <InlineText
            value={task.title}
            onSave={saveTitle}
            className="text-[12.5px]"
          />
        </div>
      </td>
      <td className="px-3 py-1.5 align-middle">
        <InlineSelect
          value={task.status}
          options={statusOptions}
          onSave={saveStatus}
        />
      </td>
      <td className={cn("px-3 py-1.5 align-middle text-right", riskTextClass(risk))}>
        <InlineDate
          value={task.deadline}
          onSave={saveDeadline}
          align="right"
          placeholder="—"
        />
        {risk === "overdue" && task.deadline ? (
          <div className="text-[10px] uppercase tracking-wide text-red">
            {Math.round((Date.now() - new Date(task.deadline).getTime()) / 86_400_000)}d late
          </div>
        ) : null}
      </td>
      <td className="px-2 py-1.5 align-middle">
        <span
          aria-hidden
          className={cn(
            "block h-2 w-2 rounded-full",
            risk === "overdue"
              ? "bg-red"
              : risk === "due-soon"
                ? "bg-amber"
                : risk === "done"
                  ? "bg-green/60"
                  : "bg-ink-4/40",
          )}
          title={
            risk === "overdue"
              ? "Overdue"
              : risk === "due-soon"
                ? "Due soon"
                : risk === "done"
                  ? "Done"
                  : "On track"
          }
        />
      </td>
    </tr>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}

/** Segmented control for the tasks scope. Two pills, persistent state
 *  lifted to the parent so we can re-derive counts off the same array.
 *  Pinned counts on each pill let the user know what's behind the click
 *  without having to switch and switch back. */
function ScopeToggle({
  value,
  onChange,
  focusCount,
  allCount,
}: {
  value: Scope;
  onChange: (next: Scope) => void;
  focusCount: number;
  allCount: number;
}) {
  return (
    <div
      role="tablist"
      aria-label="Task scope"
      className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface"
    >
      <ScopeButton
        active={value === "focus"}
        onClick={() => onChange("focus")}
        label="This week"
        count={focusCount}
      />
      <ScopeButton
        active={value === "all"}
        onClick={() => onChange("all")}
        label="All"
        count={allCount}
      />
    </div>
  );
}

function ScopeButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 border-l border-border-strong px-2.5 py-1 text-[11.5px] font-medium first:border-l-0",
        active
          ? "bg-ink text-surface"
          : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "rounded px-1 text-[10.5px] tabular-nums",
          active ? "bg-surface/20" : "bg-surface-2 text-ink-3",
        )}
      >
        {count}
      </span>
    </button>
  );
}
