/**
 * AI-first candidate review (human in the loop). Enrichment is pre-computed in
 * the background and persisted, so the list + drawer show AI findings instantly.
 * The drawer: shows the AI read (name/title/company + reasoning), proposes an
 * account linkage, proposes existing-contact links you approve in one click,
 * shows the emails, and promotes/dismisses.
 */
import { useEffect, useMemo, useState } from "react";
import { Sparkles, Building2, Mail, UserPlus, X, ChevronDown, ChevronRight, Loader2, Check, Link2, RefreshCw } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import {
  useCandidates, useCandidateDetail, useEnrichCandidate, useLinkCandidate,
  usePromoteCandidate, useDismissCandidate, useJobsAccounts,
  type JobCandidate,
} from "@/services/jobs";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const confTone = (c?: string | null) => (c === "high" ? "green" : c === "medium" ? "amber" : "default") as "green" | "amber" | "default";

function EmailItem({ e }: { e: { subject: string | null; email_from: string | null; email_to: string[] | null; snippet: string | null; body: string | null; activity_date: string | null } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-border-strong">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2/40">
        {open ? <ChevronDown size={13} className="mt-0.5 shrink-0 text-ink-4" /> : <ChevronRight size={13} className="mt-0.5 shrink-0 text-ink-4" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] text-ink">{e.subject || "(no subject)"}</div>
          <div className="truncate text-[11px] text-ink-4">{e.email_from} · {fmtDate(e.activity_date)}</div>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-8 text-[12px] leading-relaxed text-ink-2">
          {e.email_to?.length ? <div className="mb-1 text-[11px] text-ink-4">To: {e.email_to.join(", ")}</div> : null}
          <div className="whitespace-pre-wrap">{e.body || e.snippet || "(no body)"}</div>
        </div>
      )}
    </div>
  );
}

function CandidateDrawer({ contactId, onClose }: { contactId: number | null; onClose: () => void }) {
  const { data, isLoading } = useCandidateDetail(contactId);
  const enrich = useEnrichCandidate();
  const link = useLinkCandidate();
  const promote = usePromoteCandidate();
  const dismiss = useDismissCandidate();
  const { data: accounts = [] } = useJobsAccounts("all");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");

  // Seed from persisted enrichment (or the contact) the moment detail loads.
  useEffect(() => {
    if (!data) return;
    const e = data.enrichment;
    setName(data.contact.full_name || e?.full_name || "");
    setTitle(data.contact.current_title || e?.title || "");
    setCompany(data.contact.current_company || e?.company || data.suggested_account?.account_name || "");
  }, [data?.contact.contact_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const accountNames = useMemo(() => accounts.map((a) => a.account).sort(), [accounts]);
  const e = data?.enrichment;
  const sug = data?.suggested_account;
  const dups = data?.possible_duplicates ?? [];
  const busy = promote.isPending || dismiss.isPending || link.isPending;

  return (
    <Drawer open={contactId != null} onClose={onClose}
      title={data?.contact.full_name || e?.full_name || data?.contact.email || "Candidate"}
      subtitle={data?.contact.email} width={680}>
      {isLoading || !data ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {/* AI enrichment (pre-computed, instant) */}
          <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent-ink"><Sparkles size={12} /> AI enrichment</span>
              <button type="button" onClick={() => contactId && enrich.mutate(contactId)}
                disabled={enrich.isPending}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-soft disabled:opacity-50">
                {enrich.isPending ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} Re-enrich
              </button>
            </div>
            {!e ? (
              <div className="text-[12px] text-ink-3">Not enriched yet — hit Re-enrich.</div>
            ) : (
              <div className="flex flex-col gap-1.5 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  {e.is_employer_contact === false && <Tag variant="amber">Not an employer contact</Tag>}
                  {e.confidence && <Tag variant={confTone(e.confidence)}>{e.confidence} confidence</Tag>}
                </div>
                {e.reasoning && <p className="text-[11.5px] leading-relaxed text-ink-2">{e.reasoning}</p>}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {e.full_name && e.full_name !== name && <Suggest label={`Name: ${e.full_name}`} onClick={() => setName(e.full_name!)} />}
                  {e.title && e.title !== title && <Suggest label={`Title: ${e.title}`} onClick={() => setTitle(e.title!)} />}
                  {e.company && e.company !== company && <Suggest label={`Company: ${e.company}`} onClick={() => setCompany(e.company!)} />}
                </div>
              </div>
            )}
          </div>

          {/* One-click duplicate links */}
          {dups.length > 0 && (
            <div className="rounded-lg border border-amber/40 bg-amber-soft/40 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber"><Link2 size={12} /> Likely existing contact</div>
              <div className="flex flex-col gap-1.5">
                {dups.map((d) => (
                  <div key={d.contact_id} className="flex items-center justify-between gap-2">
                    <div className="min-w-0 text-[12.5px] text-ink">
                      {d.full_name}{d.current_company ? <span className="text-ink-4"> · {d.current_company}</span> : ""}
                      {d.current_title ? <span className="text-ink-4"> · {d.current_title}</span> : ""}
                    </div>
                    <button type="button" disabled={busy}
                      onClick={() => contactId && link.mutate({ id: contactId, target: d.contact_id }, { onSuccess: onClose })}
                      className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-amber px-2.5 text-[12px] font-medium text-white disabled:opacity-40">
                      <Link2 size={12} /> Link
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Editable fields */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Full name"><input value={name} onChange={(ev) => setName(ev.target.value)} className={inputCls} /></Field>
            <Field label="Title"><input value={title} onChange={(ev) => setTitle(ev.target.value)} className={inputCls} /></Field>
            <Field label="Company / account">
              <input value={company} onChange={(ev) => setCompany(ev.target.value)} list="cand-accounts" className={inputCls} placeholder="Type or pick…" />
              <datalist id="cand-accounts">{accountNames.map((n) => <option key={n} value={n} />)}</datalist>
            </Field>
          </div>

          {/* Account linkage suggestion */}
          {sug && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border-strong bg-surface px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <Building2 size={14} className="shrink-0 text-ink-4" />
                <div className="min-w-0">
                  <div className="text-[12.5px] text-ink">
                    {sug.in_pipeline ? "Link to" : "New account"}: <span className="font-semibold">{sug.account_name}</span>
                    <Tag variant={confTone(sug.confidence)} className="ml-2">{sug.confidence}</Tag>
                  </div>
                  <div className="truncate text-[11px] text-ink-4">{sug.reason}</div>
                </div>
              </div>
              {sug.account_name && company !== sug.account_name && (
                <button type="button" onClick={() => setCompany(sug.account_name!)}
                  className="shrink-0 rounded border border-accent/40 px-2 py-1 text-[12px] text-accent hover:bg-accent-soft">Use</button>
              )}
            </div>
          )}

          {/* Emails */}
          <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
            <div className="flex items-center gap-1.5 bg-surface-2/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
              <Mail size={12} /> Emails · {data.emails.length}
            </div>
            {data.emails.length === 0 ? <div className="px-3 py-4 text-[12px] text-ink-3">No emails.</div>
              : data.emails.map((em) => <EmailItem key={em.id} e={em} />)}
          </div>

          {/* Actions */}
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-border-strong bg-surface pt-3">
            <button type="button" disabled={busy || !name}
              onClick={() => contactId && promote.mutate(
                { id: contactId, full_name: name || undefined, current_title: title || undefined, current_company: company || undefined },
                { onSuccess: onClose })}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-40">
              <UserPlus size={14} /> Add to pipeline
            </button>
            <button type="button" disabled={busy}
              onClick={() => contactId && dismiss.mutate(contactId, { onSuccess: onClose })}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong px-3 text-[13px] text-ink-2 hover:bg-red-soft hover:text-red disabled:opacity-40">
              <X size={14} /> Dismiss
            </button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

const inputCls = "h-8 w-full rounded border border-border-strong bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-accent";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1"><span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">{label}</span>{children}</label>;
}
function Suggest({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-surface px-2 py-0.5 text-[11px] text-accent hover:bg-accent-soft">
      <Check size={10} /> {label}
    </button>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">{title}</span>
        {count != null && <span className="text-[11px] tabular-nums text-ink-4">{count}</span>}
      </div>
      {children}
    </div>
  );
}

function CandidateRow({ c, onOpen }: { c: JobCandidate; onOpen: () => void }) {
  const display = c.ai_name || c.full_name || c.email;
  const company = c.ai_company || c.suggested_account;
  return (
    <button type="button" onClick={onOpen}
      className="flex w-full items-center gap-2 border-t border-border-strong px-3 py-2 text-left hover:bg-surface-2/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] text-ink">{display}</span>
          {c.enriched && <Sparkles size={11} className="shrink-0 text-accent" />}
          {c.is_employer_contact === false && <span className="shrink-0 text-[10px] text-ink-4">· not employer</span>}
        </div>
        <div className="truncate text-[11px] text-ink-4">
          {c.email} · {c.email_count} email{c.email_count === 1 ? "" : "s"}{c.last_subject ? ` · ${c.last_subject}` : ""}
        </div>
      </div>
      {(c.dup_count ?? 0) > 0 && <Tag variant="amber">likely match</Tag>}
      {company && <Tag variant="accent">{company}</Tag>}
      <ChevronRight size={14} className="shrink-0 text-ink-4" />
    </button>
  );
}

export function CandidatesZone() {
  const { data: cands = [], isLoading } = useCandidates();
  const [openId, setOpenId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? cands : cands.slice(0, 20);
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
              People we emailed, enriched by AI. Open to confirm the match, then add or dismiss.
            </div>
            {shown.map((c) => <CandidateRow key={c.contact_id} c={c} onOpen={() => setOpenId(c.contact_id)} />)}
            {cands.length > shown.length && (
              <button type="button" onClick={() => setShowAll(true)}
                className="border-t border-border-strong px-3 py-2 text-[12px] text-accent hover:bg-surface-2/50">Show all {cands.length}</button>
            )}
          </>
        )}
      </div>
      <CandidateDrawer contactId={openId} onClose={() => setOpenId(null)} />
    </Section>
  );
}
