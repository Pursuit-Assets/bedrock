/**
 * Priority scoring utilities — extracted from PriorityList.tsx for reuse and testability.
 */
import { parseISO, differenceInDays, isBefore, startOfDay } from 'date-fns';

export interface PriorityOpp {
  Id: string;
  Name: string;
  StageName: string;
  Amount: number;
  CloseDate: string;
  Probability: number;
  OwnerId?: string;
  RenewalRepeat?: string;
  Account?: { Name: string; Id?: string };
  LastModifiedDate?: string;
  LastActivityDate?: string;
  CampaignId?: string | null;
  CampaignName?: string | null;
  tasks?: Array<{ Id: string; Subject: string; ActivityDate: string; Priority: string; Status: string; OwnerId?: string; OwnerName?: string; Description?: string; WhoId?: string; WhoName?: string }>;
  nextEvent?: { summary: string; start: string };
}

export interface UrgencyScore {
  score: number;
  reasons: string[];
}

/**
 * Weighted priority: Amount x (Probability / 100) x log-scale bonus for large deals.
 *
 * Early-stage opps often have 0% probability (Lead Gen, New Lead). A 1% floor
 * ensures they're still differentiated by amount rather than all tying at zero.
 */
export function computeWeightedPriority(opp: PriorityOpp): number {
  const amount = opp.Amount || 0;
  const prob = Math.max(opp.Probability || 0, 1);
  return amount * (prob / 100) * (1 + Math.log10(1 + amount / 1_000_000));
}

export function computeUrgency(opp: PriorityOpp): UrgencyScore {
  const reasons: string[] = [];
  let score = 0;
  const now = startOfDay(new Date());

  // Close date urgency
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

  // Overdue tasks
  const overdueTasks = (opp.tasks || []).filter((t) => {
    if (!t.ActivityDate) return false;
    return isBefore(parseISO(t.ActivityDate), now) && t.Status !== 'Completed';
  });
  if (overdueTasks.length > 0) {
    score += 20;
    reasons.push(`${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''}`);
  }

  // Stale / Quiet — use whichever date is OLDER (more stale) between LastModifiedDate and LastActivityDate
  // LastModifiedDate updates on any field change (including automation); LastActivityDate tracks actual tasks/events
  const staleDates: Date[] = [];
  if (opp.LastModifiedDate) staleDates.push(parseISO(opp.LastModifiedDate));
  if (opp.LastActivityDate) staleDates.push(parseISO(opp.LastActivityDate));
  if (staleDates.length > 0) {
    // Use the MORE RECENT of the two as the "last touched" date
    const lastTouched = staleDates.reduce((a, b) => (a > b ? a : b));
    const daysSinceActivity = differenceInDays(now, lastTouched);
    if (daysSinceActivity > 30) {
      score += 15;
      reasons.push(`Stale — ${daysSinceActivity} days since activity`);
    }

    // High value stalled — escalating thresholds for large deals
    if (opp.Amount >= 250000) {
      if (daysSinceActivity > 365) { score += 30; reasons.push('Quiet >1yr'); }
      else if (daysSinceActivity > 180) { score += 25; reasons.push('Quiet >180d'); }
      else if (daysSinceActivity > 90) { score += 20; reasons.push('Quiet >90d'); }
      else if (daysSinceActivity > 60) { score += 15; reasons.push('Quiet >60d'); }
      else if (daysSinceActivity > 30) { score += 10; reasons.push('Quiet >30d'); }
      else if (daysSinceActivity > 15) { score += 5; reasons.push('Quiet >15d'); }
    }
  }

  // Meeting prep needed (event in next 2+ days)
  if (opp.nextEvent?.start) {
    const eventDate = parseISO(opp.nextEvent.start);
    const daysUntilEvent = differenceInDays(eventDate, now);
    if (daysUntilEvent > 0 && daysUntilEvent <= 3) {
      score += 10;
      reasons.push(`Meeting in ${daysUntilEvent} day${daysUntilEvent > 1 ? 's' : ''}: ${opp.nextEvent.summary}`);
    }
  }

  // Renewal / Upsell tag — protecting existing revenue
  // Uses RenewalRepeat__c custom field from Salesforce
  if (opp.RenewalRepeat) {
    const r = opp.RenewalRepeat.toLowerCase();
    if (r.includes('renewal') || r.includes('repeat')) { score += 5; reasons.push('Renewal'); }
    else if (r.includes('upsell')) { score += 5; reasons.push('Upsell'); }
  }

  // No open tasks — always last in alert order (least urgent)
  const openTasks = (opp.tasks || []).filter((t) => t.Status !== 'Completed');
  if (openTasks.length === 0) {
    score += 10;
    reasons.push('No tasks assigned');
  }

  // Higher amount = slight urgency boost (no chip)
  if (opp.Amount > 500000) score += 5;
  if (opp.Amount > 1000000) score += 5;

  return { score, reasons };
}

/** Count of overdue (incomplete + past due) tasks for an opportunity. */
export function countOverdueTasks(opp: PriorityOpp): number {
  const now = startOfDay(new Date());
  return (opp.tasks || []).filter((t) => {
    if (!t.ActivityDate) return false;
    return isBefore(parseISO(t.ActivityDate), now) && t.Status !== 'Completed';
  }).length;
}
