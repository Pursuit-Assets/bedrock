import { memo, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import { PageHeader } from "@/components/PageHeader";
import { ColGroup, ResizableTh } from "@/components/ui/ResizableTable";
import { SortableHeader } from "@/components/ui/SortableHeader";
import { Toolbar } from "@/components/ui/Toolbar";
import { totalWidth, useColumnWidths } from "@/lib/columnWidths";
import { fmtDate } from "@/lib/format";
import { sortBy, useSort } from "@/lib/sort";
import { useProjects, type BedrockProject } from "@/services/projects";

type ColKey = "name" | "owner" | "created" | "updated";

const COLUMN_ORDER: ColKey[] = ["name", "owner", "created", "updated"];

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  name: 360,
  owner: 200,
  created: 130,
  updated: 130,
};

const COL_LABELS: Record<ColKey, string> = {
  name: "Project",
  owner: "Owner",
  created: "Created",
  updated: "Updated",
};

const ROW_HEIGHT = 44; // px — must match the row's actual rendered height

/** Stable router-state for outbound detail-page links so BackLinks
 *  render "Back to Projects". */
const PROJECTS_REFERRER = {
  from: { pathname: "/projects", label: "Projects" },
} as const;

function extractProject(p: BedrockProject, key: ColKey): unknown {
  switch (key) {
    case "name":
      return p.name;
    case "owner":
      return p.owner_email;
    case "created":
      return p.created_at;
    case "updated":
      return p.updated_at;
  }
}

export function ProjectsPage() {
  const { data, isLoading, isError, error } = useProjects();
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  const { sort, toggle } = useSort<ColKey>({
    key: "updated",
    direction: "desc",
  });
  const { widths, startResize } = useColumnWidths<ColKey>(
    "bedrock-v2:cols:projects",
    DEFAULT_WIDTHS,
  );

  const projects = data ?? [];

  const filtered = useMemo(() => {
    const f = projects.filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q.toLowerCase()) ||
        (p.description ?? "").toLowerCase().includes(q.toLowerCase()) ||
        (p.owner_email ?? "").toLowerCase().includes(q.toLowerCase()),
    );
    return sortBy(f, sort, extractProject);
  }, [projects, q, sort]);

  const tableMinWidth = totalWidth(widths);

  // ── Virtualization ─────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems[0]?.start ?? 0;
  const paddingBottom =
    totalSize - (virtualItems[virtualItems.length - 1]?.end ?? 0);

  return (
    <div className="flex h-full flex-col px-7 py-6 pb-6">
      <PageHeader
        title="Projects"
        subtitle={
          isLoading
            ? "Loading…"
            : `${projects.length.toLocaleString()} projects`
        }
      />

      <Toolbar>
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            placeholder="Search projects, owner, description"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-7 w-72 rounded border border-border-strong bg-surface pl-7 pr-3 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        </div>
        <span className="ml-auto text-[11.5px] text-ink-3">
          {filtered.length.toLocaleString()} of{" "}
          {projects.length.toLocaleString()}
        </span>
      </Toolbar>

      {/*
        Single scroll container. Header is sticky, body is virtualized via
        spacer rows above + below the visible window. Total row count
        stays under ~30 in the DOM regardless of dataset size.
      */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto rounded-b-lg border border-border-strong bg-surface"
      >
        <table
          className="border-collapse"
          style={{
            tableLayout: "fixed",
            width: "100%",
            minWidth: tableMinWidth,
          }}
        >
          <ColGroup order={COLUMN_ORDER} widths={widths} />
          <thead className="sticky top-0 z-10">
            <tr>
              {COLUMN_ORDER.map((key, idx) => (
                <ResizableTh
                  key={key}
                  width={widths[key]}
                  onStartResize={(e) => startResize(key, e)}
                  align="left"
                  isLast={idx === COLUMN_ORDER.length - 1}
                >
                  <SortableHeader
                    label={COL_LABELS[key]}
                    sortKey={key}
                    sort={sort}
                    onToggle={toggle}
                  />
                </ResizableTh>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <SkeletonRows />
            ) : isError ? (
              <tr>
                <td
                  colSpan={COLUMN_ORDER.length}
                  className="px-7 py-10 text-center text-[13px] text-red"
                >
                  Failed to load projects
                  {error instanceof Error ? `: ${error.message}` : ""}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMN_ORDER.length}
                  className="px-7 py-10 text-center text-[13px] text-ink-3"
                >
                  {projects.length === 0
                    ? "No projects yet."
                    : "No projects match your search."}
                </td>
              </tr>
            ) : (
              <>
                {paddingTop > 0 ? (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={COLUMN_ORDER.length} />
                  </tr>
                ) : null}
                {virtualItems.map((vi) => {
                  const p = filtered[vi.index];
                  return (
                    <ProjectRow
                      key={p.id}
                      p={p}
                      onOpen={() => navigate(`/projects/${p.id}`, { state: PROJECTS_REFERRER })}
                    />
                  );
                })}
                {paddingBottom > 0 ? (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={COLUMN_ORDER.length} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}

interface RowProps {
  p: BedrockProject;
  onOpen: () => void;
}

const ProjectRow = memo(function ProjectRow({ p, onOpen }: RowProps) {
  return (
    <tr
      className="group/row cursor-pointer border-b border-border-strong hover:bg-surface-2"
      style={{ height: ROW_HEIGHT }}
      onClick={onOpen}
    >
      <td className="overflow-hidden px-3 py-1 text-[13px]">
        <span
          className="block truncate font-medium hover:underline"
          title={p.name}
        >
          {p.name}
        </span>
        {p.description ? (
          <span
            className="block truncate text-[11.5px] text-ink-3"
            title={p.description}
          >
            {p.description}
          </span>
        ) : null}
      </td>
      <td className="overflow-hidden truncate px-3 py-1 text-[12.5px] text-ink-2">
        {p.owner_email ?? <span className="text-ink-4">—</span>}
      </td>
      <td className="mono overflow-hidden truncate px-3 py-1 text-[11.5px] text-ink-3">
        {fmtDate(p.created_at)}
      </td>
      <td className="mono overflow-hidden truncate px-3 py-1 text-[11.5px] text-ink-3">
        {fmtDate(p.updated_at)}
      </td>
    </tr>
  );
});

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="border-b border-border-strong">
          <td colSpan={COLUMN_ORDER.length} className="px-3 py-2.5">
            <div className="h-4 w-full animate-pulse rounded bg-surface-2" />
          </td>
        </tr>
      ))}
    </>
  );
}
