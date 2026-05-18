import { differenceInDays, isBefore, parseISO, startOfDay } from "date-fns";

import type { SfOpportunity, SfTask } from "@/types/salesforce";

export interface UrgencyScore {
  score: number;
  reasons: string[];
}

/**
 * Weighted priority: Amount × (Probability / 100) × log-scale bonus
 * for large deals. Early-stage opps with 0% probability get a 1% floor
 * so they're still differentiable by amount instead of all tying at 0.
 *
 * Mirrors `frontend/src/utils/priorityScoring.ts:35` line-for-line —
 * stable across the migration so the priority list keeps its order.
 */
export function computeWeightedPriority(
  opp: Pick<SfOpportunity, "Amount" | "Probability" | "Manager_Probability_Override__c">,
): number {
  const amount = opp.Amount ?? 0;
  // Use the manager override when set; otherwise the stage-derived probability.
  const probRaw = opp.Manager_Probability_Override__c ?? opp.Probability ?? 0;
  const prob = Math.max(probRaw, 1);
  return amount * (prob / 100) * (1 + Math.log10(1 + amount / 1_000_000));
}

/**
 * Multi-factor urgency score with explainable reasons. Drives the alerts
 * column. Higher score = more urgent. Reasons are surfaced in tooltips.
 *
 * Tasks are filtered to the opportunity's WhatId externally; pass the
 * joined task list in `tasks` for accurate overdue / no-tasks signals.
 */
export function computeUrgency(
  opp: SfOpportunity,
  tasks: SfTask[] = [],
  nextEventStart: string | null = null,
): UrgencyScore {
  const reasons: string[] = [];
  let score = 0;
  const now = startOfDay(new Date());

  // ── Close-date urgency
  if (opp.CloseDate) {
    const close = parseISO(opp.CloseDate);
    const daysUntil = differenceInDays(close, now);
    if (daysUntil < 0) {
      score += 40;
      reasons.push(`Overdue by ${Math.abs(daysUntil)} days`);
    } else if (daysUntil <= 7) {
      score += 30;
      reasons.push(`Closing in ${daysUntil} days`);
    } else if (daysUntil <= 30) {
      score += 15;
      reasons.push(`Closing in ${daysUntil} days`);
    }
  }

  // ── Overdue tasks
  const overdueTasks = tasks.filter((t) => {
    if (!t.ActivityDate) return false;
    if (t.Status === "Completed" || t.IsClosed) return false;
    return isBefore(parseISO(t.ActivityDate), now);
  });
  if (overdueTasks.length > 0) {
    score += 20;
    reasons.push(
      `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`,
    );
  }

  // ── Stale / Quiet — LastModifiedDate is the "last touched" signal
  //    available on v2's SfOpportunity. The legacy frontend also
  //    consulted LastActivityDate, but that field isn't exposed by the
  //    v2 type today; LastModifiedDate is the safe single source.
  if (opp.LastModifiedDate) {
    const lastTouched = parseISO(opp.LastModifiedDate);
    const daysSinceActivity = differenceInDays(now, lastTouched);
    if (daysSinceActivity > 30) {
      score += 15;
      reasons.push(`Stale — ${daysSinceActivity} days since activity`);
    }
    const amount = opp.Amount ?? 0;
    if (amount >= 250000) {
      if (daysSinceActivity > 365) {
        score += 30;
        reasons.push("Quiet >1yr");
      } else if (daysSinceActivity > 180) {
        score += 25;
        reasons.push("Quiet >180d");
      } else if (daysSinceActivity > 90) {
        score += 20;
        reasons.push("Quiet >90d");
      } else if (daysSinceActivity > 60) {
        score += 15;
        reasons.push("Quiet >60d");
      } else if (daysSinceActivity > 30) {
        score += 10;
        reasons.push("Quiet >30d");
      } else if (daysSinceActivity > 15) {
        score += 5;
        reasons.push("Quiet >15d");
      }
    }
  }

  // ── Meeting prep needed (event in next 0–3 days)
  if (nextEventStart) {
    const eventDate = parseISO(nextEventStart);
    const daysUntilEvent = differenceInDays(eventDate, now);
    if (daysUntilEvent > 0 && daysUntilEvent <= 3) {
      score += 10;
      reasons.push(
        `Meeting in ${daysUntilEvent} day${daysUntilEvent > 1 ? "s" : ""}`,
      );
    }
  }

  // ── No open tasks — last alert in order (least urgent)
  const openTasks = tasks.filter(
    (t) => t.Status !== "Completed" && !t.IsClosed,
  );
  if (openTasks.length === 0) {
    score += 10;
    reasons.push("No tasks assigned");
  }

  // ── Higher amount = slight urgency boost (no chip)
  const amount = opp.Amount ?? 0;
  if (amount > 500_000) score += 5;
  if (amount > 1_000_000) score += 5;

  return { score, reasons };
}

/** Count of overdue (incomplete + past-due) tasks for an opportunity. */
export function countOverdueTasks(tasks: SfTask[]): number {
  const now = startOfDay(new Date());
  return tasks.filter((t) => {
    if (!t.ActivityDate) return false;
    if (t.Status === "Completed" || t.IsClosed) return false;
    return isBefore(parseISO(t.ActivityDate), now);
  }).length;
}
