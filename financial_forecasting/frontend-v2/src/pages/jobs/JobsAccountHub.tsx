/**
 * Jobs · Accounts — the account-level hub.
 *
 * The account (company) is the organizing unit: every company with an
 * opportunity OR a jobs prospect is one row, carrying a derived status (same
 * vocabulary as the portfolio Accounts tab). Expanding a row reveals everything
 * at that account — its opportunities and its prospects — so the whole pipeline
 * is managed from one view. Clicking a prospect expands their full detail inline.
 */
import { Fragment, useCallback, useMemo, useState } from "react";

import { Briefcase, ChevronDown, ChevronRight, Linkedin, Users } from "lucide-react";

import { AccountAvatar } from "@/components/AccountAvatar";
import { ContactDetail, initials } from "@/components/jobs/ProspectAccountExpandPanel";
import { Tag } from "@/components/ui/Tag";
import { accountStatusVariant } from "@/lib/accountStatus";
import { cn } from "@/lib/utils";
import {
  useJobsAccounts,
  STAGE_LABELS,
  type JobStage,
  type DealType,
  type JobsAccount,
  type JobsAccountOpp,
  type JobsAccountProspect,
  type JobsAccountStatus,
} from "@/services/jobs";

// ── Shared metadata ──────────────────────────────────────────────────────────

const DEAL_STAGE_STYLE = (stage: JobStage): string => {
  if (stage.startsWith("active")) return "bg-accent-soft text-accent-ink";
  if (stage === "closed_won")      return "bg-green-soft text-green";
  if (stage === "closed_lost")     return "bg-stone-100 text-stone-500";
  if (stage.startsWith("on_hold")) return "bg-amber-soft text-amber";
  return "bg-stone-100 text-stone-500";
};

const DEAL_TYPE_LABELS: Record<DealType, string> = {
  ft: "FT", pt_contract: "Contract", capstone: "Capstone",
  volunteer: "Volunteer", workshop: "Workshop", pilot: "Pilot",
};

const CONTACT_STAGE_STYLES: Record<string, { label: string; className: string }> = {
  active:           { label: "Active",   className: "bg-green-50 text-green-700" },
  initial_outreach: { label: "Outreach", className: "bg-accent-soft text-accent-ink" },
  lead:             { label: "Lead",     className: "bg-stone-100 text-stone-500" },
  on_hold:          { label: "On Hold",  className: "bg-amber-50 text-amber-600" },
};

function ContactStagePill({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-ink-4">—</span>;
  const s = CONTACT_STAGE_STYLES[stage];
  if (!s) return <span className="text-[11px] text-ink-2">{stage}</span>;
  return <span className={cn("inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", s.className)}>{s.label}</span>;
}

const STATUS_FILTER: { value: string; label: string }[] = [
  { value: "",              label: "All statuses" },
  { value: "Pursuing",      label: "Pursuing" },
  { value: "Stewarding",    label: "Stewarding" },
  { value: "Re-activating", label: "Re-activating" },
  { value: "Prospect",      label: "Prospect" },
  { value: "Dormant",       label: "Dormant" },
];

const DEAL_TYPE_FILTER: { value: string; label: string }[] = [
  { value: "all",         label: "All deal types" },
  { value: "ft",          label: "Full-time" },
  { value: "pt_contract", label: "Contract" },
  { value: "capstone",    label: "Capstone" },
  { value: "volunteer",   label: "Volunteer" },
  { value: "workshop",    label: "Workshop" },
  { value: "pilot",       label: "Pilot" },
];

function relativeDays(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Opportunity row (inside the expand panel) ───────────────────────────────────

function OppRow({ opp }: { opp: JobsAccountOpp }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border-strong/70 bg-surface px-3 py-2">
      <Briefcase size={13} className="shrink-0 text-ink-4" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{opp.title || "Untitled opportunity"}</span>
      {opp.num_roles ? <span className="shrink-0 text-[11px] text-ink-3">{opp.num_roles} role{opp.num_roles === 1 ? "" : "s"}</span> : null}
      {opp.deal_type && <span className="shrink-0 text-[10.5px] font-medium uppercase tracking-wide text-ink-4">{DEAL_TYPE_LABELS[opp.deal_type] ?? opp.deal_type}</span>}
      <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none", DEAL_STAGE_STYLE(opp.stage))}>
        {STAGE_LABELS[opp.stage] ?? opp.stage}
      </span>
    </div>
  );
}

// ── Prospect row + inline detail (inside the expand panel) ──────────────────────

function ProspectRow({ contact, expanded, onToggle }: { contact: JobsAccountProspect; expanded: boolean; onToggle: () => void }) {
  return (
    <Fragment>
      <div className={cn("flex cursor-pointer items-center gap-2.5 rounded-md border border-border-strong/70 px-3 py-2 hover:bg-surface-2/50", expanded ? "rounded-b-none border-b-0 bg-surface-2/50" : "bg-surface")} onClick={onToggle}>
        {expanded ? <ChevronDown size={12} className="shrink-0 text-ink-3" /> : <ChevronRight size={12} className="shrink-0 text-ink-3" />}
        <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-bold leading-none text-accent-ink">{initials(contact.full_name)}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{contact.full_name || "—"}</span>
        <span className="hidden min-w-0 max-w-[40%] flex-1 truncate text-[12px] text-ink-3 sm:block">{contact.current_title || ""}</span>
        <span className="shrink-0"><ContactStagePill stage={contact.contact_stage} /></span>
        {contact.linkedin_url
          ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="shrink-0 text-ink-3 hover:text-accent"><Linkedin size={13} /></a>
          : <span className="w-[13px] shrink-0" />}
      </div>
      {expanded && (
        <div className="overflow-hidden rounded-b-md border border-t-0 border-border-strong/70 bg-surface">
          <ContactDetail contactId={contact.contact_id} />
        </div>
      )}
    </Fragment>
  );
}

// ── Account row ──────────────────────────────────────────────────────────────────

function AccountRow({ account, expanded, onToggle }: { account: JobsAccount; expanded: boolean; onToggle: () => void }) {
  const [expandedContactId, setExpandedContactId] = useState<number | null>(null);
  return (
    <Fragment>
      <tr className="cursor-pointer border-t border-border-strong bg-surface hover:bg-surface-2/50" onClick={onToggle}>
        <td className="py-2 pl-3 pr-1 align-middle">
          {expanded ? <ChevronDown size={13} className="text-ink-3" /> : <ChevronRight size={13} className="text-ink-3" />}
        </td>
        <td className="px-2 py-2 align-middle">
          <span className="flex min-w-0 items-center gap-2.5">
            <AccountAvatar name={account.account} logoUrl={null} size={20} />
            <span className="truncate text-[13.5px] font-semibold text-ink">{account.account}</span>
          </span>
        </td>
        <td className="px-2 py-2 align-middle">
          <Tag variant={accountStatusVariant(account.account_status)}>{account.account_status}</Tag>
        </td>
        <td className="px-2 py-2 align-middle text-[12px] text-ink-2">
          {account.opp_count > 0 ? <span className="inline-flex items-center gap-1"><Briefcase size={11} className="text-ink-4" />{account.opp_count}</span> : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-2 py-2 align-middle text-[12px] text-ink-2">
          {account.prospect_count > 0 ? <span className="inline-flex items-center gap-1"><Users size={11} className="text-ink-4" />{account.prospect_count}</span> : <span className="text-ink-4">—</span>}
        </td>
        <td className="px-2 py-2 align-middle text-[12px] text-ink-3">{account.owner_email?.split("@")[0] ?? "—"}</td>
        <td className="px-3 py-2 align-middle text-[11.5px] text-ink-4">{relativeDays(account.last_activity)}</td>
      </tr>
      {expanded && (
        <tr className="border-t border-border-strong bg-surface-2/30">
          <td colSpan={7} className="p-0">
            <div className="flex flex-col gap-4 border-l-2 border-accent/30 px-5 py-4">
              <section className="flex flex-col gap-1.5">
                <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  <Briefcase size={12} /> Opportunities <span className="font-mono text-ink-4">{account.opp_count}</span>
                </h4>
                {account.opportunities.length === 0 ? (
                  <p className="text-[12px] text-ink-4">No opportunities yet.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">{account.opportunities.map((o) => <OppRow key={o.id} opp={o} />)}</div>
                )}
              </section>
              <section className="flex flex-col gap-1.5">
                <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  <Users size={12} /> Prospects <span className="font-mono text-ink-4">{account.prospect_count}</span>
                </h4>
                {account.prospects.length === 0 ? (
                  <p className="text-[12px] text-ink-4">No prospects yet.</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {account.prospects.map((c) => (
                      <ProspectRow
                        key={c.contact_id}
                        contact={c}
                        expanded={expandedContactId === c.contact_id}
                        onToggle={() => setExpandedContactId((prev) => (prev === c.contact_id ? null : c.contact_id))}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ── Main component ────────────────────────────────────────────────────────────────

export function JobsAccountHub({ initialQuery }: { initialQuery?: string } = {}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [status, setStatus] = useState<string>("");
  const [dealType, setDealType] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: accounts = [], isLoading } = useJobsAccounts(dealType);

  const toggle = useCallback((acct: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(acct)) next.delete(acct);
      else next.add(acct);
      return next;
    });
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    return accounts.filter((a) => {
      if (status && a.account_status !== (status as JobsAccountStatus)) return false;
      if (!q) return true;
      if (a.account.toLowerCase().includes(q)) return true;
      // match a prospect or opp inside the account too
      return (
        a.prospects.some((p) => (p.full_name ?? "").toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q)) ||
        a.opportunities.some((o) => (o.title ?? "").toLowerCase().includes(q))
      );
    });
  }, [accounts, q, status]);

  const totals = useMemo(() => filtered.reduce(
    (acc, a) => ({ opps: acc.opps + a.opp_count, prospects: acc.prospects + a.prospect_count }),
    { opps: 0, prospects: 0 },
  ), [filtered]);

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          placeholder="Search accounts, prospects, opportunities…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 w-72 rounded border border-border-strong bg-surface px-3 text-[12.5px] font-medium text-ink-2 outline-none placeholder:font-normal placeholder:text-ink-3 focus:border-accent focus:text-ink"
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} title="Filter by account status" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {STATUS_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select value={dealType} onChange={(e) => setDealType(e.target.value)} title="Filter to accounts with a deal of this type" className="h-7 rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent">
          {DEAL_TYPE_FILTER.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="font-mono text-[12px] text-ink-4">
          {isLoading ? "…" : `${filtered.length} account${filtered.length === 1 ? "" : "s"} · ${totals.opps} opp${totals.opps === 1 ? "" : "s"} · ${totals.prospects} prospect${totals.prospects === 1 ? "" : "s"}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setExpanded(new Set(filtered.map((a) => a.account)))} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Expand all</button>
          <button type="button" onClick={() => setExpanded(new Set())} className="h-7 rounded border border-border-strong bg-surface px-2.5 text-[12px] text-ink-3 hover:text-ink">Collapse all</button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-auto rounded-lg border border-border-strong bg-surface">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="w-[34px] py-1.5 pl-3" />
              <th className="px-2 py-1.5 text-left font-semibold">Account</th>
              <th className="w-[120px] px-2 py-1.5 text-left font-semibold">Status</th>
              <th className="w-[90px] px-2 py-1.5 text-left font-semibold">Opps</th>
              <th className="w-[100px] px-2 py-1.5 text-left font-semibold">Prospects</th>
              <th className="w-[120px] px-2 py-1.5 text-left font-semibold">Owner</th>
              <th className="w-[100px] px-3 py-1.5 text-left font-semibold">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="px-6 py-10 text-center text-[13px] text-ink-3">Loading accounts…</td></tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-6 py-10 text-center text-[13px] text-ink-3">
                  No accounts match your filters.{" "}
                  <button type="button" className="text-accent underline underline-offset-2" onClick={() => { setQuery(""); setStatus(""); setDealType("all"); }}>Clear filters</button>
                </td>
              </tr>
            ) : (
              filtered.map((a) => (
                <AccountRow key={a.account} account={a} expanded={expanded.has(a.account)} onToggle={() => toggle(a.account)} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
