/**
 * Label + control pair used in detail-page grids — typography sits
 * above the control rather than to the side, suited for fields that
 * each have their own input/inline-edit cell.
 */
import type React from "react";

export interface EditFieldProps {
  label: string;
  children: React.ReactNode;
}

export function EditField({ label, children }: EditFieldProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      {children}
    </div>
  );
}
