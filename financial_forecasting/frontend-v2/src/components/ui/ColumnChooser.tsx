import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";

import { cn } from "@/lib/utils";

interface ColumnChooserProps<K extends string> {
  allColumns: K[];
  labels: Record<K, string>;
  visible: K[];
  required?: K[];
  onToggle: (col: K) => void;
}

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
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink",
          open && "bg-surface-2 text-ink",
        )}
      >
        <Columns3 size={12} />
        Columns
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-20 min-w-[160px] rounded-lg border border-border-strong bg-surface p-1.5 shadow-lg">
          {allColumns.map((col) => {
            const isReq = required.includes(col);
            const isVisible = visible.includes(col);
            return (
              <label
                key={col}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12.5px] hover:bg-surface-2",
                  isReq && "cursor-default opacity-50",
                )}
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  disabled={isReq}
                  onChange={() => !isReq && onToggle(col)}
                  className="h-3 w-3 accent-ink"
                />
                {labels[col]}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
