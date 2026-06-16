import { useState } from "react";
import { X, Plus, Trash2, Check } from "lucide-react";
import { useUpdateOpportunity } from "@/services/jobs";
import { useCreateRole } from "@/services/jobsOpps2";

interface RoleDraft {
  title: string;
  approxSalary: string;
  startDate: string;
}

function emptyDraft(): RoleDraft {
  return { title: "", approxSalary: "", startDate: "" };
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin text-white" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function CommittedRolesModal({
  deal,
  onClose,
}: {
  deal: { id: string; account_name: string };
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<RoleDraft[]>([emptyDraft()]);
  const [saving, setSaving] = useState(false);
  const createRole = useCreateRole();
  const updateOpp = useUpdateOpportunity();

  function set<K extends keyof RoleDraft>(index: number, key: K, value: RoleDraft[K]) {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, [key]: value } : d)));
  }

  function addRow() {
    setDrafts((prev) => [...prev, emptyDraft()]);
  }

  function removeRow(index: number) {
    setDrafts((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const valid = drafts.filter((d) => d.title.trim());
    if (valid.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      for (const d of valid) {
        const salaryNum = d.approxSalary.trim()
          ? Number(d.approxSalary.replace(/[^0-9.]/g, ""))
          : undefined;
        await createRole.mutateAsync({
          oppId: deal.id,
          title: d.title.trim(),
          approx_salary: salaryNum != null && !isNaN(salaryNum) ? salaryNum : undefined,
          start_date: d.startDate || undefined,
        });
      }
      await updateOpp.mutateAsync({ id: deal.id, num_roles: valid.length });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-border-strong bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-strong px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[15px] font-semibold text-ink">Committed to hiring?</h2>
            <span className="text-[12px] text-ink-3">{deal.account_name}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
          <p className="text-[12.5px] text-ink-3">
            Add the roles this company has committed to. You can edit or hire builders into them later.
          </p>

          <div className="flex flex-col gap-3">
            {drafts.map((d, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-md border border-border-strong p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-4">
                    Role {i + 1}
                  </span>
                  {drafts.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      title="Remove role"
                      className="text-ink-4 hover:text-red-500 transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={d.title}
                  onChange={(e) => set(i, "title", e.target.value)}
                  placeholder="Role title"
                  className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] font-medium text-ink-4">Approx Salary</label>
                    <input
                      type="number"
                      value={d.approxSalary}
                      onChange={(e) => set(i, "approxSalary", e.target.value)}
                      placeholder="85000"
                      min={0}
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <label className="text-[10px] font-medium text-ink-4">Start Date</label>
                    <input
                      type="date"
                      value={d.startDate}
                      onChange={(e) => set(i, "startDate", e.target.value)}
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-[12px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1.5 self-start text-[12px] font-medium text-accent hover:underline"
          >
            <Plus size={13} /> Add another role
          </button>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-border-strong pt-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-medium text-ink-3 hover:text-ink transition-colors"
            >
              Skip
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Spinner /> : <Check size={13} />}
              {saving ? "Saving…" : "Save roles"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
