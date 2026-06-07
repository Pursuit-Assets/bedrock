import { Drawer } from "@/components/ui/Drawer";
import { useMetricDrill } from "@/services/jobs";
import { STAGE_LABELS, type JobStage } from "@/services/jobs";

// Pretty-print known coded values; pass everything else through.
function formatCell(colKey: string, value: string | null): string {
  if (value == null || value === "") return "—";
  if (colKey === "stage" && value in STAGE_LABELS) {
    return STAGE_LABELS[value as JobStage];
  }
  if (colKey === "activity_date" || colKey === "date_applied") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  if (colKey === "type") return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

export function MetricDrawer({
  metricKey,
  onClose,
}: {
  metricKey: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useMetricDrill(metricKey);
  const open = metricKey !== null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={data?.title ?? "Details"}
      subtitle={data ? `${data.count} record${data.count === 1 ? "" : "s"}` : undefined}
      width={760}
    >
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-surface-2" />
            ))}
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="py-12 text-center text-[13px] text-ink-3">No records.</div>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                {data.columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-left font-semibold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="border-t border-border-strong hover:bg-surface-2/50">
                  {data.columns.map((c, ci) => (
                    <td
                      key={c.key}
                      className={ci === 0 ? "px-3 py-2 font-medium text-ink" : "px-3 py-2 text-ink-2"}
                    >
                      {formatCell(c.key, row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Drawer>
  );
}
