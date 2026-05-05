import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { api } from "@/lib/api";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useOpportunities } from "@/services/opportunities";
import {
  useProjectDetail,
  type BedrockProject,
  type ProjectTask,
  type ProjectWorkstream,
} from "@/services/projects";
import type { SfOpportunity } from "@/types/salesforce";

interface ProjectOpportunityLink {
  id: string;
  opportunity_id: string;
  role: string | null;
  created_at: string | null;
}

interface ProjectOpportunityResponse {
  success: boolean;
  data: ProjectOpportunityLink[];
}

/**
 * Linked opportunities aren't returned by GET /api/projects/:id.
 * Fetch them via the dedicated endpoint and join client-side against
 * the cached opportunities list for display fields (Name, Account, etc).
 */
function useProjectOpportunities(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project-opportunities", projectId],
    queryFn: async () => {
      const { data } = await api.get<ProjectOpportunityResponse>(
        `/api/projects/${projectId}/opportunities`,
      );
      return data.data ?? [];
    },
    enabled: !!projectId,
    staleTime: 60_000,
  });
}

export function ProjectDrawer({
  project,
  onClose,
}: {
  project: BedrockProject | null;
  onClose: () => void;
}) {
  const open = !!project;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={project?.name ?? "Project"}
      subtitle={
        project
          ? [
              project.owner_email ?? null,
              project.created_at
                ? `Created ${fmtDate(project.created_at)}`
                : null,
              project.updated_at
                ? `Updated ${fmtDate(project.updated_at)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined
          : undefined
      }
      width={680}
    >
      {project ? <ProjectDrawerBody project={project} /> : null}
    </Drawer>
  );
}

function ProjectDrawerBody({ project }: { project: BedrockProject }) {
  const detailQ = useProjectDetail(project.id);
  const linkedQ = useProjectOpportunities(project.id);
  const { data: opps = [] } = useOpportunities();

  const detail = detailQ.data;
  const workstreams: ProjectWorkstream[] = detail?.workstreams ?? [];

  // Flatten open tasks across all workstreams, sorted by deadline.
  // Tasks without a deadline sink to the bottom.
  const openTasks = useMemo(() => {
    const all: { task: ProjectTask; workstream: string }[] = [];
    for (const ws of workstreams) {
      for (const ms of ws.milestones) {
        for (const t of ms.tasks) {
          const status = (t.status ?? "").toLowerCase();
          const isClosed =
            status === "done" ||
            status === "complete" ||
            status === "completed" ||
            status === "cancelled" ||
            status === "canceled";
          if (!isClosed) all.push({ task: t, workstream: ws.name });
        }
      }
    }
    all.sort((a, b) => {
      const ad = a.task.deadline;
      const bd = b.task.deadline;
      if (!ad && !bd) return 0;
      if (!ad) return 1;
      if (!bd) return -1;
      return new Date(ad).getTime() - new Date(bd).getTime();
    });
    return all;
  }, [workstreams]);

  const totalTasks = useMemo(
    () =>
      workstreams.reduce(
        (sum, ws) =>
          sum + ws.milestones.reduce((s, ms) => s + ms.tasks.length, 0),
        0,
      ),
    [workstreams],
  );
  const totalMilestones = useMemo(
    () => workstreams.reduce((sum, ws) => sum + ws.milestones.length, 0),
    [workstreams],
  );

  // Resolve linked opportunity rows against the cached opps list.
  const linkedOpps: { link: ProjectOpportunityLink; opp: SfOpportunity | undefined }[] =
    useMemo(() => {
      const links = linkedQ.data ?? [];
      const byId = new Map(opps.map((o) => [o.Id, o]));
      return links.map((link) => ({ link, opp: byId.get(link.opportunity_id) }));
    }, [linkedQ.data, opps]);

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Workstreams" value={String(workstreams.length)} />
        <Stat label="Milestones" value={String(totalMilestones)} />
        <Stat label="Open tasks" value={String(openTasks.length)} />
      </div>

      {project.description ? (
        <Section title="Description">
          <div className="px-4 py-3 text-[13px] text-ink-2 whitespace-pre-wrap">
            {project.description}
          </div>
        </Section>
      ) : null}

      {/* Workstreams */}
      <Section title={`Workstreams (${workstreams.length})`}>
        {detailQ.isLoading ? (
          <Empty>Loading…</Empty>
        ) : workstreams.length === 0 ? (
          <Empty>No workstreams.</Empty>
        ) : (
          <ul className="flex flex-col">
            {workstreams.map((ws) => {
              const taskCount = ws.milestones.reduce(
                (s, ms) => s + ms.tasks.length,
                0,
              );
              return (
                <li
                  key={ws.id}
                  className="flex items-center gap-3 border-b border-border-strong px-4 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">
                      {ws.name}
                    </div>
                    {ws.description ? (
                      <div className="truncate text-[11.5px] text-ink-3">
                        {ws.description}
                      </div>
                    ) : null}
                  </div>
                  <span className="mono flex-shrink-0 text-[11px] text-ink-3">
                    {ws.milestones.length} milestone
                    {ws.milestones.length === 1 ? "" : "s"}
                  </span>
                  <span className="mono flex-shrink-0 text-[11px] text-ink-3">
                    {taskCount} task{taskCount === 1 ? "" : "s"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* Tasks across all workstreams (open, sorted by deadline) */}
      <Section title={`Open tasks (${openTasks.length})`}>
        {detailQ.isLoading ? (
          <Empty>Loading…</Empty>
        ) : openTasks.length === 0 ? (
          <Empty>
            {totalTasks === 0
              ? "No tasks on this project."
              : "All tasks closed."}
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {openTasks.slice(0, 30).map(({ task, workstream }) => (
              <TaskRow key={task.id} task={task} workstream={workstream} />
            ))}
            {openTasks.length > 30 ? (
              <li className="px-4 py-2 text-[11.5px] text-ink-3">
                + {openTasks.length - 30} more
              </li>
            ) : null}
          </ul>
        )}
      </Section>

      {/* Linked opportunities */}
      <Section title={`Linked opportunities (${linkedOpps.length})`}>
        {linkedQ.isLoading ? (
          <Empty>Loading…</Empty>
        ) : linkedOpps.length === 0 ? (
          <Empty>No opportunities linked to this project.</Empty>
        ) : (
          <ul className="flex flex-col">
            {linkedOpps.map(({ link, opp }) => (
              <li
                key={link.id}
                className="flex items-center gap-3 border-b border-border-strong px-4 py-2.5 last:border-b-0"
              >
                {link.role ? <Tag>{link.role}</Tag> : null}
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/opportunities/${link.opportunity_id}`}
                    className="block truncate text-[13px] font-medium hover:underline"
                  >
                    {opp?.Name ?? link.opportunity_id}
                  </Link>
                  {opp?.Account?.Name ? (
                    <div className="truncate text-[11.5px] text-ink-3">
                      {opp.Account.Name}
                    </div>
                  ) : null}
                </div>
                {opp?.StageName ? (
                  <span className="flex-shrink-0 text-[11px] text-ink-3">
                    {opp.StageName}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function TaskRow({
  task,
  workstream,
}: {
  task: ProjectTask;
  workstream: string;
}) {
  const status = (task.status ?? "").toLowerCase();
  const overdue =
    task.deadline &&
    !Number.isNaN(new Date(task.deadline).getTime()) &&
    new Date(task.deadline).getTime() < Date.now();

  return (
    <li className="flex items-center gap-3 border-b border-border-strong px-4 py-2 last:border-b-0">
      <span
        className={cn(
          "inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium",
          status === "in_progress" || status === "in progress"
            ? "bg-accent-soft text-accent-ink"
            : status === "blocked"
              ? "bg-amber-soft text-amber"
              : "bg-surface-2 text-ink-3",
        )}
      >
        {task.status ?? "Open"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{task.title}</div>
        <div className="truncate text-[11px] text-ink-3">
          {workstream}
          {task.owner ? ` · ${task.owner}` : ""}
        </div>
      </div>
      <span
        className={cn(
          "mono w-24 flex-shrink-0 text-right text-[11px]",
          overdue ? "font-semibold text-red" : "text-ink-3",
        )}
      >
        {fmtDate(task.deadline)}
      </span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-strong bg-surface-2 px-3 py-2">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className="mono mt-0.5 text-[15px] font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      <div className="border-b border-border-strong bg-surface-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
        {title}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-5 text-center text-[12px] text-ink-3">
      {children}
    </div>
  );
}
