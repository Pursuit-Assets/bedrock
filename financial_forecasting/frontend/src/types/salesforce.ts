/**
 * Pursuit's Salesforce types — single source of truth for the frontend.
 *
 * Stage values MUST match the custom picklist in the Salesforce org and the
 * OpportunityStage enum in financial_forecasting/models.py.
 */

// ── Opportunity Stages ──────────────────────────────────────────────────────

export const OPPORTUNITY_STAGES = [
  '--None--',
  'Lead Gen',
  'New Lead',
  'Qualifying',
  'Design / Proposal Creation',
  'Proposal Negotiation',
  'Contract Creation',
  'Negotiating Contract',
  'Collecting / In Effect',
  'Closed / Did not Fulfill',
  'Closed / Completed',
  'Closed Lost',
  'Withdrawn',
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/**
 * Per-stage colors: blue (early) → teal → green (closing) → dark green (won) → maroon (lost).
 *
 * Includes 'Closed Won' (Donorbox-auto-populated philanthropy stage, not in
 * OPPORTUNITY_STAGES) so Donorbox records render the same terminal-won green
 * as 'Closed / Completed'.
 */
export const STAGE_COLORS: Readonly<Record<OpportunityStage | 'Closed Won', string>> = {
  '--None--':                    '#9E9E9E',
  'Lead Gen':                    '#5c6bc0',
  'New Lead':                    '#42a5f5',
  'Qualifying':                  '#26c6da',
  'Design / Proposal Creation':  '#26a69a',
  'Proposal Negotiation':        '#66bb6a',
  'Contract Creation':           '#43a047',
  'Negotiating Contract':        '#388e3c',
  'Collecting / In Effect':      '#2e7d32',
  'Closed / Did not Fulfill':    '#7b1a2c',
  'Closed / Completed':          '#1b5e20',
  'Closed Lost':                 '#7b1a2c',
  'Withdrawn':                   '#8d6e63',
  'Closed Won':                  '#1b5e20',
};

/** Pipeline-order index for sorting stages (lower = earlier in pipeline). */
export function stageIndex(stage: string): number {
  const idx = OPPORTUNITY_STAGES.indexOf(stage as OpportunityStage);
  return idx >= 0 ? idx : OPPORTUNITY_STAGES.length;
}

/** Get the hex color for a stage name; falls back to grey for unknown stages. */
export function getStageHexColor(stage: string): string {
  return STAGE_COLORS[stage as OpportunityStage | 'Closed Won'] || '#9E9E9E';
}

export const OPEN_STAGES: readonly OpportunityStage[] = [
  'Lead Gen',
  'New Lead',
  'Qualifying',
  'Design / Proposal Creation',
  'Proposal Negotiation',
  'Contract Creation',
  'Negotiating Contract',
];

export const COLLECTING_STAGES: readonly OpportunityStage[] = [
  'Collecting / In Effect',
];

export const CLOSED_STAGES: readonly OpportunityStage[] = [
  'Closed Lost',
  'Withdrawn',
  'Closed / Did not Fulfill',
  'Closed / Completed',
];

/**
 * Win / loss / payment / collecting bucket sets used by the Pipeline Funnel
 * classifier and downstream reporting. Membership includes stage strings
 * outside the tight `OpportunityStage` union — notably `'Closed Won'`, the
 * Donorbox-auto-populated philanthropy donation stage (~575 live records,
 * Campaign.Name = 'Online Donations'). String-typed `ReadonlySet<string>`
 * admits values outside the 13-stage enum without widening the enum itself.
 *
 * See tasks/f1-stage-buckets-plan.md and tasks/stage-schema-drift.md.
 *
 * `OPEN_STAGES`, `COLLECTING_STAGES`, `CLOSED_STAGES` stay as
 * `readonly OpportunityStage[]` — all their members are in the 13-stage enum
 * and multiple consumers rely on array semantics (`.includes`, spread).
 */
export const WON_STAGES: ReadonlySet<string> = new Set([
  'Collecting / In Effect',
  'Closed / Completed',
  'Closed Won',  // Donorbox philanthropy donations — not in OPPORTUNITY_STAGES
]);

export const LOST_STAGES: ReadonlySet<string> = new Set([
  'Closed Lost',
  'Withdrawn',
  'Closed / Did not Fulfill',
]);

/** Stages where money has been received (as distinct from COLLECTING_STAGES, where a signed
 *  contract is in-flight and payments are still arriving). ⊂ WON_STAGES. */
export const PAYMENT_RECEIVED_STAGES: ReadonlySet<string> = new Set([
  'Closed / Completed',
  'Closed Won',
]);

// ── Salesforce Object Interfaces ────────────────────────────────────────────

export interface SalesforceOpportunity {
  Id: string;
  AccountId: string;
  Name: string;
  StageName: OpportunityStage;
  Amount: number | null;
  Probability: number | null;
  CloseDate: string | null;
  ExpectedRevenue: number | null;
  ForecastCategory: string | null;
  Type: string | null;
  LeadSource: string | null;
  NextStep: string | null;
  Description: string | null;
  OwnerId: string;
  CreatedDate: string | null;
  LastModifiedDate: string | null;
  Payment_Terms__c: string | null;
  Contract_Start_Date__c: string | null;
  Contract_End_Date__c: string | null;
  Billing_Frequency__c: string | null;
  // Pursuit custom fields
  RenewalRepeat__c: string | null;
  Active_Opportunity__c: boolean | null;
  LastActivityDate: string | null;
  // NPSP payment rollup fields (read-only in Salesforce — formula/rollup)
  npe01__Payments_Made__c: number | null;
  Outstanding_Payments__c: number | null;
  Number_of_Payments_Received__c: number | null;
  Most_Recent_Payment_Date__c: string | null;
  Last_Actual_Payment__c: string | null;
  npe01__Number_of_Payments__c: number | null;
  PaymentDate__c: string | null;
  Earliest_Scheduled_Payment__c: string | null;
  // Campaign (Primary Campaign Source)
  CampaignId: string | null;
  // Record Type — users can reclassify via the Edit Opportunity drawer (BUG-UI-9).
  RecordTypeId: string | null;
  // Nested relationship fields (from SOQL joins)
  Account?: { Name: string; Id?: string };
  Owner?: { Name: string; Id?: string };
  RecordType?: { Name: string };
  Campaign?: { Name: string };
}

export interface SalesforceAccount {
  Id: string;
  Name: string;
  Type: string | null;
  Industry: string | null;
  Phone: string | null;
  Fax: string | null;
  Website: string | null;
  Description: string | null;
  BillingStreet: string | null;
  BillingCity: string | null;
  BillingState: string | null;
  BillingPostalCode: string | null;
  BillingCountry: string | null;
  AnnualRevenue: number | null;
  NumberOfEmployees: number | null;
  AccountSource: string | null;
  OwnerId: string | null;
  ParentId: string | null;
  RecordTypeId: string | null;
  CreatedDate: string | null;
  LastModifiedDate: string | null;
  LastActivityDate: string | null;
  // Pursuit custom
  Account_Tier__c: string | null;
  Active__c: boolean | null;
  Company_Size__c: string | null;
  npsp__Grantmaker__c: boolean | null;
  npsp__Funding_Focus__c: string | null;
  Philanthropy__c: boolean | null;
  Fee_For_Service__c: boolean | null;
  Hiring__c: boolean | null;
  Investment__c: boolean | null;
  Volunteering__c: boolean | null;
  Fellow_Recruitment__c: boolean | null;
  Media_Marketing__c: boolean | null;
  Influence__c: boolean | null;
  Startup__c: boolean | null;
  Organization_Focus_Area_s__c: string | null;
  // NPSP giving rollups (read-only)
  npo02__TotalOppAmount__c: number | null;
  npo02__NumberOfClosedOpps__c: number | null;
  npo02__AverageAmount__c: number | null;
  npo02__LargestAmount__c: number | null;
  npo02__SmallestAmount__c: number | null;
  npo02__FirstCloseDate__c: string | null;
  npo02__LastCloseDate__c: string | null;
  npo02__OppAmountThisYear__c: number | null;
  npo02__OppAmountLastYear__c: number | null;
  npo02__Best_Gift_Year__c: string | null;
  npo02__Best_Gift_Year_Total__c: number | null;
  // Matching gift
  npsp__Matching_Gift_Company__c: boolean | null;
  npsp__Matching_Gift_Percent__c: number | null;
  npsp__Matching_Gift_Amount_Max__c: number | null;
  npsp__Matching_Gift_Amount_Min__c: number | null;
  npsp__Matching_Gift_Annual_Employee_Max__c: number | null;
  npsp__Matching_Gift_Administrator_Name__c: string | null;
  npsp__Matching_Gift_Email__c: string | null;
  npsp__Matching_Gift_Phone__c: string | null;
  npsp__Matching_Gift_Comments__c: string | null;
  npsp__Matching_Gift_Info_Updated__c: string | null;
  npsp__Matching_Gift_Request_Deadline__c: string | null;
  Total_Revenue_Generated__c: number | null;
  // Formula fields (read-only)
  Last_Activity_Date__c: string | null;
  Date_of_First_Pursuit_Hire__c: string | null;
  // Nested relationship fields
  Owner?: { Name: string; Id?: string };
  Parent?: { Name: string; Id?: string };
  RecordType?: { Name: string };
}

export interface SalesforceContact {
  Id: string;
  AccountId: string | null;
  FirstName: string | null;
  LastName: string;
  Name: string | null;
  Salutation: string | null;
  Title: string | null;
  Department: string | null;
  Email: string | null;
  Phone: string | null;
  MobilePhone: string | null;
  MailingStreet: string | null;
  MailingCity: string | null;
  MailingState: string | null;
  MailingPostalCode: string | null;
  MailingCountry: string | null;
  OwnerId: string | null;
  LeadSource: string | null;
  Birthdate: string | null;
  Description: string | null;
  DoNotCall: boolean | null;
  HasOptedOutOfEmail: boolean | null;
  RecordTypeId: string | null;
  CreatedDate: string | null;
  LastModifiedDate: string | null;
  LastActivityDate: string | null;
  // NPSP
  npsp__Primary_Affiliation__c: string | null;
  npsp__Deceased__c: boolean | null;
  npsp__Do_Not_Contact__c: boolean | null;
  npe01__WorkEmail__c: string | null;
  npe01__HomeEmail__c: string | null;
  npe01__AlternateEmail__c: string | null;
  npe01__WorkPhone__c: string | null;
  npe01__PreferredPhone__c: string | null;
  npe01__Preferred_Email__c: string | null;
  npe01__Primary_Address_Type__c: string | null;
  // Pursuit custom
  Preferred_Name__c: string | null;
  Pronouns__c: string | null;
  Gender__c: string | null;
  LinkedIn_URL__c: string | null;
  Philanthropic_Contact__c: boolean | null;
  Philanthropy__c: boolean | null;
  Board_Status__c: string | null;
  Volunteer__c: boolean | null;
  Added_to_Slack__c: boolean | null;
  Last_Touchpoint__c: string | null;
  // Formula fields (read-only)
  Last_Activity_Date__c: string | null;
  Days_Since_Last_Activity__c: number | null;
  Primary_Affiliation_Entity__c: string | null;
  Primary_Affiliation_Name__c: string | null;
  GW_Volunteers__Volunteer_Hours__c: number | null;
  GW_Volunteers__Last_Volunteer_Date__c: string | null;
  // Nested relationship fields
  Account?: { Name: string; Id?: string };
  Owner?: { Name: string; Id?: string };
  RecordType?: { Name: string };
  npsp__Primary_Affiliation__r?: { Name: string };
}

export interface SalesforcePayment {
  Id: string;
  Name: string;
  npe01__Opportunity__c: string | null;
  npe01__Payment_Amount__c: number | null;
  npe01__Scheduled_Date__c: string | null;
  npe01__Payment_Date__c: string | null;
  npe01__Paid__c: boolean | null;
  npe01__Payment_Method__c: string | null;
  npe01__Check_Reference_Number__c: string | null;
  npe01__Written_Off__c: boolean | null;
  Write_off_reason__c: string | null;
  Amount_Received__c: number | null;
  Department__c: string | null;
  GL_Account__c: string | null;
  GL_Payment_Received__c: string | null;
  Reconciled_with_Finance__c: boolean | null;
  Batch_Name__c: string | null;
  Payment_Estimate__c: boolean | null;
  Invoice__c: string | null;
  Affiliation__c: string | null;
  CreatedDate: string | null;
  LastModifiedDate: string | null;
  // Formula fields (read-only)
  Payment_Status__c: string | null;
  Delinquent__c: boolean | null;
  Paid_Status__c: string | null;
  Amount_Formula__c: number | null;
  Amount_Minus_Received__c: number | null;
  // Nested relationship fields
  npe01__Opportunity__r?: { Name: string; Account?: { Name: string } };
}

export interface SalesforceTask {
  Id: string;
  Subject: string;
  Status: string;
  Priority: string;
  ActivityDate: string | null;
  Description: string | null;
  OwnerId: string;
  WhatId: string | null;
  WhoId: string | null;
}
