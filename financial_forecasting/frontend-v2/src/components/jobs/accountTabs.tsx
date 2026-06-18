/**
 * Account expand-panel tabs (RowExpandPanel): Opportunities · Contacts ·
 * Activity · Tasks · Comments · Builders · Roles.
 *
 * Everything is manageable here, mirroring the rest of the app:
 *  - Opportunities/Contacts: inline-editable rows + add (new opp; add existing
 *    or new contact).
 *  - Builders/Roles: grouped per opportunity, each using the existing addable
 *    OppBuilderActivity / OppRolesSection so a builder/role is always linked to
 *    a specific opportunity.
 *  - Tasks/Comments: account-direct (JobsTasks/JobsComments parentType=account)
 *    plus a read rollup of items tagged to the account's opps + contacts, each
 *    chipped with what it's tagged to.
 *  - Activity: read rollup across opps+contacts + a "log activity" form.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Briefcase, CheckSquare, MessageSquare, Plus, User, X } from "lucide-react";

import { JobsActivityList } from "@/components/jobs/JobsActivityList";
import { JobsComments } from "@/components/jobs/JobsComments";
import { JobsTasks } from "@/components/jobs/JobsTasks";
import { RowExpandPanel } from "@/components/RowExpandPanel";
import { withReferrer } from "@/components/detail";
import { InlineSelect } from "@/components/ui/InlineEdit";
import { cn } from "@/lib/utils";
import {
  useAccountActivity,
  useAccountBuilders,
  useAccountComments,
  useAccountRoles,
  useAccountTasks,
  useAddContactToJobs,
  useBuilders,
  useContactSearch,
  useCreateContact,
  useCreateOpportunity,
  useLogActivity,
  type AccountBuilderRow,
  type AccountComment,
  type AccountRole,
  type AccountTask,
  type DealType,
  type JobsAccount,
} from "@/services/jobs";
import {
  useCreateBuilderActivity, useCreateRole, useUpdateBuilderActivity, useUpdateRole,
  type AppStage, type RoleStatus,
} from "@/services/jobsOpps2";

import {
  ContactsLinkTab, DEAL_TYPE_OPTIONS, OppsTab, initials,
  jobsContactPath, jobsOpportunityPath, oppRoleLabel,
} from "./jobsEntity";

const jobsRef = withReferrer({ pathname: "/jobs", label: "Jobs" });
const inputCls = "h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent";

function Loading() { return <div className="px-4 py-6 text-[12.5px] text-ink-3">Loading…</div>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="px-4 py-6 text-[12.5px] text-ink-3">{children}</div>; }

function ScopeChip({ scope, label, parentId }: { scope: "opportunity" | "contact"; label: string; parentId?: string }) {
  const to = scope === "opportunity" ? (parentId ? jobsOpportunityPath(parentId) : null) : (parentId ? jobsContactPath(Number(parentId)) : null);
  const cls = scope === "opportunity" ? "bg-accent-soft text-accent-ink" : "bg-sky-50 text-sky-700";
  const inner = (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", cls)}>
      {scope === "opportunity" ? <Briefcase size={9} /> : <User size={9} />}{label || (scope === "opportunity" ? "Opportunity" : "Contact")}
    </span>
  );
  return to ? <Link to={to} state={jobsRef} className="hover:opacity-80">{inner}</Link> : inner;
}

// ── Opportunities ────────────────────────────────────────────────────────────────
function AccountOppsTab({ account }: { account: JobsAccount }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [dealType, setDealType] = useState<DealType | "">("ft");
  const create = useCreateOpportunity();

  const submit = () => {
    create.mutate(
      { account_id: account.account_id ?? "UNKNOWN", account_name: account.account, stage: "active_in_discussions", deal_type: (dealType || null) as DealType | null, title: title.trim() || null },
      { onSuccess: () => { setTitle(""); setAdding(false); } },
    );
  };

  return (
    <div className="flex flex-col gap-2 p-4">
      <OppsTab opps={account.opportunities} />
      {adding ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Role title (optional)" className={cn(inputCls, "w-52")} />
          <select value={dealType} onChange={(e) => setDealType(e.target.value as DealType | "")} className={inputCls}>
            <option value="">No type</option>
            {DEAL_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button type="button" disabled={create.isPending} onClick={submit} className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">Create</button>
          <button type="button" onClick={() => setAdding(false)} className="text-ink-3 hover:text-ink"><X size={14} /></button>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex w-fit items-center gap-1 rounded border border-border-strong px-2.5 py-1 text-[12px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={12} /> New opportunity</button>
      )}
    </div>
  );
}

// ── Contacts ───────────────────────────────────────────────────────────────────────
function AccountContactsTab({ account }: { account: JobsAccount }) {
  const [mode, setMode] = useState<null | "existing" | "new">(null);
  const [search, setSearch] = useState("");
  const { data: results = [] } = useContactSearch(search);
  const addToJobs = useAddContactToJobs();
  const createContact = useCreateContact();
  const [form, setForm] = useState({ full_name: "", email: "", title: "", linkedin: "" });

  return (
    <div className="flex flex-col gap-2 p-4">
      <ContactsLinkTab contacts={account.prospects} />
      {mode === null && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setMode("existing")} className="flex w-fit items-center gap-1 rounded border border-border-strong px-2.5 py-1 text-[12px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={12} /> Add existing</button>
          <button type="button" onClick={() => setMode("new")} className="flex w-fit items-center gap-1 rounded border border-border-strong px-2.5 py-1 text-[12px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={12} /> New contact</button>
        </div>
      )}
      {mode === "existing" && (
        <div className="rounded-md border border-dashed border-border-strong bg-surface-2/40 p-2">
          <div className="flex items-center gap-2">
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search contacts…" className={cn(inputCls, "flex-1")} />
            <button type="button" onClick={() => { setMode(null); setSearch(""); }} className="text-ink-3 hover:text-ink"><X size={14} /></button>
          </div>
          {search.trim().length >= 2 && (
            <div className="mt-2 flex flex-col gap-1">
              {results.slice(0, 8).map((r) => (
                <div key={r.contact_id} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[9px] font-bold text-accent-ink">{initials(r.full_name)}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{r.full_name}</span>
                  {r.airtable_id ? <span className="text-[10px] text-ink-4">already in jobs</span> : (
                    <button type="button" onClick={() => addToJobs.mutate({ id: r.contact_id, add: true })} className="rounded border border-border-strong px-1.5 py-0.5 text-[10px] text-ink-3 hover:border-accent hover:text-accent">+ Add</button>
                  )}
                </div>
              ))}
              {results.length === 0 && <span className="px-2 text-[11px] text-ink-4">No matches.</span>}
            </div>
          )}
        </div>
      )}
      {mode === "new" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
          <input autoFocus value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Full name *" className={cn(inputCls, "w-40")} />
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="Email" className={cn(inputCls, "w-44")} />
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" className={cn(inputCls, "w-36")} />
          <button type="button" disabled={!form.full_name.trim() || createContact.isPending} onClick={() => createContact.mutate({ full_name: form.full_name.trim(), email: form.email.trim() || undefined, current_title: form.title.trim() || undefined, current_company: account.account, contact_stage: "lead" }, { onSuccess: () => { setForm({ full_name: "", email: "", title: "", linkedin: "" }); setMode(null); } })} className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">Create</button>
          <button type="button" onClick={() => setMode(null)} className="text-ink-3 hover:text-ink"><X size={14} /></button>
        </div>
      )}
    </div>
  );
}

// ── Activity ─────────────────────────────────────────────────────────────────────────
function AccountActivityTab({ account }: { account: JobsAccount }) {
  const { data, isLoading } = useAccountActivity(account.account_key);
  const log = useLogActivity();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"call" | "text" | "linkedin">("call");
  const [target, setTarget] = useState("");          // "opp:<id>" | "contact:<id>"
  const [note, setNote] = useState("");

  const submit = () => {
    const [kind, id] = target.split(":");
    const body = kind === "opp" ? { jobs_opportunity_id: id } : { contact_id: Number(id) };
    log.mutate({ ...body, type, description: note.trim() } as Parameters<typeof log.mutate>[0], { onSuccess: () => { setNote(""); setOpen(false); } });
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">Activity</span>
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded border border-border-strong px-2 py-0.5 text-[11px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={11} /> Log</button>
      </div>
      {open && (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)} className={inputCls}>
            <option value="call">Call</option><option value="text">Text</option><option value="linkedin">LinkedIn</option>
          </select>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className={cn(inputCls, "max-w-[220px]")}>
            <option value="">Tag to…</option>
            {account.opportunities.map((o) => <option key={o.id} value={`opp:${o.id}`}>Opp · {oppRoleLabel(o)}</option>)}
            {account.prospects.map((c) => <option key={c.contact_id} value={`contact:${c.contact_id}`}>Contact · {c.full_name}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note" className={cn(inputCls, "min-w-[200px] flex-1")} />
          <button type="button" disabled={!target || !note.trim() || log.isPending} onClick={submit} className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">Log</button>
        </div>
      )}
      {isLoading ? <Loading /> : <JobsActivityList entries={data ?? []} emptyMessage="No activity across this account's opportunities or contacts yet." />}
    </div>
  );
}

// ── Tasks ──────────────────────────────────────────────────────────────────────────
function TaskRollupRow({ t }: { t: AccountTask }) {
  const done = t.status === "done";
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-1.5">
      <CheckSquare size={12} className={cn("shrink-0", done ? "text-green-600" : "text-ink-4")} />
      <span className={cn("min-w-0 flex-1 truncate text-[12px]", done ? "text-ink-4 line-through" : "text-ink-2")}>{t.title || "Untitled task"}</span>
      <ScopeChip scope={t.scope} label={t.scope_label} parentId={t.parent_id} />
    </div>
  );
}

function AccountTasksTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountTasks(accountKey);
  return (
    <div className="flex flex-col gap-3 p-3">
      <JobsTasks parentType="account" parentId={accountKey} />
      <div>
        <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">Tagged to opportunities &amp; contacts</div>
        {isLoading ? <Loading /> : data.length === 0 ? <Empty>None yet.</Empty> : (
          <div className="flex flex-col gap-1.5">{data.map((t) => <TaskRollupRow key={t.id} t={t} />)}</div>
        )}
      </div>
    </div>
  );
}

// ── Comments ─────────────────────────────────────────────────────────────────────────
function CommentRollupRow({ c }: { c: AccountComment }) {
  return (
    <div className="rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <MessageSquare size={12} className="shrink-0 text-ink-4" />
        <span className="text-[11.5px] font-medium text-ink-2">{c.author_email ?? "—"}</span>
        <span className="ml-auto"><ScopeChip scope={c.scope} label={c.scope_label} /></span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12px] text-ink-2">{c.content}</p>
    </div>
  );
}

function AccountCommentsTab({ accountKey }: { accountKey: string }) {
  const { data = [], isLoading } = useAccountComments(accountKey);
  return (
    <div className="flex flex-col gap-3 p-3">
      <JobsComments parentType="account" parentId={accountKey} />
      <div>
        <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-4">On opportunities &amp; contacts</div>
        {isLoading ? <Loading /> : data.length === 0 ? <Empty>None yet.</Empty> : (
          <div className="flex flex-col gap-1.5">{data.map((c) => <CommentRollupRow key={c.id} c={c} />)}</div>
        )}
      </div>
    </div>
  );
}

// ── Roles — ONE table across the account's opps, each tagged to its opportunity ───────
const ROLE_STATUS_OPTIONS: { value: RoleStatus; label: string }[] = [
  { value: "open", label: "Open" }, { value: "filled", label: "Filled" }, { value: "cancelled", label: "Cancelled" },
];
const ROLE_STATUS_BADGE: Record<string, string> = {
  open: "bg-accent-soft text-accent-ink", filled: "bg-green-soft text-green", cancelled: "bg-stone-100 text-stone-500",
};

function OppTag({ oppId, title }: { oppId: string; title: string | null }) {
  return (
    <Link to={jobsOpportunityPath(oppId)} state={jobsRef} className="inline-flex w-fit items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium leading-none text-accent-ink hover:opacity-80">
      <Briefcase size={9} />{title || "Opportunity"}
    </Link>
  );
}

function AccountRolesTab({ account }: { account: JobsAccount }) {
  const key = account.account_key;
  const { data: roles = [], isLoading } = useAccountRoles(key);
  const updateRole = useUpdateRole();
  const createRole = useCreateRole();
  const [adding, setAdding] = useState(false);
  const [oppId, setOppId] = useState("");
  const [title, setTitle] = useState("");

  const submit = () => {
    if (!oppId || !title.trim()) return;
    createRole.mutate({ oppId, title: title.trim() }, { onSuccess: () => { setTitle(""); setAdding(false); } });
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {isLoading ? <Loading /> : roles.length === 0 ? <Empty>No roles across this account's opportunities yet.</Empty> : (
        <table className="w-full table-fixed border-collapse">
          <colgroup><col style={{ width: "34%" }} /><col style={{ width: "26%" }} /><col style={{ width: "16%" }} /><col style={{ width: "12%" }} /><col style={{ width: "12%" }} /></colgroup>
          <thead className="text-[10px] uppercase tracking-wider text-ink-4"><tr>
            <th className="px-2 py-1 text-left font-semibold">Role</th><th className="px-2 py-1 text-left font-semibold">Opportunity</th>
            <th className="px-2 py-1 text-left font-semibold">Commitment</th><th className="px-2 py-1 text-left font-semibold">Status</th>
            <th className="px-2 py-1 text-left font-semibold">Salary</th>
          </tr></thead>
          <tbody>
            {roles.map((r: AccountRole) => (
              <tr key={r.id} className="border-t border-border-strong/60">
                <td className="overflow-hidden px-2 py-1.5"><span className="truncate text-[12.5px] font-medium text-ink">{r.title || "Untitled role"}{r.is_trial ? <span className="ml-1 rounded-full bg-amber-soft px-1.5 py-0.5 text-[9px] font-medium text-amber">Trial</span> : null}</span></td>
                <td className="overflow-hidden px-2 py-1.5"><OppTag oppId={r.opportunity_id} title={r.opp_title} /></td>
                <td className="overflow-hidden px-2 py-1.5 text-[11.5px] text-ink-3">{r.commitment === "open-market" ? "Open-market" : "Committed"}</td>
                <td className="overflow-hidden px-2 py-1.5">
                  <InlineSelect<string> value={r.status} options={ROLE_STATUS_OPTIONS} emptyLabel="—"
                    renderValue={(v) => <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", ROLE_STATUS_BADGE[v ?? ""] ?? "bg-stone-100 text-stone-500")}>{v ?? "—"}</span>}
                    onSave={(v) => updateRole.mutateAsync({ roleId: r.id, oppId: r.opportunity_id, status: v as RoleStatus }).then(() => undefined)} />
                </td>
                <td className="overflow-hidden px-2 py-1.5 text-[11.5px] text-ink-2">{r.approx_salary ? `$${r.approx_salary.toLocaleString()}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
          <select value={oppId} onChange={(e) => setOppId(e.target.value)} className={cn(inputCls, "max-w-[220px]")}>
            <option value="">Link to opportunity…</option>
            {account.opportunities.map((o) => <option key={o.id} value={o.id}>{oppRoleLabel(o)}</option>)}
          </select>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Role title" className={cn(inputCls, "w-48")} />
          <button type="button" disabled={!oppId || !title.trim() || createRole.isPending} onClick={submit} className="h-7 rounded bg-accent px-3 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50">Add role</button>
          <button type="button" onClick={() => setAdding(false)} className="text-ink-3 hover:text-ink"><X size={14} /></button>
        </div>
      ) : account.opportunities.length === 0 ? (
        <span className="text-[11.5px] text-ink-4">Add an opportunity first — roles link to one.</span>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex w-fit items-center gap-1 rounded border border-border-strong px-2.5 py-1 text-[12px] text-ink-3 hover:border-accent hover:text-accent"><Plus size={12} /> Add role</button>
      )}
    </div>
  );
}

// ── Builders — ONE table across the account's opps, each tagged to its opportunity/role ─
const APP_STAGE_OPTIONS: { value: AppStage; label: string }[] = [
  { value: "applied", label: "Applied" }, { value: "interview", label: "Interview" }, { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" }, { value: "withdrawn", label: "Withdrawn" },
];
const APP_STAGE_BADGE: Record<string, string> = {
  applied: "bg-stone-100 text-stone-600", interview: "bg-accent-soft text-accent-ink",
  accepted: "bg-green-soft text-green", rejected: "bg-red-soft text-red", withdrawn: "bg-stone-100 text-stone-500",
};

/** Add-builder form, mounted with a chosen opp so the per-opp create hook is valid. */
function AddBuilderForm({ oppId, onDone }: { oppId: string; onDone: () => void }) {
  const [search, setSearch] = useState("");
  const { data: builders = [] } = useBuilders(search || undefined);
  const create = useCreateBuilderActivity(oppId);
  return (
    <div className="mt-1 flex flex-col gap-1">
      <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search builders…" className={cn(inputCls, "w-full")} />
      {search.trim().length >= 2 && (
        <div className="flex flex-col gap-0.5">
          {builders.slice(0, 6).map((b) => (
            <button key={b.user_id} type="button" onClick={() => create.mutate({ user_id: b.user_id, builder_name: b.name, stage: "applied" }, { onSuccess: onDone })} className="flex items-center justify-between rounded px-2 py-1 text-left text-[12px] hover:bg-surface-2">
              <span className="truncate text-ink">{b.name}</span><span className="text-[10px] text-ink-4">{b.cohort}</span>
            </button>
          ))}
          {builders.length === 0 && <span className="px-2 text-[11px] text-ink-4">No matches.</span>}
        </div>
      )}
    </div>
  );
}

function AccountBuildersTab({ account }: { account: JobsAccount }) {
  const key = account.account_key;
  const { data, isLoading } = useAccountBuilders(key);
  const updateStage = useUpdateBuilderActivity("");   // PATCH by appId; invalidates ['jobs'] → refetches rollup
  const [oppId, setOppId] = useState("");
  const rows = data?.rows ?? [];
  const s = data?.summary ?? {};
  // opp_title per opportunity for tagging (rows carry company/role, not opp id+title cleanly) → map via account.opportunities by role? rollup rows lack opp id; tag by role_title/company.
  return (
    <div className="flex flex-col gap-2 p-3">
      {!isLoading && rows.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-ink-3"><span>{s.applied ?? 0} applied</span><span>·</span><span>{s.interview ?? 0} interviewing</span><span>·</span><span>{s.accepted ?? 0} hired</span></div>
      )}
      {isLoading ? <Loading /> : rows.length === 0 ? <Empty>No builders have applied to this account's opportunities yet.</Empty> : (
        <table className="w-full table-fixed border-collapse">
          <colgroup><col style={{ width: "34%" }} /><col style={{ width: "34%" }} /><col style={{ width: "16%" }} /><col style={{ width: "16%" }} /></colgroup>
          <thead className="text-[10px] uppercase tracking-wider text-ink-4"><tr>
            <th className="px-2 py-1 text-left font-semibold">Builder</th><th className="px-2 py-1 text-left font-semibold">Role</th>
            <th className="px-2 py-1 text-left font-semibold">Stage</th><th className="px-2 py-1 text-left font-semibold">Applied</th>
          </tr></thead>
          <tbody>
            {rows.map((b: AccountBuilderRow) => (
              <tr key={b.job_application_id} className="border-t border-border-strong/60">
                <td className="overflow-hidden px-2 py-1.5"><span className="truncate text-[12.5px] font-medium text-ink">{b.builder || "—"}</span></td>
                <td className="overflow-hidden px-2 py-1.5"><span className="truncate text-[11.5px] text-ink-3">{b.role_title || b.company_name || "—"}</span></td>
                <td className="overflow-hidden px-2 py-1.5">
                  <InlineSelect<string> value={b.stage} options={APP_STAGE_OPTIONS} emptyLabel="—"
                    renderValue={(v) => <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", APP_STAGE_BADGE[v ?? ""] ?? "bg-stone-100 text-stone-500")}>{v ?? "—"}</span>}
                    onSave={(v) => updateStage.mutateAsync({ appId: b.job_application_id, stage: v as AppStage }).then(() => undefined)} />
                </td>
                <td className="overflow-hidden px-2 py-1.5 text-[11.5px] text-ink-4">{b.date_applied ? new Date(b.date_applied).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {account.opportunities.length === 0 ? (
        <span className="text-[11.5px] text-ink-4">Add an opportunity first — builders apply to one.</span>
      ) : (
        <div className="flex flex-col gap-1 rounded-md border border-dashed border-border-strong bg-surface-2/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <Plus size={12} className="text-ink-4" />
            <select value={oppId} onChange={(e) => setOppId(e.target.value)} className={cn(inputCls, "max-w-[240px]")}>
              <option value="">Add builder to opportunity…</option>
              {account.opportunities.map((o) => <option key={o.id} value={o.id}>{oppRoleLabel(o)}</option>)}
            </select>
          </div>
          {oppId && <AddBuilderForm oppId={oppId} onDone={() => setOppId("")} />}
        </div>
      )}
    </div>
  );
}

export function AccountExpandTabs({ account }: { account: JobsAccount }) {
  const key = account.account_key;
  const tabs = useMemo(() => [
    { id: "opps", label: "Opportunities", count: account.opp_count, render: () => <AccountOppsTab account={account} /> },
    { id: "contacts", label: "Contacts", count: account.prospect_count, render: () => <AccountContactsTab account={account} /> },
    { id: "activity", label: "Activity", render: () => <AccountActivityTab account={account} /> },
    { id: "tasks", label: "Tasks", render: () => <AccountTasksTab accountKey={key} /> },
    { id: "comments", label: "Comments", render: () => <AccountCommentsTab accountKey={key} /> },
    { id: "builders", label: "Builders", render: () => <AccountBuildersTab account={account} /> },
    { id: "roles", label: "Roles", render: () => <AccountRolesTab account={account} /> },
  ], [account, key]);
  return <RowExpandPanel tabs={tabs} />;
}
