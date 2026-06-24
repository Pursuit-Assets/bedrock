/**
 * Jobs command center — the home tab Damon & Avni manage the pipeline from.
 *
 * Three zones:
 *   1. Tasks       — every open task across opps/prospects/accounts, with a
 *                    My / per-person filter, inline edit/assign/complete, and a
 *                    quick-add tied to an account.
 *   2. Interviews  — confirmed roles and the builders progressing through them,
 *                    advanceable inline (applied → interview → accepted/hired).
 *   3. Triage      — accounts with new activity, and stale accounts that have
 *                    gone quiet, so nothing slips.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Circle, Plus, Briefcase } from "lucide-react";

import { SectionCard } from "@/components/detail";
import { Tag } from "@/components/ui/Tag";
import { InlineDate } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import { useActiveUsers } from "@/services/projects";
import { useCurrentUser } from "@/services/auth";
import { useJobsAccounts, STAGE_LABELS, type JobStage } from "@/services/jobs";
import {
  useAllJobsTasks, useUpdateTaskById, useCreateTaskForParent, useDeleteTaskById,
  type JobsTaskEnriched,
} from "@/services/jobsTasks";
import {
  useInterviewPipeline, useAdvanceBuilderStage,
  type InterviewPipelineOpp, type AppStage,
} from "@/services/jobsOpps2";

const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Tasks zone ────────────────────────────────────────────────────────────────
function dueBucket(deadline: string | null): "overdue" | "today" | "upcoming" | "none" {
  if (!deadline) return "none";
  const t = todayIso();
  if (deadline < t) return "overdue";
  if (deadline === t) return "today";
  return "upcoming";
}

function TaskRow({
  task, ownerOptions, onPatch, onDelete,
}: {
  task: JobsTaskEnriched;
  ownerOptions: { value: string; label: string }[];
  onPatch: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const bucket = dueBucket(task.deadline);
  return (
    <div className="flex items-center gap-2 border-t border-border-strong px-3 py-1.5 hover:bg-surface-2/40">
      <button type="button" onClick={() => onPatch({ status: "Completed" })} title="Mark complete"
        className="shrink-0 text-ink-4 hover:text-green">
        <Circle size={15} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] text-ink">{task.title}</div>
        <div className="truncate text-[11px] text-ink-4">
          {task.parent_label}{task.parent_sublabel ? ` · ${task.parent_sublabel}` : ""}
        </div>
      </div>
      <select
        value={task.owner_ids[0] ?? ""}
        onChange={(e) => onPatch({ owner_ids: e.target.value ? [e.target.value] : [] })}
        className="h-6 max-w-[130px] rounded border border-border-strong bg-surface px-1 text-[11.5px] text-ink-2 outline-none focus:border-accent"
        title="Assignee"
      >
        <option value="">Unassigned</option>
        {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <div className={cn(
        "w-[92px] shrink-0 text-right text-[11.5px]",
        bucket === "overdue" ? "font-semibold text-red" : bucket === "today" ? "font-semibold text-amber" : "text-ink-3",
      )}>
        <InlineDate value={task.deadline} variant="short" align="right"
          onSave={async (v) => onPatch({ deadline: v || null })} />
      </div>
      <button type="button" onClick={onDelete} title="Delete" className="shrink-0 text-ink-4 hover:text-red">×</button>
    </div>
  );
}

function TasksZone() {
  const { data: tasks = [], isLoading } = useAllJobsTasks();
  const { data: users = [] } = useActiveUsers();
  const { data: me } = useCurrentUser();
  const { data: accounts = [] } = useJobsAccounts("all");
  const update = useUpdateTaskById();
  const create = useCreateTaskForParent();
  const del = useDeleteTaskById();

  const ownerOptions = useMemo(
    () => users.map((u) => ({ value: u.id, label: u.display_name || u.email })),
    [users],
  );
  const myId = useMemo(
    () => users.find((u) => u.email?.toLowerCase() === me?.email?.toLowerCase())?.id ?? null,
    [users, me],
  );
  // Filter dropdown lists only people who actually have tasks (names come from
  // the enriched owner_ids/owner_names parallel arrays).
  const taskAssignees = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks) t.owner_ids.forEach((id, i) => m.set(id, t.owner_names[i] ?? id));
    return [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [tasks]);

  const [assignee, setAssignee] = useState<string>("all"); // all | me | <ownerId>
  const filtered = useMemo(() => {
    if (assignee === "all") return tasks;
    const target = assignee === "me" ? myId : assignee;
    if (!target) return assignee === "me" ? [] : tasks;
    return tasks.filter((t) => t.owner_ids.includes(target));
  }, [tasks, assignee, myId]);

  const groups: { key: string; label: string; items: JobsTaskEnriched[] }[] = useMemo(() => {
    const by: Record<string, JobsTaskEnriched[]> = { overdue: [], today: [], upcoming: [], none: [] };
    for (const t of filtered) by[dueBucket(t.deadline)].push(t);
    return [
      { key: "overdue", label: "Overdue", items: by.overdue },
      { key: "today", label: "Due today", items: by.today },
      { key: "upcoming", label: "Upcoming", items: by.upcoming },
      { key: "none", label: "No due date", items: by.none },
    ].filter((g) => g.items.length > 0);
  }, [filtered]);

  // Quick-add (tied to an account).
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAccount, setNewAccount] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newDue, setNewDue] = useState("");
  const submitNew = async () => {
    if (!newTitle.trim() || !newAccount) return;
    await create.mutateAsync({
      parent_type: "account", parent_id: newAccount, title: newTitle.trim(),
      owner_ids: newOwner ? [newOwner] : [], deadline: newDue || null,
    });
    setNewTitle(""); setNewDue(""); setAdding(false);
  };

  return (
    <SectionCard title={`Tasks · ${filtered.length}`} storageScope="jobs-home-tasks" action={
      <div className="flex items-center gap-2">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
          className="h-7 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
          <option value="all">Everyone</option>
          <option value="me" disabled={!myId}>My tasks</option>
          {taskAssignees.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" onClick={() => setAdding((v) => !v)}
          className="inline-flex h-7 items-center gap-1 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink-2 hover:bg-surface-2">
          <Plus size={12} /> Add
        </button>
      </div>
    }>
      <div className="flex flex-col">
        {adding && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border-strong bg-surface-2/40 px-3 py-2">
            <input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Task title…"
              onKeyDown={(e) => { if (e.key === "Enter") void submitNew(); }}
              className="h-7 min-w-[180px] flex-1 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent" />
            <select value={newAccount} onChange={(e) => setNewAccount(e.target.value)}
              className="h-7 max-w-[180px] rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent">
              <option value="">Account…</option>
              {accounts.map((a) => <option key={a.account_key} value={a.account_key}>{a.account}</option>)}
            </select>
            <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent">
              <option value="">Assignee…</option>
              {ownerOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)}
              className="h-7 rounded border border-border-strong bg-surface px-1 text-[12px] text-ink-2 outline-none focus:border-accent" />
            <button type="button" onClick={() => void submitNew()} disabled={!newTitle.trim() || !newAccount}
              className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-40">Save</button>
          </div>
        )}
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">No open tasks. 🎉</div>
        ) : groups.map((g) => (
          <div key={g.key}>
            <div className="bg-surface-2/60 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
              {g.label} · {g.items.length}
            </div>
            {g.items.map((t) => (
              <TaskRow key={t.id} task={t} ownerOptions={ownerOptions}
                onPatch={(patch) => update.mutate({ taskId: t.id, patch })}
                onDelete={() => del.mutate(t.id)} />
            ))}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ── Interview tracker zone ─────────────────────────────────────────────────────
const STAGE_COLS: { stage: AppStage; label: string }[] = [
  { stage: "applied", label: "Applied" },
  { stage: "interview", label: "Interviewing" },
  { stage: "accepted", label: "Accepted" },
];
const NEXT_STAGE: Partial<Record<AppStage, AppStage>> = { applied: "interview", interview: "accepted" };

function InterviewCard({ opp }: { opp: InterviewPipelineOpp }) {
  const advance = useAdvanceBuilderStage();
  const byStage = (s: AppStage) => opp.builders.filter((b) => b.stage === s);
  return (
    <div className="rounded-lg border border-border-strong bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link to={`/jobs?view=team`} className="truncate text-[13px] font-semibold text-ink hover:text-accent">
          {opp.account_name}
        </Link>
        <Tag variant="accent">{STAGE_LABELS[opp.stage as JobStage] ?? opp.stage}</Tag>
      </div>
      {opp.roles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {opp.roles.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1 rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-ink-2">
              <Briefcase size={10} className="text-ink-4" />{r.title ?? "Role"}
              {r.status === "filled" && <span className="text-green">✓</span>}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {STAGE_COLS.map((col) => {
          const rows = byStage(col.stage);
          return (
            <div key={col.stage} className="rounded border border-border-strong/60 bg-surface-2/30 p-1.5">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">{col.label} · {rows.length}</div>
              <div className="flex flex-col gap-1">
                {rows.map((b) => {
                  const next = NEXT_STAGE[b.stage as AppStage];
                  return (
                    <div key={b.job_application_id} className="group flex items-center justify-between gap-1 rounded bg-surface px-1.5 py-1 text-[11.5px] text-ink-2">
                      <span className="truncate">{b.builder || "—"}</span>
                      {next && (
                        <button type="button" title={`Move to ${next}`}
                          onClick={() => advance.mutate({ appId: b.job_application_id, stage: next })}
                          className="shrink-0 rounded px-1 text-ink-4 opacity-0 transition-opacity hover:bg-accent-soft hover:text-accent group-hover:opacity-100">→</button>
                      )}
                    </div>
                  );
                })}
                {rows.length === 0 && <div className="px-1 py-0.5 text-[11px] text-ink-4">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InterviewsZone() {
  const { data: opps = [], isLoading } = useInterviewPipeline();
  return (
    <SectionCard title={`Builders in interviews · ${opps.length}`} storageScope="jobs-home-interviews">
      {isLoading ? (
        <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
      ) : opps.length === 0 ? (
        <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">No confirmed roles with builders yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-2">
          {opps.map((o) => <InterviewCard key={o.opportunity_id} opp={o} />)}
        </div>
      )}
    </SectionCard>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
export function JobsHome() {
  const { data: me } = useCurrentUser();
  const { data: tasks = [] } = useAllJobsTasks();
  const { data: pipeline = [] } = useInterviewPipeline();

  const overdue = tasks.filter((t) => dueBucket(t.deadline) === "overdue").length;
  const dueToday = tasks.filter((t) => dueBucket(t.deadline) === "today").length;
  const interviewing = pipeline.reduce((n, o) => n + o.summary.interview, 0);

  const greeting = (() => {
    const h = new Date().getHours();
    const tod = h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
    const first = me?.name?.split(" ")[0];
    return `Good ${tod}${first ? `, ${first}` : ""}`;
  })();

  // A quiet one-line digest (not chunky metric chips) — the at-a-glance read.
  const digest = [
    `${tasks.length} open task${tasks.length === 1 ? "" : "s"}`,
    overdue > 0 && `${overdue} overdue`,
    dueToday > 0 && `${dueToday} due today`,
    interviewing > 0 && `${interviewing} builder${interviewing === 1 ? "" : "s"} interviewing`,
  ].filter(Boolean).join("  ·  ");

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-5 py-5">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-[20px] font-semibold tracking-tight text-ink">{greeting}</h1>
        <p className="text-[12.5px] text-ink-3">{digest}</p>
      </div>

      <TasksZone />
      <InterviewsZone />
    </div>
  );
}
