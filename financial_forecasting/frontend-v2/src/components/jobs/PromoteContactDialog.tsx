import { useEffect, useState } from "react";
import { Loader2, X, Building2, UserCheck, Plus, ArrowRight, CheckCircle2 } from "lucide-react";

import {
  useContactSfStatus,
  usePromoteContact,
  useSearchSfAccounts,
  useSearchSfContacts,
  type SfAccountRef,
  type SfContactRef,
} from "@/services/jobsSf";

type Step = "dedup" | "account" | "confirm";
type AcctChoice = { mode: "link" | "create" | "none"; sf_account_id?: string; name?: string; label?: string };

/**
 * Promote a jobs contact into Salesforce as ONE shared record.
 * dedup (link existing vs create) → account cascade → confirm + write.
 */
export function PromoteContactDialog({
  contactId,
  contactName,
  onClose,
}: {
  contactId: number;
  contactName: string;
  onClose: () => void;
}) {
  const status = useContactSfStatus(contactId);
  const searchContacts = useSearchSfContacts();
  const searchAccounts = useSearchSfAccounts();
  const promote = usePromoteContact();

  const [step, setStep] = useState<Step>("dedup");
  const [acct, setAcct] = useState<AcctChoice>({ mode: "none" });
  const [acctQuery, setAcctQuery] = useState("");
  const [acctResults, setAcctResults] = useState<SfAccountRef[] | null>(null);

  const proposed = status.data?.proposed;
  const company = status.data?.company ?? "";

  // kick off the dedup search once we know the contact's email/name/company
  useEffect(() => {
    if (!status.data || searchContacts.data || searchContacts.isPending) return;
    searchContacts.mutate({
      email: status.data.proposed.Email ?? undefined,
      name: contactName,
      company: company || undefined,
    });
  }, [status.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates: SfContactRef[] = searchContacts.data?.candidates ?? [];

  function goCreate() {
    setAcct({ mode: company ? "create" : "none", name: company || undefined, label: company || undefined });
    setAcctQuery(company);
    setStep("account");
  }

  function linkExisting(c: SfContactRef) {
    // linking adopts the existing contact's account
    promote.mutate(
      { contact_id: contactId, mode: "link", sf_contact_id: c.id, account: { mode: "none" } },
      { onSuccess: onClose },
    );
  }

  function runAccountSearch() {
    if (!acctQuery.trim()) return;
    searchAccounts.mutate(acctQuery.trim(), { onSuccess: (r) => setAcctResults(r) });
  }

  function doCreate() {
    promote.mutate(
      {
        contact_id: contactId,
        mode: "create",
        account: acct.mode === "link"
          ? { mode: "link", sf_account_id: acct.sf_account_id }
          : acct.mode === "create"
            ? { mode: "create", name: acct.name }
            : { mode: "none" },
      },
      { onSuccess: onClose },
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Add to Salesforce</h2>
            <p className="text-[11.5px] text-ink-4">{contactName}{company ? ` · ${company}` : ""}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {status.isLoading ? (
            <Centered><Loader2 size={16} className="animate-spin" /> Loading…</Centered>
          ) : step === "dedup" ? (
            <DedupStep
              loading={searchContacts.isPending}
              error={searchContacts.isError}
              exactEmail={searchContacts.data?.exact_email_match ?? false}
              candidates={candidates}
              onLink={linkExisting}
              onCreate={goCreate}
              linking={promote.isPending}
            />
          ) : step === "account" ? (
            <AccountStep
              company={company}
              acct={acct}
              setAcct={setAcct}
              query={acctQuery}
              setQuery={setAcctQuery}
              results={acctResults}
              searching={searchAccounts.isPending}
              onSearch={runAccountSearch}
              onBack={() => setStep("dedup")}
              onContinue={() => setStep("confirm")}
            />
          ) : (
            <ConfirmStep proposed={proposed} acct={acct} />
          )}
        </div>

        {step === "confirm" && (
          <div className="flex items-center justify-between gap-3 border-t border-border-strong px-5 py-3">
            <button type="button" onClick={() => setStep("account")} className="text-[12.5px] text-ink-3 hover:text-ink">Back</button>
            <button
              type="button"
              onClick={doCreate}
              disabled={promote.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {promote.isPending ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
              Create in Salesforce
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DedupStep({ loading, error, exactEmail, candidates, onLink, onCreate, linking }: {
  loading: boolean; error: boolean; exactEmail: boolean; candidates: SfContactRef[];
  onLink: (c: SfContactRef) => void; onCreate: () => void; linking: boolean;
}) {
  if (loading) return <Centered><Loader2 size={16} className="animate-spin" /> Searching Salesforce…</Centered>;
  if (error) return <p className="text-[12.5px] text-red">Couldn't search Salesforce — is your SF session connected?</p>;
  return (
    <div className="flex flex-col gap-3">
      {candidates.length > 0 ? (
        <>
          <p className="text-[12.5px] text-ink-2">
            {exactEmail ? "A contact with this email already exists in Salesforce." : "Possible matches already in Salesforce — link instead of creating a duplicate."}
          </p>
          <div className="flex flex-col gap-1.5">
            {candidates.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-border-strong px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{c.name}</div>
                  <div className="truncate text-[11.5px] text-ink-4">{[c.email, c.account_name].filter(Boolean).join(" · ") || "—"}</div>
                </div>
                <button type="button" disabled={linking} onClick={() => onLink(c)} className="ml-3 inline-flex shrink-0 items-center gap-1 rounded border border-border-strong px-2.5 py-1 text-[11.5px] font-medium text-ink hover:border-accent hover:text-accent disabled:opacity-50">
                  <UserCheck size={12} /> Link
                </button>
              </div>
            ))}
          </div>
          <div className="pt-1">
            <button type="button" onClick={onCreate} className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
              None of these — create a new contact <ArrowRight size={12} />
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-ink-2">No existing Salesforce contact found. Create a new one.</p>
          <button type="button" onClick={onCreate} className="inline-flex w-fit items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white hover:opacity-90">
            <Plus size={13} /> Continue
          </button>
        </div>
      )}
    </div>
  );
}

function AccountStep({ company, acct, setAcct, query, setQuery, results, searching, onSearch, onBack, onContinue }: {
  company: string; acct: AcctChoice; setAcct: (a: AcctChoice) => void;
  query: string; setQuery: (s: string) => void; results: SfAccountRef[] | null;
  searching: boolean; onSearch: () => void; onBack: () => void; onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-ink-2">
        <Building2 size={13} className="mr-1 inline" />
        A contact must belong to a Salesforce account.
      </p>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onSearch(); } }}
          placeholder="Search Salesforce accounts…"
          className="flex-1 rounded-md border border-border-strong bg-surface px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
        />
        <button type="button" onClick={onSearch} disabled={searching} className="rounded-md border border-border-strong px-3 text-[12.5px] text-ink hover:border-accent disabled:opacity-50">
          {searching ? <Loader2 size={13} className="animate-spin" /> : "Search"}
        </button>
      </div>

      {results && results.length > 0 && (
        <div className="flex flex-col gap-1">
          {results.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAcct({ mode: "link", sf_account_id: a.id, label: a.name ?? undefined })}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left ${acct.mode === "link" && acct.sf_account_id === a.id ? "border-accent bg-accent-soft" : "border-border-strong hover:border-accent"}`}
            >
              <span className="truncate text-[12.5px] text-ink">{a.name}</span>
              <span className="text-[11px] text-ink-4">{[a.type, a.city].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}
      {results && results.length === 0 && (
        <p className="text-[12px] text-ink-4">No matching accounts.</p>
      )}

      <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${acct.mode === "create" ? "border-accent bg-accent-soft" : "border-border-strong"}`}>
        <input type="radio" checked={acct.mode === "create"} onChange={() => setAcct({ mode: "create", name: company || query })} />
        <span className="text-[12.5px] text-ink">Create new account</span>
        {acct.mode === "create" && (
          <input
            value={acct.name ?? ""}
            onChange={(e) => setAcct({ mode: "create", name: e.target.value })}
            placeholder="Account name"
            className="ml-auto w-44 rounded border border-border-strong bg-surface px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
          />
        )}
      </label>

      <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${acct.mode === "none" ? "border-accent bg-accent-soft" : "border-border-strong"}`}>
        <input type="radio" checked={acct.mode === "none"} onChange={() => setAcct({ mode: "none" })} />
        <span className="text-[12.5px] text-ink">No account for now</span>
      </label>

      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onBack} className="text-[12.5px] text-ink-3 hover:text-ink">Back</button>
        <button
          type="button"
          onClick={onContinue}
          disabled={acct.mode === "link" && !acct.sf_account_id}
          className="inline-flex items-center gap-1 rounded-lg bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
        >
          Continue <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

function ConfirmStep({ proposed, acct }: { proposed?: ContactSfStatusProposed; acct: AcctChoice }) {
  const rows: [string, string | null | undefined][] = [
    ["First name", proposed?.FirstName],
    ["Last name", proposed?.LastName],
    ["Email", proposed?.Email],
    ["Title", proposed?.Title],
    ["LinkedIn", proposed?.LinkedIn_URL__c],
  ];
  const acctLabel = acct.mode === "link" ? `Link: ${acct.label ?? acct.sf_account_id}`
    : acct.mode === "create" ? `Create: ${acct.name || "—"}`
      : "No account";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12.5px] text-ink-2">This will create a new Salesforce contact:</p>
      <div className="rounded-lg border border-border-strong">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between border-b border-border-strong/60 px-3 py-1.5 last:border-0">
            <span className="text-[11.5px] uppercase tracking-wide text-ink-4">{k}</span>
            <span className="max-w-[60%] truncate text-[12.5px] text-ink">{v || "—"}</span>
          </div>
        ))}
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[11.5px] uppercase tracking-wide text-ink-4">Account</span>
          <span className="max-w-[60%] truncate text-[12.5px] text-ink">{acctLabel}</span>
        </div>
      </div>
    </div>
  );
}

type ContactSfStatusProposed = NonNullable<ReturnType<typeof useContactSfStatus>["data"]>["proposed"];

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-ink-3">{children}</div>;
}
