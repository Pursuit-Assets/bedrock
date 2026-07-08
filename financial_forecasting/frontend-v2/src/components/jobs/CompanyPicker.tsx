import { useMemo, useState } from "react";
import { Building2, Plus, X } from "lucide-react";

import { NewAccountDialog } from "@/components/jobs/NewAccountDialog";
import { useJobsAccountNames } from "@/services/jobs";

/**
 * Pick a company from existing accounts, or create a new one through the same
 * account-creation flow (which checks Salesforce + our DB before minting a
 * dupe). Emits the chosen account's display name.
 */
export function CompanyPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const { data: names = [] } = useJobsAccountNames();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? names.filter((n) => n.account.toLowerCase().includes(s)) : names;
    return list.slice(0, 8);
  }, [names, q]);
  const exact = names.some((n) => n.account.trim().toLowerCase() === q.trim().toLowerCase());

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2">
        <Building2 size={13} className="shrink-0 text-ink-4" />
        <span className="flex-1 truncate text-[13px] text-ink">{value}</span>
        <button type="button" onClick={() => onChange("")} className="text-ink-4 hover:text-ink" aria-label="Clear company"><X size={13} /></button>
      </div>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search accounts…"
        className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-1 focus:ring-accent/40"
      />
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-border-strong bg-surface shadow-lg">
          {matches.map((n) => (
            <button type="button" key={n.account_key} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(n.account); setOpen(false); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-surface-2">
              <Building2 size={12} className="shrink-0 text-ink-4" /><span className="truncate">{n.account}</span>
            </button>
          ))}
          {q.trim() && !exact && (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setDialog(true); setOpen(false); }}
                    className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-[13px] font-medium text-accent-ink hover:bg-surface-2">
              <Plus size={13} />Create “{q.trim()}” as a new account…
            </button>
          )}
          {matches.length === 0 && !q.trim() && <div className="px-3 py-2 text-[12px] text-ink-4">Type to search accounts</div>}
        </div>
      )}
      {dialog && (
        <NewAccountDialog initialName={q.trim()} onClose={() => setDialog(false)}
                          onPicked={(a) => { onChange(a.display); setDialog(false); setQ(""); }} />
      )}
    </div>
  );
}
