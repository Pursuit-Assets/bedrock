import { useMemo } from "react";
import { Link } from "react-router-dom";

import { Drawer } from "@/components/ui/Drawer";
import { InlineDate, InlineSelect, InlineText } from "@/components/ui/InlineEdit";
import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";
import { useUpdateTask } from "@/services/opportunities";
import { useActiveUsers } from "@/services/users";
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
  deadline: string | null;
  description: string | null;
  parentLabel: string | null;
  parentLink: string | null;
  type?: string | null;
}

/**
 * Detail view for a unified task. Editable for CRM tasks (Subject,
 * Status, Priority, Owner, Deadline, Description), routed through
 * `PUT /api/salesforce/tasks/{id}` via useUpdateTask. Project tasks
 * remain read-only here (they have their own edit surface inside
 * the Projects page — TODO: extend if needed).
 */
export function TaskDrawer({
  task,
  rawTask,
  onClose,
}: {
  task: FlatTask | null;
  /** Underlying SF Task. When present and task.source === "crm", the
   *  drawer renders inline-edit controls for Status / Priority / Owner
   *  / Deadline / Description. */
  rawTask?: SfTask | null;
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
    >
      {task ? <TaskDrawerBody task={task} rawTask={rawTask ?? null} /> : null}
    </Drawer>
  );
}

function TaskDrawerBody({ task, rawTask }: { task: FlatTask; rawTask: SfTask | null }) {
  const editable = task.source === "crm" && rawTask != null;
  const updateTask = useUpdateTask();
  const usersQ = useActiveUsers();
  const ownerOptions = useMemo(
    () => (usersQ.data ?? []).map((u) => ({ value: u.Id, label: u.Name })),
    [usersQ.data],
  );

  const save = (patch: Parameters<typeof updateTask.mutateAsync>[0]["patch"]) => {
    if (!rawTask) return Promise.resolve();
    return updateTask.mutateAsync({ id: rawTask.Id, patch }).then(() => undefined);
  };

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

      {editable ? (
        <Field label="Subject">
          <InlineText
            value={rawTask.Subject ?? ""}
            onSave={(v) => save({ Subject: v })}
            placeholder="(no subject)"
          />
        </Field>
      ) : null}

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
        <Field label="Owner">
          {editable ? (
            <InlineSelect
              value={rawTask.OwnerId ?? null}
              options={ownerOptions}
              onSave={(v) => save({ OwnerId: v })}
              renderValue={() => (
                <span className="text-[13px] text-ink">
                  {rawTask.OwnerName ?? ownerOptions.find((o) => o.value === rawTask.OwnerId)?.label ?? "—"}
                </span>
              )}
            />
          ) : (
            <span className="text-[13px]">
              {task.owner || <span className="text-ink-3">—</span>}
            </span>
          )}
        </Field>
        <Field label="Deadline">
          {editable ? (
            <InlineDate
              value={rawTask.ActivityDate ?? null}
              onSave={(v) => save({ ActivityDate: v })}
              placeholder="—"
            />
          ) : (
            <span className="mono text-[13px] tabular-nums">
              {fmtDate(task.deadline)}
            </span>
          )}
        </Field>
        <Field label="Status">
          {editable ? (
            <InlineSelect
              value={rawTask.Status ?? null}
              options={STATUS_OPTIONS}
              onSave={(v) => save({ Status: v })}
            />
          ) : (
            <span className="text-[13px]">{task.status || "—"}</span>
          )}
        </Field>
        <Field label="Priority">
          {editable ? (
            <InlineSelect
              value={rawTask.Priority ?? null}
              options={PRIORITY_OPTIONS}
              onSave={(v) => save({ Priority: v })}
            />
          ) : (
            <span className="text-[13px]">
              {task.source === "crm"
                ? task.priority || <span className="text-ink-3">—</span>
                : <span className="text-ink-3">— (project tasks have no priority field)</span>}
            </span>
          )}
        </Field>
        {task.type ? (
          <Field label="Type">
            <span className="text-[13px]">{task.type}</span>
          </Field>
        ) : null}
      </div>

      <Field label="Description">
        {editable ? (
          <InlineText
            value={rawTask.Description ?? ""}
            onSave={(v) => save({ Description: v })}
            multiline
            placeholder="Add a description…"
            className="text-[13px] leading-relaxed text-ink-2"
          />
        ) : task.description ? (
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">
            {task.description}
          </div>
        ) : (
          <span className="text-[12.5px] italic text-ink-3">No description.</span>
        )}
      </Field>

      {!editable ? (
        <div className="rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-2 text-[11.5px] text-ink-3">
          Project tasks edit inline on the Projects page. Drawer editing
          for them lands in a follow-up.
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
