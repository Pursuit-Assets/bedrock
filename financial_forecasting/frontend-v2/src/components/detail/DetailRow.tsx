/**
 * Compact one-line label/value row used inside a Details card.
 * Fixed-width left label keeps multiple rows aligned.
 */
import type React from "react";

export interface DetailRowProps {
  label: string;
  children: React.ReactNode;
}

export function DetailRow({ label, children }: DetailRowProps) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-[120px] flex-shrink-0 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3 leading-[20px]">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
