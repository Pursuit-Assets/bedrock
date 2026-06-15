import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useOppBuilderActivity } from "@/services/jobsOpps2";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(new Date(iso), "MMM d, yyyy");
  } catch {
    return "—";
  }
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

export function OppBuilderActivity({ oppId }: { oppId: string }) {
  const activityQ = useOppBuilderActivity(oppId);
  const data = activityQ.data;
  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10.5px] uppercase tracking-wider text-ink-4">Builder Activity</span>

      {activityQ.isLoading ? (
        <span className="text-[12px] text-ink-4">Loading…</span>
      ) : (
        <>
          {summary && (
            <div className="flex flex-wrap items-center gap-1.5">
              <SummaryChip label="Applied" count={summary.applied} className="bg-blue-50 text-blue-700" />
              <SummaryChip label="Interview" count={summary.interview} className="bg-amber-50 text-amber-700" />
              <SummaryChip label="Accepted" count={summary.accepted} className="bg-green-100 text-green-800" />
            </div>
          )}

          {rows.length === 0 ? (
            <span className="text-[12px] text-ink-4">No builder applications for this opportunity.</span>
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
                    {r.stage ? (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2">
                        {r.stage}
                      </span>
                    ) : null}
                    <span className="font-mono text-[10.5px] text-ink-4">{fmtDate(r.date_applied)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
