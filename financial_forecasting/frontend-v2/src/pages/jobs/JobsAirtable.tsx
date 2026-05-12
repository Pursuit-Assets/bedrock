/**
 * Jobs · Airtable section.
 *
 * Surfaces four tables from the Outcomes team's Airtable base
 * (appU97D9wOfq6eidF):
 *   - Companies (employer leads)
 *   - Jobs (postings)
 *   - Emp. Engagements (outreach activity)
 *   - Job Deals (deal stages)
 *
 * Each tab is sortable + searchable. Header carries a "Pre-merge" badge so
 * users know this data is not yet reconciled against Salesforce.
 *
 * Field display is best-effort — Airtable record fields vary in shape
 * (some are arrays of linked-record names, some are select objects with
 * {id, name, color}). The `renderCell` helper flattens everything to a
 * readable string.
 */
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

import { SectionCard } from "@/components/detail";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { sortBy, useSort } from "@/lib/sort";
import {
  useAirtableCompanies,
  useAirtableDeals,
  useAirtableEngagements,
  useAirtableJobs,
  type AirtableResponse,
} from "@/services/airtableJobs";

import { TableToolbar } from "../portfolio/TableToolbar";

type Tab = "companies" | "postings" | "engagements" | "deals";

// Per-tab column definitions. Each column has the Airtable field name and
// the display header. Order in this list is the column order shown.
const COLUMNS: Record<Tab, { field: string; label: string }[]> = {
  companies: [
    { field: "Company Name", label: "Company" },
    { field: "Industry", label: "Industry" },
    { field: "Company Size", label: "Size" },
    { field: "City", label: "City" },
    { field: "State", label: "State" },
    { field: "(old) Outreach Status", label: "Outreach status" },
    { field: "Follow-up Date", label: "Follow-up" },
  ],
  postings: [
    { field: "Job Title", label: "Title" },
    { field: "Company", label: "Company" },
    { field: "Job Type", label: "Type" },
    { field: "Location", label: "Location" },
    { field: "Salary", label: "Salary" },
    { field: "Status", label: "Status" },
    { field: "Application Deadline", label: "Deadline" },
    { field: "Start Date", label: "Start" },
  ],
  engagements: [
    { field: "Outreach Action", label: "Action" },
    { field: "Company", label: "Company" },
    { field: "Outreach Type", label: "Type" },
    { field: "Date of Contact", label: "Date" },
    { field: "Summary", label: "Summary" },
    { field: "Outreach Owner", label: "Owner" },
    { field: "Follow-up Date", label: "Follow-up" },
  ],
  deals: [
    { field: "Deal ID", label: "Deal" },
    { field: "Company", label: "Company" },
    { field: "Deal Co' Contact", label: "Contact" },
    { field: "Deal Stage", label: "Stage" },
    { field: "Deal Type", label: "Type" },
    { field: "Next Step", label: "Next step" },
    { field: "Pursuit Deal Lead", label: "Lead" },
    { field: "Created", label: "Created" },
  ],
};

const TAB_LABELS: Record<Tab, string> = {
  companies: "Companies",
  postings: "Jobs",
  engagements: "Engagements",
  deals: "Job Deals",
};

export function JobsAirtable() {
  const [tab, setTab] = useState<Tab>("companies");
  const [query, setQuery] = useState("");

  const queries = {
    companies: useAirtableCompanies(),
    postings: useAirtableJobs(),
    engagements: useAirtableEngagements(),
    deals: useAirtableDeals(),
  };
  const active = queries[tab];

  return (
    <SectionCard
      title="Builder data (Airtable)"
      storageScope="jobs"
      action={<PreMergeBadge />}
    >
      <div className="border-b border-border-strong px-5 py-2">
        <div
          role="tablist"
          className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface"
        >
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                setTab(t);
                setQuery("");
              }}
              className={cn(
                "border-l border-border-strong px-3 py-1 text-[12px] font-medium first:border-l-0",
                tab === t
                  ? "bg-ink text-surface"
                  : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
              )}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <AirtableTable
        tab={tab}
        result={active.data}
        isLoading={active.isLoading}
        query={query}
        onQueryChange={setQuery}
      />
    </SectionCard>
  );
}

function AirtableTable({
  tab,
  result,
  isLoading,
  query,
  onQueryChange,
}: {
  tab: Tab;
  result: AirtableResponse | undefined;
  isLoading: boolean;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const { sort, toggle } = useSort<string>();
  const columns = COLUMNS[tab];

  const records = result?.data ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? records.filter((r) =>
          columns.some((c) =>
            renderCell(r[c.field]).toLowerCase().includes(q),
          ),
        )
      : records;
    if (sort.key == null) return filtered;
    return sortBy(filtered, sort, (r, key) => renderCell(r[key]));
  }, [records, columns, query, sort]);

  if (result && !result.configured) {
    return (
      <div className="px-5 py-6 text-center text-[12.5px] text-ink-3">
        Airtable isn't configured on the server yet. An admin needs to set the
        <span className="mono mx-1 rounded bg-surface-2 px-1.5 py-0.5">
          AIRTABLE_PAT
        </span>
        env var with a Personal Access Token scoped to base
        <span className="mono mx-1 rounded bg-surface-2 px-1.5 py-0.5">
          appU97D9wOfq6eidF
        </span>
        .
      </div>
    );
  }

  if (result?.error && records.length === 0) {
    return (
      <div className="px-5 py-6 text-center text-[12.5px] text-ink-3">
        {result.error}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 px-5 py-2 text-[11px] uppercase tracking-wider text-ink-3">
        <span>
          {isLoading
            ? "Loading…"
            : `${visible.length}${visible.length !== records.length ? ` of ${records.length}` : ""} record${records.length === 1 ? "" : "s"}`}
        </span>
        {records.length > 0 ? (
          <TableToolbar
            query={query}
            onQueryChange={onQueryChange}
            placeholder={`Search ${TAB_LABELS[tab].toLowerCase()}…`}
          />
        ) : null}
      </div>

      {isLoading ? (
        <EmptyState>Loading…</EmptyState>
      ) : records.length === 0 ? (
        <EmptyState>No records.</EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No records match.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
              <tr>
                {columns.map((c) => (
                  <th key={c.field} className="px-3 py-1.5 text-left font-semibold">
                    <SortableHeader
                      label={c.label}
                      sortKey={c.field}
                      sort={sort}
                      onToggle={toggle}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="border-t border-border-strong">
                  {columns.map((c) => (
                    <td
                      key={c.field}
                      className="max-w-[280px] truncate px-3 py-1.5 align-top text-[12px] text-ink-2"
                      title={renderCell(r[c.field])}
                    >
                      {renderCell(r[c.field]) || (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Flatten any Airtable field value into a string for display + search.
 *  - Linked records arrive as arrays of record IDs (starts with "rec…");
 *    we don't have their names from this endpoint so show the count.
 *  - Single/multi-select fields arrive as plain strings or arrays of strings.
 *  - Currency / number fields are formatted with commas.
 */
function renderCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "boolean") return v ? "✓" : "";
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    // If it's an array of record IDs (linked records), show count rather
    // than dumping cryptic recXXXX IDs into the cell.
    if (typeof v[0] === "string" && (v[0] as string).startsWith("rec")) {
      return `${v.length} linked`;
    }
    return v.map((x) => renderCell(x)).join(", ");
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.url === "string") return String(obj.url);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function PreMergeBadge() {
  return (
    <span
      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wider text-amber-900"
      title="Not yet reconciled against Salesforce records"
    >
      Pre-merge
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">
      {children}
    </div>
  );
}
