import { cn } from "@/lib/utils";

/**
 * Renders the literal SF StageName as a chip. No mapping or bucketing —
 * the SF string is the label. Color is optional via the `status` prop
 * (caller passes "open"/"won"/"lost" derived from SF's IsClosed+IsWon
 * flags). Without a status, the chip is neutral.
 */
export function StageChip({
  stage,
  status,
  className,
}: {
  stage: string | null | undefined;
  status?: "open" | "won" | "lost";
  className?: string;
}) {
  const label = stage && stage.trim() ? stage : "—";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-px text-[11px] font-medium",
        status === "won"
          ? "bg-stage-won text-stage-won-ink"
          : status === "lost"
            ? "bg-stage-lost text-stage-lost-ink"
            : status === "open"
              ? "bg-stage-prop text-stage-prop-ink"
              : "bg-surface-2 text-ink-2",
        className,
      )}
      title={label}
    >
      {label}
    </span>
  );
}
