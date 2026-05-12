/**
 * Risk classification — shared across Portfolio and the existing expand
 * panels so "overdue" and "due soon" mean the same thing everywhere.
 *
 * Why centralize: previously TaskListTab, Tasks.tsx, and AwardExpandPanel
 * each rolled their own date comparison with subtly different cutoffs
 * (one uses a 24h buffer, another midnight, another 30 days). When a
 * future change touches the rules, this is the single file to edit.
 */

export type RiskLevel = "overdue" | "due-soon" | "on-track" | "done" | "none";

/** Days within "due-soon" — task deadlines closer than this turn amber. */
const TASK_DUE_SOON_DAYS = 7;

/** Days within "due-soon" for award reports — looser because reports
 *  have lead time built into the cadence. */
const REPORT_DUE_SOON_DAYS = 30;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/** Risk for an open task with an optional deadline. */
export function riskForTask(deadline: string | null | undefined, done: boolean): RiskLevel {
  if (done) return "done";
  const due = parseIsoDate(deadline);
  if (!due) return "none";
  const today = startOfToday();
  if (due < today) return "overdue";
  if (daysBetween(today, due) <= TASK_DUE_SOON_DAYS) return "due-soon";
  return "on-track";
}

/** Risk for an award report: amber 30d out, red after the due date.
 *  `status` checks let approved/submitted reports stop nagging. */
export function riskForReport(
  dueDate: string | null | undefined,
  isResolved: boolean,
): RiskLevel {
  if (isResolved) return "done";
  const due = parseIsoDate(dueDate);
  if (!due) return "none";
  const today = startOfToday();
  if (due < today) return "overdue";
  if (daysBetween(today, due) <= REPORT_DUE_SOON_DAYS) return "due-soon";
  return "on-track";
}

/** Open opportunity past its close date = at-risk for forecast accuracy. */
export function riskForOpenOpp(closeDate: string | null | undefined): RiskLevel {
  const due = parseIsoDate(closeDate);
  if (!due) return "none";
  const today = startOfToday();
  if (due < today) return "overdue";
  if (daysBetween(today, due) <= TASK_DUE_SOON_DAYS) return "due-soon";
  return "on-track";
}

/** Tailwind class fragment that pairs with the risk level. */
export function riskTextClass(r: RiskLevel): string {
  if (r === "overdue") return "text-red";
  if (r === "due-soon") return "text-amber-700";
  return "";
}

export function riskDotClass(r: RiskLevel): string {
  if (r === "overdue") return "bg-red";
  if (r === "due-soon") return "bg-amber";
  if (r === "done") return "bg-green";
  return "bg-ink-4/40";
}

export function riskLabel(r: RiskLevel): string {
  if (r === "overdue") return "Overdue";
  if (r === "due-soon") return "Due soon";
  if (r === "on-track") return "On track";
  if (r === "done") return "Done";
  return "—";
}
