/**
 * Account expand-panel tabs (RowExpandPanel pattern): Opportunities · Contacts ·
 * Activity · Tasks · Comments · Builders · Roles. Tasks/Comments/Builders/Roles
 * are READ rollups across the account's opportunities + contacts — each item
 * shows a chip for what it's tagged to and links through to that entity.
 */
import { Link } from "react-router-dom";
import { Briefcase, CheckSquare, MessageSquare, User } from "lucide-react";

import { JobsActivityList } from "@/components/jobs/JobsActivityList";
import { RowExpandPanel } from "@/components/RowExpandPanel";
import { withReferrer } from "@/components/detail";
import { cn } from "@/lib/utils";
import {
  useAccountActivity,
  useAccountBuilders,
  useAccountComments,
  useAccountRoles,
  useAccountTasks,
  type AccountComment,
  type AccountRole,
  type AccountTask,
  type JobsAccount,
} from "@/services/jobs";

import { ContactsLinkTab, OppsTab, jobsContactPath, jobsOpportunityPath } from "./jobsEntity";

const jobsRef = withReferrer({ pathname: "/jobs", label: "Jobs" });

/** Chip + link showing which entity a rolled-up item is tagged to. */
function ScopeChip({ scope, label, parentId }: { scope: "opportunity" | "contact"; label: string; parentId?: string }) {
  const to = scope === "opportunity"
    ? (parentId ? jobsOpportunityPath(parentId) : null)
    : (parentId ? jobsContactPath(Number(parentId)) : null);
  const cls = scope === "opportunity" ? "bg-accent-soft text-accent-ink" : "bg-sky-50 text-sky-700";
  const inner = (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", cls)}>
      {scope === "opportunity" ? <Briefcase size={9} /> : <User size={9} />}
      {label || (scope === "opportunity" ? "Opportunity" : "Contact")}
    </span>
  );
  return to ? <Link to={to} state={jobsRef} className="hover:opacity-80">{inner}</Link> : inner;
}

function Loading() { return <div className="px-4 py-6 text-[12.5px] text-ink-3">Loading…</div>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="px-4 py-6 text-[12.5px] text-ink-3">{children}</div>; }

function AccountActivityTab({ accountKey }: { accountKey: string }) {
  const { data, isLoading } = useAccountActivity(accountKey);
  if (isLoading) return <Loading />;
  return <JobsActivityList entries={data ?? []} emptyMessage="No activity across this account's opportunities or contacts yet." />;
}

function TaskRow({ t }: { t: AccountTask }) {
  const done = t.status === "done";
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <CheckSquare size={13} className={cn("shrink-0", done ? "text-green-600" : "text-ink-4")} />
      <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", done ? "text-ink-4 line-through" : "font-medium text-ink")}>{t.title || "Untitled task"}</span>
      {t.deadline && <span className="shrink-0 text-[11px] text-ink-4">{new Date(t.deadline).toLocaleDateString()}</span>}
      <ScopeChip scope={t.scope} label={t.scope_label} parentId={t.parent_id} />
    </div>
  );
}

function AccountTasksTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountTasks(accountKey);
  if (isLoading) return <Loading />;
  if (data.length === 0) return <Empty>No tasks tagged to this account's opportunities or contacts yet.</Empty>;
  return <div className="flex flex-col gap-1.5 p-4">{data.map((t) => <TaskRow key={t.id} t={t} />)}</div>;
}

function CommentRow({ c }: { c: AccountComment }) {
  return (
    <div className="rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <MessageSquare size={12} className="shrink-0 text-ink-4" />
        <span className="text-[11.5px] font-medium text-ink-2">{c.author_email ?? "—"}</span>
        <span className="ml-auto"><ScopeChip scope={c.scope} label={c.scope_label} /></span>
        {c.created_at && <span className="shrink-0 text-[11px] text-ink-4">{new Date(c.created_at).toLocaleDateString()}</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-2">{c.content}</p>
    </div>
  );
}

function AccountCommentsTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountComments(accountKey);
  if (isLoading) return <Loading />;
  if (data.length === 0) return <Empty>No comments on this account's opportunities or contacts yet.</Empty>;
  return <div className="flex flex-col gap-1.5 p-4">{data.map((c) => <CommentRow key={c.id} c={c} />)}</div>;
}

const STAGE_BADGE: Record<string, string> = {
  applied: "bg-stone-100 text-stone-600", interview: "bg-accent-soft text-accent-ink",
  accepted: "bg-green-soft text-green", rejected: "bg-red-soft text-red", withdrawn: "bg-stone-100 text-stone-500",
};

function AccountBuildersTab({ accountKey }: { accountKey: string }) {
  const { data, isLoading } = useAccountBuilders(accountKey);
  if (isLoading) return <Loading />;
  const rows = data?.rows ?? [];
  const s = data?.summary ?? {};
  if (rows.length === 0) return <Empty>No builders have applied to this account's opportunities yet.</Empty>;
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2 text-[11px] text-ink-3">
        <span>{s.applied ?? 0} applied</span><span>·</span><span>{s.interview ?? 0} interviewing</span><span>·</span><span>{s.accepted ?? 0} hired</span>
      </div>
      {rows.map((b) => (
        <div key={b.job_application_id} className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{b.builder || "—"}</span>
          {b.role_title && <span className="shrink-0 truncate text-[11.5px] text-ink-3">{b.role_title}</span>}
          {b.stage && <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", STAGE_BADGE[b.stage] ?? "bg-stone-100 text-stone-500")}>{b.stage}</span>}
        </div>
      ))}
    </div>
  );
}

function RoleRow({ r }: { r: AccountRole }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{r.title || "Untitled role"}</span>
      {r.is_trial ? <span className="shrink-0 rounded-full bg-amber-soft px-2 py-0.5 text-[10px] font-medium text-amber">Trial</span> : null}
      {r.commitment === "open-market" ? <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">Open-market</span> : null}
      {r.status && <span className="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium text-stone-600">{r.status}</span>}
      <Link to={jobsOpportunityPath(r.opportunity_id)} state={jobsRef} className="shrink-0">
        <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium leading-none text-accent-ink hover:opacity-80"><Briefcase size={9} />{r.opp_title || "Opportunity"}</span>
      </Link>
    </div>
  );
}

function AccountRolesTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountRoles(accountKey);
  if (isLoading) return <Loading />;
  if (data.length === 0) return <Empty>No committed roles across this account's opportunities yet.</Empty>;
  return <div className="flex flex-col gap-1.5 p-4">{data.map((r) => <RoleRow key={r.id} r={r} />)}</div>;
}

/** The full account expand panel. */
export function AccountExpandTabs({ account }: { account: JobsAccount }) {
  const key = account.account_key;
  return (
    <RowExpandPanel
      tabs={[
        { id: "opps", label: "Opportunities", count: account.opp_count, render: () => <OppsTab opps={account.opportunities} /> },
        { id: "contacts", label: "Contacts", count: account.prospect_count, render: () => <ContactsLinkTab contacts={account.prospects} /> },
        { id: "activity", label: "Activity", render: () => <AccountActivityTab accountKey={key} /> },
        { id: "tasks", label: "Tasks", render: () => <AccountTasksTab accountKey={key} /> },
        { id: "comments", label: "Comments", render: () => <AccountCommentsTab accountKey={key} /> },
        { id: "builders", label: "Builders", render: () => <AccountBuildersTab accountKey={key} /> },
        { id: "roles", label: "Roles", render: () => <AccountRolesTab accountKey={key} /> },
      ]}
    />
  );
}
