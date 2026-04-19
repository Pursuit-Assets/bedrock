# Sprint 7.5: Salesforce Field Audit + Edit Dialog Completion

## Context

Sprint 7 built the OpportunityEditDialog with all standard + contract fields. But the Salesforce org likely has custom fields not yet surfaced in Bedrock. This sprint audits the full schema and closes the gap.

## Scope

### 1. Salesforce Schema Describe
- Hit the Salesforce Opportunity `describe()` API to get ALL fields (standard + custom)
- Compare against what we currently fetch in the SOQL query
- Identify fields the team uses in Salesforce that aren't in Bedrock

### 2. Known Gaps (11 fetched but not in dialog)

**Should be editable:**
- `RenewalRepeat__c` — renewal/upsell tracking (used in PriorityTable alerts)
- `Active_Opportunity__c` — active status flag

**Should be read-only (NPSP rollups/formulas):**
- `npe01__Payments_Made__c` — total payments received
- `Outstanding_Payments__c` — outstanding balance
- `Most_Recent_Payment_Date__c` — last payment date
- `Number_of_Payments_Received__c` / `npe01__Number_of_Payments__c` — payment counts
- `Last_Actual_Payment__c` — last payment amount
- `Earliest_Scheduled_Payment__c` — next scheduled payment
- `PaymentDate__c` — first payment date

**Should be read-only (system/metadata):**
- `RecordType.Name` — record type
- `LastActivityDate` — last activity timestamp

### 3. TypeScript Type Update
- Add all surfaced fields to `SalesforceOpportunity` interface in `types/salesforce.ts`

### 4. Edit Dialog Enhancement
- Add a "Payment Summary" read-only section showing NPSP rollup data
- Add `RenewalRepeat__c` and `Active_Opportunity__c` as editable fields
- Add `RecordType.Name` and `LastActivityDate` to the read-only footer
- Surface any additional custom fields discovered in the schema audit

## Prerequisites
- Sprint 7 committed and deployed
- Salesforce API access (OAuth connected)
