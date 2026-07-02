/**
 * Request an intro to a contact through the staff member connected to them.
 * Mirrors the Sputnik intro-request semantics (ask + context + status
 * lifecycle); requests land in the connector's Intro Requests inbox on the
 * jobs home page.
 */
import { useState } from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/services/auth";
import { useContactConnectors, useCreateIntroRequest } from "@/services/jobs";

const ASK_OPTIONS = [
  { value: "hiring_intro", label: "Hiring intro" },
  { value: "industry_advice", label: "Industry advice" },
  { value: "job_referral", label: "Job referral" },
];

export function RequestIntroDialog({
  contactId,
  contactName,
  onClose,
}: {
  contactId: number;
  contactName: string;
  onClose: () => void;
}) {
  const { data: me } = useCurrentUser();
  const { data: allConnectors = [], isLoading } = useContactConnectors(contactId);
  // You can't ask yourself for an intro — offer only OTHER connected staff.
  const connectors = allConnectors.filter((s) => s.email?.toLowerCase() !== me?.email?.toLowerCase());
  const create = useCreateIntroRequest();
  const [staffId, setStaffId] = useState<number | null>(null);
  const [ask, setAsk] = useState("hiring_intro");
  const [context, setContext] = useState("");

  const submit = async () => {
    if (staffId == null) return;
    await create.mutateAsync({
      contact_id: contactId,
      connector_staff_id: staffId,
      specific_ask: ask,
      context: context.trim() || undefined,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Request an intro</h2>
            <p className="text-[11.5px] text-ink-4">{contactName}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">Via</div>
            {isLoading ? (
              <div className="text-[12px] text-ink-4">Loading connections…</div>
            ) : connectors.length === 0 ? (
              <div className="text-[12px] text-ink-4">
                {allConnectors.length > 0
                  ? "You're the only staff member connected to this contact — no one to request an intro from."
                  : "No mapped staff are connected to this contact yet."}
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {connectors.map((s) => (
                  <label key={s.staff_user_id}
                    className={cn("flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]",
                      staffId === s.staff_user_id ? "border-accent bg-accent-soft" : "border-border-strong hover:border-accent/50")}>
                    <input type="radio" name="connector" checked={staffId === s.staff_user_id}
                      onChange={() => setStaffId(s.staff_user_id)} className="accent-accent" />
                    <span className="font-medium text-ink">{s.display_name || s.email}</span>
                    {s.connected_date && <span className="text-[11px] text-ink-4">connected {s.connected_date.slice(0, 4)}</span>}
                    {s.has_pending_request && <span className="rounded-full bg-amber-soft px-1.5 py-0.5 text-[10.5px] font-medium text-amber">request pending</span>}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">Ask</div>
            <div className="flex flex-wrap gap-1.5">
              {ASK_OPTIONS.map((o) => (
                <button key={o.value} type="button" onClick={() => setAsk(o.value)}
                  className={cn("rounded-full border px-3 py-1 text-[11px] font-medium",
                    ask === o.value ? "border-accent bg-accent text-white" : "border-border-strong text-ink-3 hover:border-accent hover:text-accent")}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-4">Context</div>
            <textarea rows={3} value={context} onChange={(e) => setContext(e.target.value)}
              placeholder="Why this contact, what's the opportunity…"
              className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border-strong px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg border border-border-strong px-3 py-1.5 text-[12px] text-ink-2 hover:bg-surface-2">Cancel</button>
          <button type="button" disabled={staffId == null || create.isPending} onClick={submit}
            className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50">
            {create.isPending ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>
    </div>
  );
}
