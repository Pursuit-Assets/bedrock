import { Fragment, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { Drawer } from "@/components/ui/Drawer";
import {
  useMetricDrill,
  useUpdateOpportunity,
  useUpdateContact,
  STAGES_ORDERED,
  STAGE_LABELS,
  DEAL_TYPE_LABELS,
  type JobStage,
  type DealType,
  type MetricDrill,
} from "@/services/jobs";
import { useQueryClient } from "@tanstack/react-query";

// Pretty-print known coded values; pass everything else through.
function formatCell(colKey: string, value: string | null): string {
  if (value == null || value === "") return "—";
  if (colKey === "stage" && value in STAGE_LABELS) {
    return STAGE_LABELS[value as JobStage];
  }
  if (colKey === "deal_type" && value in DEAL_TYPE_LABELS) {
    return DEAL_TYPE_LABELS[value as DealType];
  }
  // Format any date/datetime column (named *_date / *_touch / when, or an
  // ISO-shaped value) to a readable "Jun 10, 2026" — never show raw ISO.
  const looksDateCol = /(_date|_touch|^when$|^date$)/.test(colKey);
  const looksIso = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value);
  if (looksDateCol || looksIso) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    }
  }
  if (colKey === "type") return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

// Contact-stage options (value/label).
const CONTACT_STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "initial_outreach", label: "Outreach" },
  { value: "lead", label: "Lead" },
  { value: "on_hold", label: "On Hold" },
];

const selectClass =
  "border border-border-strong rounded px-1.5 py-0.5 text-[12px] bg-surface " +
  "cursor-pointer transition-colors hover:border-ink-3 hover:bg-surface-2 " +
  "focus:outline-none focus:ring-1 focus:ring-border-strong";

type EditableSelect = {
  value: string;
  options: { value: string; label: string }[];
  onChange: (newValue: string) => void;
};

export function MetricDrawer({
  metricKey,
  onClose,
}: {
  metricKey: string | null;
  onClose: () => void;
}) {
  const { data, isLoading } = useMetricDrill(metricKey);
  const updateOpportunity = useUpdateOpportunity();
  const updateContact = useUpdateContact();
  const queryClient = useQueryClient();
  const open = metricKey !== null;
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Decide whether a given (entity, column) is an editable dropdown.
  // Returns the select config, or null for read-only text.
  function getEditableSelect(
    entity: MetricDrill["entity"],
    colKey: string,
    row: Record<string, string | null>,
  ): EditableSelect | null {
    const id = row.id;
    if (id == null) return null;

    if (entity === "deal" && colKey === "stage") {
      return {
        value: row[colKey] ?? "",
        options: STAGES_ORDERED.map((s) => ({ value: s, label: STAGE_LABELS[s] })),
        onChange: async (newValue) => {
          await updateOpportunity.mutateAsync({ id, stage: newValue as JobStage });
          queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
      };
    }

    if (entity === "deal" && colKey === "deal_type") {
      return {
        value: row[colKey] ?? "",
        options: (Object.keys(DEAL_TYPE_LABELS) as DealType[]).map((t) => ({
          value: t,
          label: DEAL_TYPE_LABELS[t],
        })),
        onChange: async (newValue) => {
          await updateOpportunity.mutateAsync({ id, deal_type: newValue as DealType });
          queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
      };
    }

    if (entity === "contact" && colKey === "contact_stage") {
      return {
        value: row[colKey] ?? "",
        options: CONTACT_STAGE_OPTIONS,
        onChange: async (newValue) => {
          await updateContact.mutateAsync({ id: Number(id), contact_stage: newValue });
          queryClient.invalidateQueries({ queryKey: ["jobs"] });
        },
      };
    }

    return null;
  }

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
        ) : data.entity === "placement" ? (
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                <th className="w-7 px-2 py-2" />
                {data.columns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-left font-semibold">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => {
                const isExpanded = expandedRow === i;
                const children = row._children ?? [];
                return (
                  <Fragment key={i}>
                    <tr
                      className="cursor-pointer border-t border-border-strong hover:bg-surface-2/50"
                      onClick={() => setExpandedRow((cur) => (cur === i ? null : i))}
                    >
                      <td className="px-2 py-2 text-ink-3">
                        {isExpanded ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </td>
                      {data.columns.map((c, ci) => (
                        <td
                          key={c.key}
                          className={
                            ci === 0
                              ? "px-3 py-2 font-medium text-ink"
                              : "px-3 py-2 text-ink-2"
                          }
                        >
                          {formatCell(c.key, row[c.key])}
                        </td>
                      ))}
                    </tr>
                    {isExpanded ? (
                      <tr className="border-t border-border-strong bg-surface-2/40">
                        <td colSpan={data.columns.length + 1} className="px-3 py-2 pl-10">
                          {children.length === 0 ? (
                            <div className="py-2 text-[11.5px] text-ink-3">
                              No placements.
                            </div>
                          ) : (
                            <table className="w-full text-[11.5px]">
                              <thead className="text-[9.5px] uppercase tracking-wider text-ink-3">
                                <tr>
                                  {(data.child_columns ?? []).map((cc) => (
                                    <th
                                      key={cc.key}
                                      className="px-2 py-1.5 text-left font-semibold"
                                    >
                                      {cc.label}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {children.map((child, ci) => (
                                  <tr
                                    key={ci}
                                    className="border-t border-border-strong/60"
                                  >
                                    {(data.child_columns ?? []).map((cc) => (
                                      <td key={cc.key} className="px-2 py-1.5 text-ink-2">
                                        {formatCell(cc.key, child[cc.key])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
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
                  {data.columns.map((c, ci) => {
                    const editable = getEditableSelect(data.entity, c.key, row);
                    return (
                      <td
                        key={c.key}
                        className={ci === 0 ? "px-3 py-2 font-medium text-ink" : "px-3 py-2 text-ink-2"}
                      >
                        {editable ? (
                          <select
                            className={selectClass}
                            value={editable.value}
                            onChange={(e) => editable.onChange(e.target.value)}
                          >
                            {editable.value === "" && (
                              <option value="" disabled>
                                —
                              </option>
                            )}
                            {editable.options.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          formatCell(c.key, row[c.key])
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Drawer>
  );
}
