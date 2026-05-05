/**
 * Single metric card in a detail-page stats row. Pair with a 2/3/4-column
 * grid; the typography + bordered tile is the same shape across pages.
 */

export interface StatProps {
  label: string;
  value: string;
  /** Optional accent variant for at-a-glance status (e.g. red for overdue). */
  tone?: "default" | "green" | "amber" | "red";
}

const TONE_CLASS: Record<NonNullable<StatProps["tone"]>, string> = {
  default: "text-ink",
  green: "text-green",
  amber: "text-amber",
  red: "text-red",
};

export function Stat({ label, value, tone = "default" }: StatProps) {
  return (
    <div className="rounded-md border border-border-strong bg-surface px-4 py-3 shadow-sm">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">
        {label}
      </div>
      <div className={`mono mt-1 text-[18px] font-semibold tabular-nums ${TONE_CLASS[tone]}`}>
        {value}
      </div>
    </div>
  );
}
