/**
 * Jobs command center — the home tab Damon & Avni manage the pipeline from.
 * Styled to match the Performance tab: full-width (inherits the page's px-7),
 * gap-7 zones, lightweight uppercase section labels, bordered surface panels.
 *
 *   1. Tasks       — every open task across opps/prospects/accounts, with a
 *                    My / per-person filter, inline edit/assign/complete, and a
 *                    quick-add tied to an account.
 *   2. Interviews  — confirmed roles and the builders progressing through them,
 *                    advanceable inline (applied → interview → accepted/hired).
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Circle, Plus, Briefcase, UserPlus, X } from "lucide-react";

import { Tag } from "@/components/ui/Tag";
import { InlineDate } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import { useActiveUsers } from "@/services/projects";
import { useCurrentUser } from "@/services/auth";
import {
  useJobsAccounts, STAGE_LABELS, type JobStage,
  useCandidates, usePromoteCandidate, useDismissCandidate, type JobCandidate,
} from "@/services/jobs";
import {
  useAllJobsTasks, useUpdateTaskById, useCreateTaskForParent, useDeleteTaskById,
  type JobsTaskEnriched,
} from "@/services/jobsTasks";
import {
  useInterviewPipeline, useAdvanceBuilderStage,
  type InterviewPipelineOpp, type AppStage,
} from "@/services/jobsOpps2";

const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Section label + bordered panel (mirrors the Performance tab's SectionWrap) ──
function Section({ title, count, action, children }: {
  title: string; count?: number; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
          {count != null && <span className="text-[11px] tabular-nums text-ink-4">{count}</span>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

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
    <Section title="Tasks" count={filtered.length} action={
      <div className="flex items-center gap-2">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 outline-none focus:border-accent">
          <option value="all">Everyone</option>
          <option value="me" disabled={!myId}>My tasks</option>
          {taskAssignees.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" onClick={() => setAdding((v) => !v)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border-strong bg-surface px-2 text-[12px] text-ink-2 hover:bg-surface-2">
          <Plus size={12} /> Add
        </button>
      </div>
    }>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
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
            <div className={cn(
              "px-3 py-1 text-[10px] font-semibold uppercase tracking-wider",
              g.key === "overdue" ? "bg-red-soft text-red"
                : g.key === "today" ? "bg-amber-soft text-amber"
                : "bg-surface-2/60 text-ink-4",
            )}>
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
    </Section>
  );
}

// ── Interview tracker zone ─────────────────────────────────────────────────────
const STAGE_COLS: { stage: AppStage; label: string }[] = [
  { stage: "applied", label: "Applied" },
  { stage: "interview", label: "Interviewing" },
  { stage: "accepted", label: "Accepted" },
];
const NEXT_STAGE: Partial<Record<AppStage, AppStage>> = { applied: "interview", interview: "accepted" };

// Per-stage tint so the interview columns read with color (like Performance).
const STAGE_COL_STYLE: Record<AppStage, { col: string; head: string }> = {
  applied:   { col: "border-border-strong/60 bg-surface-2/40", head: "text-ink-4" },
  interview: { col: "border-accent/30 bg-accent-soft/50", head: "text-accent-ink" },
  accepted:  { col: "border-green/30 bg-green-soft/50", head: "text-green" },
  rejected:  { col: "border-border-strong/60 bg-surface-2/40", head: "text-ink-4" },
  withdrawn: { col: "border-border-strong/60 bg-surface-2/40", head: "text-ink-4" },
};

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
          const c = STAGE_COL_STYLE[col.stage];
          return (
            <div key={col.stage} className={cn("rounded border p-1.5", c.col)}>
              <div className={cn("mb-1 text-[10px] font-semibold uppercase tracking-wider", c.head)}>{col.label} · {rows.length}</div>
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
    <Section title="Builders in interviews" count={opps.length}>
      {isLoading ? (
        <div className="rounded-lg border border-border-strong bg-surface px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
      ) : opps.length === 0 ? (
        <div className="rounded-lg border border-border-strong bg-surface px-3 py-8 text-center text-[12.5px] text-ink-3">No confirmed roles with builders yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {opps.map((o) => <InterviewCard key={o.opportunity_id} opp={o} />)}
        </div>
      )}
    </Section>
  );
}

// ── Candidate review queue ────────────────────────────────────────────────────
// Email recipients auto-created from Avni/Damon's sent mail that need a human to
// confirm identity. Fill name/company inline → Add to pipeline, or Dismiss.
function CandidateRow({ cand }: { cand: JobCandidate }) {
  const promote = usePromoteCandidate();
  const dismiss = useDismissCandidate();
  const [name, setName] = useState(cand.full_name ?? "");
  const [company, setCompany] = useState(cand.current_company ?? "");
  const busy = promote.isPending || dismiss.isPending;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border-strong px-3 py-2 hover:bg-surface-2/40">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-ink">{cand.email}</div>
        <div className="truncate text-[11px] text-ink-4">
          {cand.email_count} email{cand.email_count === 1 ? "" : "s"}
          {cand.last_subject ? ` · ${cand.last_subject}` : ""}
        </div>
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name"
        className="h-7 w-32 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
      <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company"
        className="h-7 w-36 rounded border border-border-strong bg-surface px-2 text-[12px] text-ink outline-none focus:border-accent" />
      <button type="button" disabled={busy}
        onClick={() => promote.mutate({ id: cand.contact_id, full_name: name || undefined, current_company: company || undefined })}
        className="inline-flex h-7 items-center gap-1 rounded bg-accent px-2.5 text-[12px] font-medium text-white disabled:opacity-40"
        title="Add to pipeline">
        <UserPlus size={12} /> Add
      </button>
      <button type="button" disabled={busy} onClick={() => dismiss.mutate(cand.contact_id)}
        className="grid h-7 w-7 place-items-center rounded text-ink-4 hover:bg-red-soft hover:text-red disabled:opacity-40"
        title="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

function CandidatesZone() {
  const { data: cands = [], isLoading } = useCandidates();
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? cands : cands.slice(0, 15);
  return (
    <Section title="Candidates to review" count={cands.length}>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-strong bg-surface">
        {isLoading ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Loading…</div>
        ) : cands.length === 0 ? (
          <div className="px-3 py-8 text-center text-[12.5px] text-ink-3">Nothing to review. 🎉</div>
        ) : (
          <>
            <div className="bg-surface-2/60 px-3 py-1.5 text-[11px] text-ink-4">
              People we emailed but couldn't auto-identify — confirm name/company, then add or dismiss.
            </div>
            {shown.map((c) => <CandidateRow key={c.contact_id} cand={c} />)}
            {cands.length > shown.length && (
              <button type="button" onClick={() => setShowAll(true)}
                className="border-t border-border-strong px-3 py-2 text-[12px] text-accent hover:bg-surface-2/50">
                Show all {cands.length}
              </button>
            )}
          </>
        )}
      </div>
    </Section>
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

  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[15px] font-semibold text-ink">{greeting}</h1>
        <span className="flex flex-wrap items-baseline gap-x-2.5 text-[11.5px]">
          <span className="text-ink-4">{tasks.length} open task{tasks.length === 1 ? "" : "s"}</span>
          {overdue > 0 && <span className="font-semibold text-red">· {overdue} overdue</span>}
          {dueToday > 0 && <span className="font-semibold text-amber">· {dueToday} due today</span>}
          {interviewing > 0 && <span className="font-semibold text-green">· {interviewing} interviewing</span>}
        </span>
      </div>

      <TasksZone />
      <CandidatesZone />
      <InterviewsZone />
    </div>
  );
}
