import { type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * <th> that renders an unobtrusive drag handle on its right edge.
 * Pair with `useColumnWidths` (lib/columnWidths.ts) to make table
 * columns user-resizable + persistent.
 */
export function ResizableTh({
  children,
  width,
  onStartResize,
  isLast,
  align = "left",
  className,
}: {
  children: ReactNode;
  width: number;
  onStartResize: (e: React.PointerEvent) => void;
  isLast?: boolean;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      style={{ width }}
      className={cn(
        "relative border-b border-border-strong bg-surface-2 px-3 py-2",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
      {!isLast ? (
        <span
          onPointerDown={onStartResize}
          className="group absolute right-0 top-0 z-10 flex h-full w-1.5 cursor-col-resize touch-none items-center justify-center hover:bg-accent/40 active:bg-accent"
          aria-hidden
        >
          <span className="block h-full w-px bg-border-strong group-hover:bg-accent" />
        </span>
      ) : null}
    </th>
  );
}

/**
 * Renders a <colgroup> from a width map so the browser uses
 * `table-layout: fixed` widths authoritatively. Order matters — must
 * match the <th> / <td> order.
 */
export function ColGroup<K extends string>({
  order,
  widths,
}: {
  order: K[];
  widths: Record<K, number>;
}) {
  return (
    <colgroup>
      {order.map((k) => (
        <col key={k} style={{ width: widths[k] }} />
      ))}
    </colgroup>
  );
}
