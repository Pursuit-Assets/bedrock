/**
 * Empty-state body for a {@link SectionCard}. Centered text in a
 * standard padding box — same dimensions across all detail pages.
 */
import type React from "react";

export interface EmptyProps {
  children: React.ReactNode;
}

export function Empty({ children }: EmptyProps) {
  return (
    <div className="px-5 py-8 text-center text-[12.5px] text-ink-3">{children}</div>
  );
}
