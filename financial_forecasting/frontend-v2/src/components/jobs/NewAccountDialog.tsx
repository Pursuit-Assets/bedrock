import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, Building2, Link2, Plus, X } from "lucide-react";

import { jobsAccountPath } from "@/components/jobs/jobsEntity";
import { useCreateJobsAccount, useResolveAccount } from "@/services/jobs";

/**
 * Create a new account — but never blindly. As the name is typed we check both
 * our own pipeline and Salesforce (live). If it already exists you pick it
 * (open the local one, or create-and-link to the SF one) instead of minting a
 * duplicate; only a truly net-new name creates a fresh local account.
 */
export function NewAccountDialog({ onClose, initialName = "", onPicked }: {
  onClose: () => void;
  /** Seed the name field (e.g. from a company typeahead). */
  initialName?: string;
  /** When provided, selecting/creating returns the account to the caller
   *  instead of navigating to it — used when picking a company mid-form. */
  onPicked?: (a: { account_key: string; display: string }) => void;
}) {
  const nav = useNavigate();
  const [name, setName] = useState(initialName);
  const [debounced, setDebounced] = useState(initialName);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(name), 250);
    return () => clearTimeout(t);
  }, [name]);

  const { data, isFetching } = useResolveAccount(debounced);
  const create = useCreateJobsAccount();

  const local = data?.local ?? [];
  const sf = data?.salesforce ?? [];
  const norm = name.trim().toLowerCase();
  const exactLocal = local.find((l) => l.account_key === norm || (l.display ?? "").trim().toLowerCase() === norm);

  const pick = (a: { account_key: string; display: string }) => {
    if (onPicked) onPicked(a); else nav(jobsAccountPath(a.account_key));
    onClose();
  };
  const openLocal = (key: string, display: string) => pick({ account_key: key, display });
  const createAccount = (sfId: string | null) =>
    create.mutate({ name: name.trim(), sf_account_id: sfId }, {
      onSuccess: (r) => pick(r),
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Building2 size={16} className="text-accent" />New account</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <label className="text-[12px] font-medium text-ink-2">Company name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. JPMorgan Chase"
                   className="mt-1 w-full rounded border border-border-strong bg-surface px-3 py-2 text-[14px] text-ink outline-none focus:border-accent" />
          </label>

          {norm.length >= 2 && (
            <div className="flex flex-col gap-3">
              {local.length > 0 && (
                <div>
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">Already in the pipeline — open it, don't duplicate</div>
                  {local.slice(0, 5).map((l) => (
                    <button key={l.account_key} onClick={() => openLocal(l.account_key, l.display)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2">
                      <Building2 size={13} className="shrink-0 text-ink-4" />
                      <span className="flex-1 truncate text-[13px] text-ink">{l.display}</span>
                      <span className="shrink-0 text-[11px] text-ink-4">{l.record_count} record{l.record_count === 1 ? "" : "s"}</span>
                    </button>
                  ))}
                </div>
              )}
              {sf.length > 0 && (
                <div>
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-4">In Salesforce — create locally &amp; link (no new SF account)</div>
                  {sf.slice(0, 5).map((a) => (
                    <button key={a.id} disabled={create.isPending} onClick={() => createAccount(a.id)}
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50">
                      <Link2 size={13} className="shrink-0 text-sky-600" />
                      <span className="flex-1 truncate text-[13px] text-ink">{a.name}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-ink-4">{a.created}</span>
                    </button>
                  ))}
                </div>
              )}
              {isFetching && <div className="text-[11px] text-ink-4">Checking Salesforce…</div>}
              {exactLocal ? (
                <div className="flex items-center gap-1.5 text-[11.5px] text-amber-600"><AlertCircle size={13} />An account with this exact name already exists — open it above.</div>
              ) : (
                <button disabled={create.isPending || !name.trim()} onClick={() => createAccount(null)}
                        className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-accent bg-accent-soft px-3 py-2 text-[13px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50">
                  <Plus size={14} />Create “{name.trim()}” as a new local account{sf.length > 0 ? " anyway" : ""}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
