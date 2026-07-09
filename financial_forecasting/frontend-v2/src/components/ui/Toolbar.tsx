import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Toolbar above a table — filter chips, search, action buttons. Sits flush
 * against the top of the table-wrapper (no border between).
 */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-2 rounded-t-lg border border-b-0 border-border-strong bg-surface px-3 py-2.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ButtonGroup({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-border-strong bg-surface">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "h-7 px-3 text-[12.5px] font-medium text-ink-2 transition-colors",
            i > 0 && "border-l border-border-strong",
            value === opt.value && "bg-surface-2 text-ink",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function FilterPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded border border-border-strong bg-surface px-2.5 text-[12.5px] text-ink-2">
      {children}
    </span>
  );
}
