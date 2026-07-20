import { useEffect, useRef, useState } from "react";
import { Check, Columns3 } from "lucide-react";

import { cn } from "@/lib/utils";

interface ColumnChooserProps<K extends string> {
  allColumns: K[];
  labels: Record<K, string>;
  visible: K[];
  required?: K[];
  onToggle: (col: K) => void;
}

/** Column visibility menu, shared by every data grid. Styled check rows
 * (no native checkboxes), z-50 so sticky table headers can't paint over it,
 * scrolls internally past ~12 items, closes on outside click or Escape. */
export function ColumnChooser<K extends string>({
  allColumns,
  labels,
  visible,
  required = [],
  onToggle,
}: ColumnChooserProps<K>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shown = visible.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink",
          open && "border-ink-3 bg-surface-2 text-ink",
        )}
      >
        <Columns3 size={12} />
        Columns
        {shown < allColumns.length && (
          <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-semibold tabular-nums text-ink-3">
            {shown}/{allColumns.length}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-50 w-[210px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-xl">
          <div className="border-b border-border-strong/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-ink-4">
            Show columns
          </div>
          <div className="max-h-[320px] overflow-y-auto p-1">
            {allColumns.map((col) => {
              const isReq = required.includes(col);
              const isVisible = visible.includes(col);
              return (
                <button
                  key={col}
                  type="button"
                  disabled={isReq}
                  onClick={() => onToggle(col)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
                    isReq ? "cursor-default" : "hover:bg-surface-2",
                    isVisible ? "text-ink" : "text-ink-3",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                      isVisible
                        ? "border-accent bg-accent text-white"
                        : "border-border-strong bg-surface",
                      isReq && "opacity-45",
                    )}
                  >
                    {isVisible && <Check size={10.5} strokeWidth={3} />}
                  </span>
                  <span className={cn("min-w-0 flex-1 truncate", isReq && "opacity-60")}>
                    {labels[col]}
                  </span>
                  {isReq && <span className="text-[9.5px] uppercase tracking-wide text-ink-4">fixed</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
