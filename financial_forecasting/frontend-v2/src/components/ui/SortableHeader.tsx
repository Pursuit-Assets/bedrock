import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";

import type { SortState } from "@/lib/sort";
import { cn } from "@/lib/utils";

/**
 * Sortable column header. Click cycles asc → desc → cleared.
 * Use inside <th> by passing the column key to identify it.
 */
export function SortableHeader<K extends string>({
  label,
  sortKey,
  sort,
  onToggle,
  align = "left",
}: {
  label: string;
  sortKey: K;
  sort: SortState<K>;
  onToggle: (key: K) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;

  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey)}
      className={cn(
        "group inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider hover:text-ink",
        active ? "text-ink" : "text-ink-3",
        align === "right" && "flex-row-reverse",
      )}
    >
      <span>{label}</span>
      <span className="opacity-70 group-hover:opacity-100">
        {active && sort.direction === "asc" ? (
          <ChevronUp size={11} />
        ) : active && sort.direction === "desc" ? (
          <ChevronDown size={11} />
        ) : (
          <ChevronsUpDown size={11} className="opacity-50" />
        )}
      </span>
    </button>
  );
}
