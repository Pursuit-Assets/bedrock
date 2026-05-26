import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared search-and-filter strip for the Portfolio entity tables.
 *
 * Mounted inside the `action` slot of each table's SectionCard so the
 * controls sit on the right edge of the section header without taking
 * a second row. The component is presentational — state is owned by
 * the parent so the filtering/sorting derivation stays colocated with
 * the data it produces.
 */
export interface FilterPillOption<V extends string = string> {
  value: V;
  label: string;
  /** Optional count to display in the chip. */
  count?: number;
}

interface TableToolbarProps<V extends string = string> {
  /** Search query string. */
  query: string;
  onQueryChange: (q: string) => void;
  /** Optional pill-style filter (Open/Won/Lost, Active/Closing/Closed, …). */
  filter?: {
    value: V;
    options: FilterPillOption<V>[];
    onChange: (v: V) => void;
  };
  placeholder?: string;
}

export function TableToolbar<V extends string = string>({
  query,
  onQueryChange,
  filter,
  placeholder = "Search…",
}: TableToolbarProps<V>) {
  return (
    <div className="flex items-center gap-3">
      {filter ? (
        <div role="tablist" className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface">
          {filter.options.map((opt) => {
            const active = opt.value === filter.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => filter.onChange(opt.value)}
                className={cn(
                  "flex items-center gap-1.5 border-l border-border-strong px-2.5 py-1 text-[11.5px] font-medium first:border-l-0",
                  active
                    ? "bg-ink text-surface"
                    : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
                )}
              >
                <span>{opt.label}</span>
                {typeof opt.count === "number" ? (
                  <span
                    className={cn(
                      "rounded px-1 text-[10.5px] tabular-nums",
                      active ? "bg-surface/20" : "bg-surface-2 text-ink-3",
                    )}
                  >
                    {opt.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="relative">
        <Search
          size={12}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-4"
        />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder}
          className="h-7 w-[200px] rounded border border-border-strong bg-surface pl-6 pr-6 text-[12px] outline-none focus:border-accent"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-4 hover:text-ink-2"
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
