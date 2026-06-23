import { useEffect, useState } from "react";
import { Loader2, X, Building2, Link2, Plus, CheckCircle2 } from "lucide-react";

import { usePromoteAccount, useSearchSfAccounts, type SfAccountRef } from "@/services/jobsSf";

/**
 * Promote a jobs account into Salesforce as one shared record:
 * dedup search → link an existing SF account or create a new one → link-back.
 */
export function PromoteAccountDialog({
  accountKey,
  displayName,
  onClose,
}: {
  accountKey: string;
  displayName: string;
  onClose: () => void;
}) {
  const search = useSearchSfAccounts();
  const promote = usePromoteAccount();
  const [results, setResults] = useState<SfAccountRef[] | null>(null);
  const [picked, setPicked] = useState<SfAccountRef | null>(null);

  useEffect(() => {
    if (displayName.trim()) search.mutate(displayName.trim(), { onSuccess: setResults });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const link = () =>
    picked && promote.mutate(
      { account_key: accountKey, display_name: displayName, mode: "link", sf_account_id: picked.id },
      { onSuccess: onClose },
    );
  const create = () =>
    promote.mutate(
      { account_key: accountKey, display_name: displayName, mode: "create" },
      { onSuccess: onClose },
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Add account to Salesforce</h2>
            <p className="text-[11.5px] text-ink-4">{displayName}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {search.isPending ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-ink-3"><Loader2 size={16} className="animate-spin" /> Searching Salesforce…</div>
          ) : search.isError ? (
            <p className="text-[12.5px] text-red">Couldn't search Salesforce — is your SF session connected?</p>
          ) : (
            <div className="flex flex-col gap-3">
              {results && results.length > 0 ? (
                <>
                  <p className="text-[12.5px] text-ink-2"><Building2 size={13} className="mr-1 inline" />Possible matches in Salesforce — link instead of creating a duplicate.</p>
                  <div className="flex flex-col gap-1">
                    {results.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setPicked(a)}
                        className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left ${picked?.id === a.id ? "border-accent bg-accent-soft" : "border-border-strong hover:border-accent"}`}
                      >
                        <span className="truncate text-[12.5px] text-ink">{a.name}</span>
                        <span className="text-[11px] text-ink-4">{[a.type, a.city].filter(Boolean).join(" · ")}</span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-[12.5px] text-ink-2">No matching Salesforce account found.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-strong px-5 py-3">
          <button type="button" onClick={create} disabled={promote.isPending} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink disabled:opacity-50">
            <Plus size={13} /> Create new "{displayName}"
          </button>
          <button type="button" onClick={link} disabled={!picked || promote.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40">
            {promote.isPending ? <Loader2 size={13} className="animate-spin" /> : picked ? <Link2 size={13} /> : <CheckCircle2 size={13} />}
            {picked ? "Link selected" : "Pick or create"}
          </button>
        </div>
      </div>
    </div>
  );
}
