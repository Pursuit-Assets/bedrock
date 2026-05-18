import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Drawer } from "@/components/ui/Drawer";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";
import { useUpdateTask as useUpdateCrmTask } from "@/services/opportunities";
import { usePerm } from "@/services/permissions";
import { useUpdateTask as useUpdateProjectTask } from "@/services/projects";
import { useActiveUsers } from "@/services/users";

/**
 * Unified task representation rendered by both row + drawer. The Tasks
 * page builds these out of SF tasks (`my-tasks`) and Postgres project
 * tasks (`bedrock.project_task`).
 */
export interface FlatTask {
  source: "crm" | "project";
  id: string;
  title: string;
  status: string;
  priority: string | null;
  owner: string | null;
  /** SF OwnerId for CRM tasks — needed to seed the owner picker. */
  ownerId?: string | null;
  deadline: string | null;
  description: string | null;
  parentLabel: string | null;
  parentLink: string | null;
  type?: string | null;
}

const CRM_STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Waiting on someone else", label: "Waiting" },
  { value: "Deferred", label: "Deferred" },
  { value: "Completed", label: "Completed" },
];

const CRM_PRIORITY_OPTIONS = [
  { value: "Low", label: "Low" },
  { value: "Normal", label: "Normal" },
  { value: "High", label: "High" },
];

const PROJECT_STATUS_OPTIONS = [
  { value: "Not Started", label: "Not Started" },
  { value: "In Progress", label: "In Progress" },
  { value: "Blocked", label: "Blocked" },
  { value: "Completed", label: "Completed" },
];

const DRAWER_STORAGE_KEY = "bedrock:task-drawer:width";

/**
 * Editable detail view for a unified task.
 *
 * CRM tasks save through `PUT /api/salesforce/tasks/{id}` via
 * `useUpdateTask` from `services/opportunities` (which already does
 * cross-cache optimistic broadcast). Project tasks save through
 * `PUT /api/project-tasks/{id}` via `useUpdateTask(projectId)` from
 * `services/projects`.
 *
 * `my-tasks` is invalidated on every save so the home Inbox row
 * reflects the new state without a page reload.
 *
 * Edit affordances are gated by `edit_own_tasks`; without it the fields
 * render as read-only labels.
 */
export function TaskDrawer({
  task,
  onClose,
}: {
  task: FlatTask | null;
  onClose: () => void;
}) {
  const open = !!task;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={task?.title ?? "Task"}
      subtitle={task ? sourceLabel(task.source) : undefined}
      linkTo={task?.parentLink ?? undefined}
      width={560}
      resizable
      minWidth={420}
      maxWidth={840}
      storageKey={DRAWER_STORAGE_KEY}
    >
      {task ? <TaskDrawerBody task={task} /> : null}
    </Drawer>
  );
}

function TaskDrawerBody({ task }: { task: FlatTask }) {
  const canEdit = usePerm("edit_own_tasks");
  const qc = useQueryClient();

  const projectId = useMemo(() => parseProjectId(task), [task]);

  const updateCrm = useUpdateCrmTask();
  const updateProject = useUpdateProjectTask(projectId);

  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () =>
      (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const invalidateMyTasks = () => {
    void qc.invalidateQueries({ queryKey: ["my-tasks"] });
  };

  const saveCrm = async (patch: Record<string, string | null>) => {
    try {
      await updateCrm.mutateAsync({ id: task.id, patch });
      invalidateMyTasks();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast.error(`Task save failed: ${msg}`);
      throw e;
    }
  };

  const saveProject = async (
    patch: { title?: string; status?: string; owner?: string; deadline?: string | null },
  ) => {
    try {
      await updateProject.mutateAsync({ taskId: task.id, patch });
      invalidateMyTasks();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast.error(`Task save failed: ${msg}`);
      throw e;
    }
  };

  const titleSaver = task.source === "crm"
    ? (next: string) => saveCrm({ Subject: next })
    : (next: string) => saveProject({ title: next });

  const statusSaver = task.source === "crm"
    ? (next: string) => saveCrm({ Status: next })
    : (next: string) => saveProject({ status: next });

  const dateSaver = task.source === "crm"
    ? (next: string | null) => saveCrm({ ActivityDate: next })
    : (next: string | null) => saveProject({ deadline: next });

  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source={task.source} />
        <Tag variant={statusVariant(task.status)}>{task.status || "—"}</Tag>
        {task.source === "crm" && task.priority ? (
          <Tag variant={priorityVariant(task.priority)}>
            {task.priority}
          </Tag>
        ) : null}
      </div>

      <Field label="Subject">
        {canEdit ? (
          <InlineText
            value={task.title}
            onSave={titleSaver}
            placeholder="Untitled task"
            emptyLabel="Untitled task"
          />
        ) : (
          <span className="text-[13px]">{task.title || "—"}</span>
        )}
      </Field>

      {task.parentLabel ? (
        <Field label="Linked to">
          {task.parentLink ? (
            <Link
              to={task.parentLink}
              className="text-[13px] font-medium text-accent-ink hover:underline"
            >
              {task.parentLabel}
            </Link>
          ) : (
            <span className="text-[13px]">{task.parentLabel}</span>
          )}
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          {canEdit ? (
            <InlineSelect
              value={task.status}
              options={task.source === "crm" ? CRM_STATUS_OPTIONS : PROJECT_STATUS_OPTIONS}
              onSave={statusSaver}
              emptyLabel="Not Started"
            />
          ) : (
            <span className="text-[13px]">{task.status || "—"}</span>
          )}
        </Field>

        <Field label="Deadline">
          {canEdit ? (
            <InlineDate value={task.deadline} onSave={dateSaver} />
          ) : (
            <span className="mono text-[13px] tabular-nums">{fmtDate(task.deadline)}</span>
          )}
        </Field>

        <Field label="Owner">
          {task.source === "crm" && canEdit && task.ownerId && ownerOptions.length > 0 ? (
            <InlineSelect
              value={task.ownerId}
              options={ownerOptions}
              onSave={(next) => saveCrm({ OwnerId: next })}
              renderValue={(v) =>
                ownerOptions.find((o) => o.value === v)?.label ?? task.owner ?? "—"
              }
              emptyLabel="—"
            />
          ) : (
            <span className="text-[13px]">{task.owner || <span className="text-ink-3">—</span>}</span>
          )}
        </Field>

        <Field label="Priority">
          {task.source === "crm" && canEdit ? (
            <InlineSelect
              value={task.priority ?? "Normal"}
              options={CRM_PRIORITY_OPTIONS}
              onSave={(next) => saveCrm({ Priority: next })}
              emptyLabel="Normal"
            />
          ) : task.source === "crm" ? (
            <span className="text-[13px]">{task.priority || <span className="text-ink-3">—</span>}</span>
          ) : (
            <span className="text-[12.5px] italic text-ink-3">
              project tasks have no priority field
            </span>
          )}
        </Field>

        {task.type ? (
          <Field label="Type">
            <span className="text-[13px]">{task.type}</span>
          </Field>
        ) : null}
      </div>

      {task.source === "crm" ? (
        <Field label="Description">
          {canEdit ? (
            <InlineText
              value={task.description ?? ""}
              onSave={(next) => saveCrm({ Description: next })}
              placeholder="Add a description"
              emptyLabel="No description."
              multiline
            />
          ) : task.description ? (
            <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">
              {task.description}
            </div>
          ) : (
            <span className="text-[12.5px] italic text-ink-3">No description.</span>
          )}
        </Field>
      ) : task.description ? (
        <Field label="Description">
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">
            {task.description}
          </div>
        </Field>
      ) : null}

      {!canEdit ? (
        <div className="rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-2 text-[11.5px] text-ink-3">
          You don't have permission to edit tasks.
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function SourceBadge({ source }: { source: "crm" | "project" }) {
  if (source === "crm") {
    return (
      <span className="inline-flex items-center rounded border border-transparent bg-accent-soft px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wider text-accent-ink">
        CRM
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded border border-border-strong bg-surface-2 px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wider text-ink-2">
      Project
    </span>
  );
}

function sourceLabel(source: "crm" | "project"): string {
  return source === "crm" ? "Salesforce task" : "Bedrock project task";
}

/**
 * Extract project id from a project task's parent link.
 * Returns "" for CRM tasks so `useUpdateProjectTask("")` is a safe
 * no-op (it never gets invoked for CRM tasks anyway).
 */
function parseProjectId(task: FlatTask): string {
  if (task.source !== "project" || !task.parentLink) return "";
  const m = task.parentLink.match(/\/projects\/([^/?#]+)/);
  return m?.[1] ?? "";
}

export function statusVariant(
  s: string,
): "green" | "amber" | "red" | "default" {
  const v = (s || "").toLowerCase();
  if (v === "completed") return "green";
  if (v === "in progress" || v === "in-progress") return "amber";
  if (v === "blocked" || v === "deferred") return "red";
  return "default";
}

export function priorityVariant(
  p: string,
): "red" | "amber" | "default" {
  const v = (p || "").toLowerCase();
  if (v === "high" || v === "urgent") return "red";
  if (v === "normal" || v === "medium") return "amber";
  return "default";
}
