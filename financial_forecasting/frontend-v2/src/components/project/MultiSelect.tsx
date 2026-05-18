import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectProps {
  label: string;
  /** Selected values. Empty array means "all". */
  values: string[];
  onChange: (next: string[]) => void;
  options: MultiSelectOption[];
  placeholder?: string;
  className?: string;
  /** Max width of the popover. */
  width?: number;
}

export function MultiSelect({
  label,
  values,
  onChange,
  options,
  placeholder = "All",
  className,
  width = 240,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selectedSet = new Set(values);
  const visible = filter
    ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()))
    : options;

  function toggle(value: string) {
    if (selectedSet.has(value)) {
      onChange(values.filter((v) => v !== value));
    } else {
      onChange([...values, value]);
    }
  }

  return (
    <div ref={wrapRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded border border-border-strong bg-surface px-2 text-[11.5px]",
          values.length > 0 ? "text-ink-2" : "text-ink-3",
          "hover:border-ink-3",
        )}
      >
        <span>{label}</span>
        {values.length > 0 ? (
          <span className="rounded bg-accent/10 px-1 text-[10.5px] font-semibold text-accent-ink">
            {values.length}
          </span>
        ) : (
          <span className="text-ink-4">{placeholder}</span>
        )}
        <ChevronDown size={11} className="text-ink-4" />
      </button>
      {values.length > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange([]);
          }}
          className="absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border-strong bg-surface text-ink-4 hover:text-ink"
          aria-label={`Clear ${label} filter`}
        >
          <X size={9} />
        </button>
      ) : null}
      {open ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 rounded-md border border-border-strong bg-surface shadow-lg"
          style={{ width }}
        >
          {options.length > 8 ? (
            <div className="border-b border-border p-1.5">
              <input
                autoFocus
                type="text"
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-7 w-full rounded border border-border-strong bg-surface px-2 text-[12px] outline-none focus:border-accent"
              />
            </div>
          ) : null}
          <div className="max-h-60 overflow-y-auto py-1">
            {visible.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-ink-4">No matches.</p>
            ) : (
              visible.map((opt) => {
                const selected = selectedSet.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggle(opt.value)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2",
                      selected && "bg-surface-2",
                    )}
                  >
                    <span className="truncate">{opt.label}</span>
                    {selected ? <Check size={12} className="text-accent" /> : null}
                  </button>
                );
              })
            )}
          </div>
          {values.length > 0 ? (
            <div className="border-t border-border p-1.5">
              <button
                type="button"
                onClick={() => {
                  onChange([]);
                  setOpen(false);
                }}
                className="block w-full rounded px-2 py-1 text-left text-[11.5px] text-ink-3 hover:bg-surface-2"
              >
                Clear selection
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
