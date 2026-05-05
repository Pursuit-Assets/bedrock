/**
 * Per-account roll-ups derived from the Opportunity list. Used by the
 * Accounts page table and the Cleanup → Accounts tab so both views
 * agree on Open Pipeline / Amount Won / Received / Outstanding.
 *
 * Outstanding is `max(0, amountWon - received)` so partial-pay clamps
 * to zero rather than going negative if SF reports overpayment.
 */
import { isOpen, isWon } from "@/lib/stages";
import type { SfOpportunity } from "@/types/salesforce";

export interface AccountMetrics {
  openPipeline: number;
  amountWon: number;
  received: number;
  outstanding: number;
}

export const ZERO_ACCOUNT_METRICS: AccountMetrics = {
  openPipeline: 0,
  amountWon: 0,
  received: 0,
  outstanding: 0,
};

export function buildAccountMetricsMap(
  opps: SfOpportunity[],
): Map<string, AccountMetrics> {
  const m = new Map<string, AccountMetrics>();
  for (const o of opps) {
    const accountId = o.AccountId;
    if (!accountId) continue;
    let cur = m.get(accountId);
    if (!cur) {
      cur = { ...ZERO_ACCOUNT_METRICS };
      m.set(accountId, cur);
    }
    const amount = o.Amount ?? 0;
    if (isOpen(o)) {
      cur.openPipeline += amount;
    } else if (isWon(o)) {
      cur.amountWon += amount;
      cur.received += o.npe01__Payments_Made__c ?? 0;
    }
  }
  for (const v of m.values()) {
    v.outstanding = Math.max(0, v.amountWon - v.received);
  }
  return m;
}
