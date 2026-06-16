import { useState } from "react";
import { format } from "date-fns";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBuilders, type Builder } from "@/services/jobs";
import {
  useOppBuilderActivity,
  useCreateBuilderActivity,
  useUpdateBuilderActivity,
  APP_STAGE_OPTIONS,
  type AppStage,
} from "@/services/jobsOpps2";

// Application stages (public.job_applications) → readable labels.
const APP_STAGE_LABELS: Record<string, string> = {
  applied: "Applied",
  interview: "Interviewing",
  accepted: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

function Spinner() {
  return (
    <svg className="h-3 w-3 animate-spin text-ink-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function SummaryChip({ label, count, className }: { label: string; count: number; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none",
        className,
      )}
    >
      <span className="font-mono tabular-nums">{count}</span>
      {label}
    </span>
  );
}

// ── Log-builder inline form ────────────────────────────────────────────────────

function LogBuilderForm({ oppId }: { oppId: string }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [builder, setBuilder] = useState<{ user_id: number; name: string } | null>(null);
  const [roleTitle, setRoleTitle] = useState("");
  const [stage, setStage] = useState<AppStage>("applied");

  const buildersQ = useBuilders(search || undefined);
  const builders = buildersQ.data ?? [];
  const create = useCreateBuilderActivity(oppId);

  function reset() {
    setBuilder(null);
    setSearch("");
    setRoleTitle("");
    setStage("applied");
    setOpen(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!builder) return;
    create.mutate(
      {
        user_id: builder.user_id,
        builder_name: builder.name,
        role_title: roleTitle.trim() || undefined,
        stage,
      },
      { onSuccess: () => reset() },
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start text-[12px] text-accent hover:underline"
      >
        + Log builder application
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-border-strong p-2.5">
      {/* Builder picker */}
      {builder ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[11.5px] text-ink-2">
          {builder.name}
          <button
            type="button"
            onClick={() => { setBuilder(null); setSearch(""); }}
            className="ml-0.5 text-ink-4 hover:text-red-500 transition-colors"
            title="Clear builder"
          >
            <X size={11} />
          </button>
        </span>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={search}
            onFocus={() => setPickerOpen(true)}
            onBlur={() => setTimeout(() => setPickerOpen(false), 150)}
            onChange={(e) => { setSearch(e.target.value); setPickerOpen(true); }}
            placeholder="Search builders…"
            autoFocus
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          {pickerOpen && builders.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-[140px] w-full overflow-y-auto rounded border border-border-strong bg-surface shadow-md">
              {builders.slice(0, 12).map((b: Builder) => (
                <li key={b.user_id}>
                  <button
                    type="button"
                    onMouseDown={() => {
                      setBuilder({ user_id: b.user_id, name: b.name });
                      setPickerOpen(false);
                      setSearch("");
                    }}
                    className="w-full px-3 py-1.5 text-left text-[11.5px] text-ink hover:bg-surface-2"
                  >
                    <span className="font-medium">{b.name}</span>
                    <span className="ml-1.5 text-ink-3">{b.email}</span>
                    {b.cohort ? <span className="ml-1.5 text-ink-4">· {b.cohort}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Role title</span>
          <input
            type="text"
            value={roleTitle}
            onChange={(e) => setRoleTitle(e.target.value)}
            placeholder="Software Engineer"
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-ink-4">Status</span>
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value as AppStage)}
            className="w-full rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            {APP_STAGE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!builder || create.isPending}
          className="flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {create.isPending ? <Spinner /> : <Plus size={12} />}
          Log
        </button>
        <button type="button" onClick={reset} className="text-[11.5px] text-ink-3 hover:text-ink-2">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Inline stage editor on a row ────────────────────────────────────────────────

function RowStageSelect({
  oppId,
  appId,
  stage,
}: {
  oppId: string;
  appId: number;
  stage: string | null;
}) {
  const update = useUpdateBuilderActivity(oppId);
  return (
    <select
      value={stage ?? "applied"}
      onChange={(e) => update.mutate({ appId, stage: e.target.value as AppStage })}
      disabled={update.isPending}
      className="rounded-full border border-border-strong bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2 focus:outline-none focus:ring-1 focus:ring-accent/40"
      title="Update status"
    >
      {APP_STAGE_OPTIONS.map((s) => (
        <option key={s.value} value={s.value}>{APP_STAGE_LABELS[s.value]}</option>
      ))}
    </select>
  );
}

export function OppBuilderActivity({ oppId }: { oppId: string }) {
  const activityQ = useOppBuilderActivity(oppId);
  const data = activityQ.data;
  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">Builder Applications</span>

      {activityQ.isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : (
        <>
          {summary && (rows.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <SummaryChip label="Applied" count={summary.applied} className="bg-blue-50 text-blue-700" />
              <SummaryChip label="Interview" count={summary.interview} className="bg-amber-50 text-amber-700" />
              <SummaryChip label="Accepted" count={summary.accepted} className="bg-green-100 text-green-800" />
            </div>
          )}

          {rows.length === 0 ? (
            <span className="text-[12px] text-ink-4">No builder applications logged for this opportunity yet.</span>
          ) : (
            <ul className="flex flex-col divide-y divide-border-strong rounded-md border border-border-strong">
              {rows.map((r) => (
                <li
                  key={r.job_application_id}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[12.5px] font-medium text-ink">{r.builder}</span>
                    <span className="truncate text-[11px] text-ink-3">
                      {[r.role_title, r.company_name].filter(Boolean).join(" @ ") || "—"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <RowStageSelect oppId={oppId} appId={r.job_application_id} stage={r.stage} />
                    <span className="font-mono text-[10.5px] text-ink-4">{fmtDate(r.date_applied)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <LogBuilderForm oppId={oppId} />
        </>
      )}
    </div>
  );
}
