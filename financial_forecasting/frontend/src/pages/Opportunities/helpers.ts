/**
 * Pure helper functions for the Opportunities page.
 *
 * Extracted from the monolithic Opportunities.tsx so they're testable
 * and reusable across sub-components.
 */
import { addDays } from 'date-fns';
import type { OpportunityStage } from '../../types/salesforce';
import { getStageHexColor } from '../../types/salesforce';

/**
 * @deprecated Use getStageHexColor() from types/salesforce.ts for per-stage hex colors.
 * Kept for backward compatibility with components still using MUI color names.
 */
export function getStageColor(stage: string): 'success' | 'error' | 'warning' | 'info' {
  if (stage.includes('Completed')) return 'success';
  if (stage.includes('Closed Lost') || stage.includes('Withdrawn') || stage.includes('Did not Fulfill'))
    return 'error';
  if (stage.includes('Proposal') || stage.includes('Negotiat')) return 'warning';
  return 'info';
}

export { getStageHexColor };

export function getProbabilityColor(probability: number): 'success' | 'warning' | 'error' {
  if (probability >= 70) return 'success';
  if (probability >= 40) return 'warning';
  return 'error';
}

export function calculatePaymentDate(closeDate: string): Date | null {
  if (!closeDate) return null;
  try {
    return addDays(new Date(closeDate), 30);
  } catch {
    return null;
  }
}

/**
 * The Opportunity interface used across all Opportunities sub-components.
 *
 * This is kept here (rather than in types/salesforce.ts) because it includes
 * Pursuit-specific custom fields that only matter in the Opportunities context.
 */
export interface Opportunity {
  Id: string;
  Name: string;
  AccountId: string;
  Account?: { Name: string };
  StageName: string;
  Amount: number;
  Probability: number;
  CloseDate: string;
  CreatedDate: string;
  LastModifiedDate: string;
  OwnerId: string;
  Owner?: { Name: string };
  npe01__Payments_Made__c?: number;
  Outstanding_Payments__c?: number;
  Number_of_Payments_Received__c?: number;
  Most_Recent_Payment_Date__c?: string;
  Last_Actual_Payment__c?: string;
  npe01__Number_of_Payments__c?: number;
  PaymentDate__c?: string;
  Earliest_Scheduled_Payment__c?: string;
  RecordType?: { Name: string };
  Active_Opportunity__c?: boolean;
  RenewalRepeat__c?: string;
  LastActivityDate?: string;
  LeadSource?: string;
  NextStep?: string;
  Description?: string;
  ForecastCategory?: string;
  ExpectedRevenue?: number;
  // Primary Contact — NPSP writable lookup (PR #173).
  npsp__Primary_Contact__c?: string | null;
  npsp__Primary_Contact__r?: { Id?: string; Name: string; Email?: string | null };
  // Payment_Terms__c / Contract_Start_Date__c / Contract_End_Date__c /
  // Billing_Frequency__c removed 2026-04-21 — don't exist on Opportunity
  // in Pursuit's live SF org. See types/salesforce.ts comment + PR #168.
}
