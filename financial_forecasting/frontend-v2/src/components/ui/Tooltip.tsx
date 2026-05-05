import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

/**
 * Lightweight tooltip wrapper around Radix. Usage:
 *
 *   <Tooltip content="Wins (100%) + …">
 *     <Info size={11} aria-label="…" />
 *   </Tooltip>
 *
 * Renders a small, dark, rounded tooltip with a 200ms delay — fast
 * enough to feel instant on intentional hover but slow enough not to
 * fire when the user is just sweeping the cursor across the screen.
 *
 * The single shared <Provider> at the root means callers don't have
 * to wrap their tree; nesting another Provider is a no-op.
 */
export function Tooltip({
  content,
  children,
  side = "top",
  align = "center",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            className={cn(
              "z-50 max-w-xs rounded bg-ink px-2 py-1 text-[11.5px] font-medium text-surface shadow-lg",
              "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            )}
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-ink" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
