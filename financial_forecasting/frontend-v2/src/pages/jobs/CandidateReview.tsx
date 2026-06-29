/**
 * AI-first candidate review (human in the loop). The Home "Candidates to review"
 * queue + a detail drawer that: auto-enriches with Claude (name/title/company),
 * suggests an account linkage (exact domain → fuzzy → propose-new), shows the
 * actual emails, and lets the reviewer accept/edit then promote or dismiss.
 */
import { useEffect, useMemo, useState } from "react";
import { Sparkles, Building2, Mail, UserPlus, X, ChevronDown, ChevronRight, Loader2, Check } from "lucide-react";

import { Drawer } from "@/components/ui/Drawer";
import { Tag } from "@/components/ui/Tag";
import {
  useCandidates, useCandidateDetail, useEnrichCandidate,
  usePromoteCandidate, useDismissCandidate, useJobsAccounts,
  type JobCandidate, type CandidateEnrichment,
} from "@/services/jobs";

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

const confTone = (c?: string) => (c === "high" ? "green" : c === "medium" ? "amber" : "default") as
  "green" | "amber" | "default";

// ── one email, expandable ─────────────────────────────────────────────────────
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

// ── detail drawer ─────────────────────────────────────────────────────────────
function CandidateDrawer({ contactId, onClose }: { contactId: number | null; onClose: () => void }) {
  const { data, isLoading } = useCandidateDetail(contactId);
  const enrich = useEnrichCandidate();
  const promote = usePromoteCandidate();
  const dismiss = useDismissCandidate();
  const { data: accounts = [] } = useJobsAccounts("all");

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [ai, setAi] = useState<CandidateEnrichment | null>(null);

  // Seed fields from the contact, then auto-run AI enrichment once per candidate.
  useEffect(() => {
    if (!data) return;
    setName(data.contact.full_name ?? "");
    setTitle(data.contact.current_title ?? "");
    setCompany(data.contact.current_company ?? data.suggested_account?.account_name ?? "");
    setAi(null);
    if (contactId != null) {
      enrich.mutate(contactId, {
        onSuccess: (res) => {
          setAi(res);
          if (!res.error) {
            setName((n) => n || res.full_name || "");
            setTitle((t) => t || res.title || "");
            setCompany((c) => c || res.company || "");
          }
        },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, data?.contact.contact_id]);

  const accountNames = useMemo(() => accounts.map((a) => a.account).sort(), [accounts]);
  const sug = data?.suggested_account;
  const busy = promote.isPending || dismiss.isPending;

  return (
    <Drawer open={contactId != null} onClose={onClose}
      title={data?.contact.full_name || data?.contact.email || "Candidate"}
      subtitle={data?.contact.email} width={680}>
      {isLoading || !data ? (
        <div className="flex items-center gap-2 p-6 text-[13px] text-ink-3"><Loader2 size={15} className="animate-spin" /> Loading…</div>
      ) : (
        <div className="flex flex-col gap-4 p-4">
          {/* AI enrichment */}
          <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-accent-ink">
              <Sparkles size={12} /> AI enrichment
              {enrich.isPending && <Loader2 size={11} className="animate-spin" />}
            </div>
            {enrich.isPending ? (
              <div className="text-[12px] text-ink-3">Reading the emails…</div>
            ) : ai?.error ? (
              <div className="flex items-center justify-between text-[12px] text-ink-3">
                <span>Couldn't enrich ({ai.error}).</span>
                <button type="button" onClick={() => contactId && enrich.mutate(contactId, { onSuccess: setAi })}
                  className="text-accent hover:underline">Retry</button>
              </div>
            ) : ai ? (
              <div className="flex flex-col gap-1.5 text-[12px]">
                <div className="flex flex-wrap items-center gap-2">
                  {ai.is_employer_contact === false && <Tag variant="amber">Not an employer contact</Tag>}
                  <Tag variant={confTone(ai.confidence)}>{ai.confidence} confidence</Tag>
                </div>
                {ai.reasoning && <p className="text-[11.5px] leading-relaxed text-ink-2">{ai.reasoning}</p>}
                {ai.possible_duplicates && ai.possible_duplicates.length > 0 && (
                  <div className="mt-1 rounded border border-amber/40 bg-amber-soft/50 px-2 py-1.5 text-[11.5px] text-ink-2">
                    <span className="font-semibold text-amber">Possible existing contact{ai.possible_duplicates.length > 1 ? "s" : ""}:</span>{" "}
                    {ai.possible_duplicates.map((d) => `${d.full_name}${d.current_company ? ` (${d.current_company})` : ""}`).join(", ")}
                    {" "}— dismiss this candidate if it's a duplicate.
                  </div>
                )}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {ai.full_name && ai.full_name !== name && <Suggest label={`Name: ${ai.full_name}`} onClick={() => setName(ai.full_name!)} />}
                  {ai.title && ai.title !== title && <Suggest label={`Title: ${ai.title}`} onClick={() => setTitle(ai.title!)} />}
                  {ai.company && ai.company !== company && <Suggest label={`Company: ${ai.company}`} onClick={() => setCompany(ai.company!)} />}
                </div>
              </div>
            ) : null}
          </div>

          {/* Editable fields */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Full name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
            <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} /></Field>
            <Field label="Company / account">
              <input value={company} onChange={(e) => setCompany(e.target.value)} list="cand-accounts" className={inputCls} placeholder="Type or pick…" />
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
              : data.emails.map((e) => <EmailItem key={e.id} e={e} />)}
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

// ── Home section ──────────────────────────────────────────────────────────────
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
  return (
    <button type="button" onClick={onOpen}
      className="flex w-full items-center gap-2 border-t border-border-strong px-3 py-2 text-left hover:bg-surface-2/40">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] text-ink">{c.full_name || c.email}</div>
        <div className="truncate text-[11px] text-ink-4">
          {c.full_name ? `${c.email} · ` : ""}{c.email_count} email{c.email_count === 1 ? "" : "s"}
          {c.last_subject ? ` · ${c.last_subject}` : ""}
        </div>
      </div>
      {c.suggested_account && <Tag variant="accent">{c.suggested_account}</Tag>}
      <ChevronRight size={14} className="shrink-0 text-ink-4" />
    </button>
  );
}

export function CandidatesZone() {
  const { data: cands = [], isLoading } = useCandidates();
  const [openId, setOpenId] = useState<number | null>(null);
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
              People we emailed but couldn't auto-identify — open to enrich with AI, confirm, then add or dismiss.
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
