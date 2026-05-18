import { Link } from "react-router-dom";

import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import { fmtDate } from "@/lib/format";

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
 * Read-only detail view for a unified task. Editing is intentionally
 * deferred — see TODO below.
 *
 * TODO(tasks-edit): wire inline edit. CRM tasks edit through
 * `PUT /api/salesforce/tasks/{id}` (already exists in main.py); project
 * tasks edit through `PUT /api/project-tasks/{id}`. Both need optimistic
 * cache updates against ["my-tasks"] and ["project-detail", id].
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
    >
      {task ? <TaskDrawerBody task={task} /> : null}
    </Drawer>
  );
}

function TaskDrawerBody({ task }: { task: FlatTask }) {
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
          <span className="text-[13px]">
            {task.owner || <span className="text-ink-3">—</span>}
          </span>
        </Field>
        <Field label="Deadline">
          <span className="mono text-[13px] tabular-nums">
            {fmtDate(task.deadline)}
          </span>
        </Field>
        <Field label="Status">
          <span className="text-[13px]">{task.status || "—"}</span>
        </Field>
        <Field label="Priority">
          <span className="text-[13px]">
            {task.source === "crm"
              ? task.priority || <span className="text-ink-3">—</span>
              : <span className="text-ink-3">— (project tasks have no priority field)</span>}
          </span>
        </Field>
        {task.type ? (
          <Field label="Type">
            <span className="text-[13px]">{task.type}</span>
          </Field>
        ) : null}
      </div>

      <Field label="Description">
        {task.description ? (
          <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">
            {task.description}
          </div>
        ) : (
          <span className="text-[12.5px] italic text-ink-3">No description.</span>
        )}
      </Field>

      <div className="rounded-md border border-dashed border-border-strong bg-surface-2 px-3 py-2 text-[11.5px] text-ink-3">
        Read-only for now. Inline editing lands in a follow-up pass —
        CRM tasks via{" "}
        <code className="rounded bg-surface px-1 py-0.5 text-[10.5px]">
          PUT /api/salesforce/tasks/{"{id}"}
        </code>
        , project tasks via{" "}
        <code className="rounded bg-surface px-1 py-0.5 text-[10.5px]">
          PUT /api/project-tasks/{"{id}"}
        </code>
        .
      </div>
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
