/**
 * Pure helpers for classifying urgency reasons into visual alert categories.
 * Kept in a standalone module (no MUI, no hooks) so the classifier can be
 * unit-tested without pulling the component tree.
 *
 * Reasons are produced by `computeUrgency` in ./priorityScoring.ts — keep the
 * regexes here in sync with the strings pushed there.
 */

export type AlertKind =
  | 'overdue'        // past close date
  | 'closing'        // closing within the next 30 days
  | 'stale'          // no recent activity (includes high-value "quiet" escalations)
  | 'overdueTasks'   // N overdue task(s)
  | 'noTasks'        // no tasks assigned
  | 'meeting'        // upcoming meeting prep
  | 'renewal';       // renewal / upsell tag

/**
 * Human-readable category label, shown in the column header legend.
 * Keep short — these render in a compact tooltip/popover.
 */
export const ALERT_LABELS: Record<AlertKind, string> = {
  overdue: 'Past close date',
  overdueTasks: 'Overdue tasks',
  stale: 'No recent activity',
  closing: 'Closing soon',
  meeting: 'Upcoming meeting',
  renewal: 'Renewal / Upsell',
  noTasks: 'No tasks assigned',
};

/**
 * Render order — most actionable first. Also used for sorting icons in the
 * row so the eye always lands on the most severe category leftmost.
 */
export const ALERT_PRIORITY: Record<AlertKind, number> = {
  overdue: 1,
  overdueTasks: 2,
  stale: 3,
  closing: 4,
  meeting: 5,
  renewal: 6,
  noTasks: 7,
};

/**
 * Map a `computeUrgency` reason string to its alert category.
 * Returns `null` for unrecognized strings (forward compatibility — a future
 * reason won't crash the renderer, it just won't show an icon until added).
 */
export function classifyReason(reason: string): AlertKind | null {
  if (/^Overdue by/i.test(reason)) return 'overdue';
  if (/^Closing in/i.test(reason)) return 'closing';
  if (/^Stale/i.test(reason)) return 'stale';
  if (/^Quiet/i.test(reason)) return 'stale'; // high-value stalled escalation
  if (/overdue task/i.test(reason)) return 'overdueTasks';
  if (reason === 'No tasks assigned') return 'noTasks';
  if (/^Meeting in/i.test(reason)) return 'meeting';
  if (reason === 'Renewal' || reason === 'Upsell') return 'renewal';
  return null;
}

/**
 * Group reasons by kind (dedupes multiple reasons that map to the same
 * category), sorted by priority. Returns an array of [kind, reasons[]]
 * entries ready to render as individual icon + tooltip pairs.
 */
export function groupReasonsByKind(
  reasons: readonly string[],
): Array<[AlertKind, string[]]> {
  const byKind = new Map<AlertKind, string[]>();
  for (const reason of reasons) {
    const kind = classifyReason(reason);
    if (!kind) continue;
    const existing = byKind.get(kind);
    if (existing) existing.push(reason);
    else byKind.set(kind, [reason]);
  }
  return Array.from(byKind.entries()).sort(
    (a, b) => ALERT_PRIORITY[a[0]] - ALERT_PRIORITY[b[0]],
  );
}
