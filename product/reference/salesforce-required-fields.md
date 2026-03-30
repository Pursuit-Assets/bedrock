# Salesforce Required Fields Audit

> **Audited**: 2026-03-30 via live `describe()` against Pursuit's SF org
> **Endpoint used**: `GET /api/salesforce/schema/{sobject}?compare=true`
> **Milestone**: M17 (SF Field Audit + Prospect CRM Mapping)

## Summary

Salesforce `describe()` returns `nillable`, `updateable`, and `calculated` metadata per field. A field is **truly required for user input** when:

- `nillable = false` (cannot be null)
- `updateable = true` (can be set by the user)
- `calculated = false` (not a formula)
- `type != boolean` OR `defaultValue = null` (booleans with defaults auto-resolve)

**Key finding**: The vast majority of "required" fields across all 4 objects are booleans with `default=False`. These auto-default and never need user validation. Only a handful of non-boolean fields are truly required.

## Opportunity

| Field | Label | Type | Required | Validated (edit) | Validated (create) | Notes |
|-------|-------|------|----------|------------------|--------------------|-------|
| `Name` | Name | string | **YES** | **YES** (M17) | YES | |
| `StageName` | Stage | picklist | **YES** | YES (dropdown) | YES (default Lead Gen) | Cannot clear dropdown |
| `CloseDate` | Close Date | date | **YES** | **YES** (M17) | YES | |
| `OwnerId` | Owner ID | reference | **YES** | Auto-populated | YES | Defaults to current user |

**Boolean "required" fields (all have `default=False`, no validation needed):**
IsPrivate, npe01__Do_Not_Automatically_Create_Payment__c, npsp__Is_Grant_Renewal__c, npsp__In_Kind_Donor_Declared_Value__c, Thank_You_Letter__c, Acknowledgement_Letter__c, Paper_Copy_Saved__c, Scanned_to_Box__c, Won_Funding__c, Opportunity_On_Hold__c, Initiate_Payment_Flow__c, Manual_No_Activity__c, ISA_Pause_Reset_or_Schedule_Change__c, Active_Opportunity__c, Duplicate_Mark_for_Deletion__c, Reimbursable__c, Booked_Pledge_By_Finance__c

## Contact

| Field | Label | Type | Required | Validated (edit) | Notes |
|-------|-------|------|----------|------------------|-------|
| `LastName` | Last Name | string | **YES** | YES | Already validated |
| `OwnerId` | Owner ID | reference | **YES** | Auto-populated | |

**Boolean "required" fields (all default=False):**
HasOptedOutOfEmail, HasOptedOutOfFax, DoNotCall, npe01__Private__c, npsp__is_Address_Override__c, GW_Volunteers__Volunteer_Auto_Reminder_Email_Opt_Out__c, npsp__Exclude_from_Household_Formal_Greeting__c, npsp__Exclude_from_Household_Informal_Greeting__c, npsp__Exclude_from_Household_Name__c, npsp__Deceased__c, npsp__Do_Not_Contact__c, Added_to_Slack__c, Free_Or_Reduced_Lunch__c, HS_Diploma_GED_or_equivalent__c, Hiring__c, Investment__c, LevelUp__c, Media_Influence_Marketing__c, NYCHA__c, Philanthropic_Contact__c, Philanthropy__c, Public_Assistance__c, Influence__c, Volunteer__c, X4_Year_Degree__c, Fellow_Recruitment__c, ERF_Recipient__c, Duplicate_Temp_field__c, createdfromapplicationtrigger__c, ISA_Complete__c, Core_Completed__c, Do_Not_Contact__c

## Account

| Field | Label | Type | Required | Validated (edit) | Notes |
|-------|-------|------|----------|------------------|-------|
| `Name` | Account Name | string | **YES** | YES | Already validated |
| `OwnerId` | Owner ID | reference | **YES** | Auto-populated | |

**Boolean "required" fields (all default=False):**
npe01__SYSTEMIsIndividual__c, npsp__Grantmaker__c, npsp__Matching_Gift_Company__c, Fee_For_Service__c, Hiring__c, Investment__c, Media_Marketing__c, Philanthropy__c, Volunteering__c, Fellow_Recruitment__c, Active__c (default=True), Startup__c, Influence__c

## Payment (npe01__OppPayment__c)

| Field | Label | Type | Required | Notes |
|-------|-------|------|----------|-------|
| (none) | — | — | — | No non-boolean required fields |

**Boolean "required" fields (all default=False):**
npe01__Paid__c, npe01__Written_Off__c, ended_job__c, prorated_payment__c, Due_as_of_Today__c, Reconciled_with_Finance__c, Payment_Estimate__c

## Pebble Source Tier Mapping

Which Pebble research tier can populate key optional fields:

| Object | Field | Pebble Tier | Source |
|--------|-------|-------------|--------|
| Contact | FirstName, LastName | T1 | Identity card / name parsing |
| Contact | Title | T1 | Wikipedia infobox, CRM match |
| Contact | Email | T1 | CRM match, web search |
| Contact | Phone | T2 | Enrichment sources |
| Contact | Department | T2 | Affiliations dimension |
| Contact | LinkedIn_URL__c | T2 | Web search |
| Contact | Philanthropic_Contact__c, Philanthropy__c | T3 | Philanthropy forager |
| Account | Name | T1 | Prospect org name |
| Account | Type | T2 | OpenCorporates / Wikipedia |
| Account | Industry | T2 | Wikipedia / web search |
| Account | Website | T2 | Web search / Wikipedia |
| Account | npsp__Grantmaker__c | T3 | ProPublica 990 data |
| Account | Philanthropy__c | T3 | Philanthropy forager |
| Account | npsp__Funding_Focus__c | T3 | ProPublica program descriptions |
| Account | AnnualRevenue | T3 | ProPublica 990 / SEC filings |
| Opportunity | Amount (estimate) | T2 | Giving capacity from FEC/philanthropy |
| Opportunity | Description | T3 | Pebble research summary |

## Reference Table

The `bedrock.sf_field_requirements` table persists this audit data and is used by:
- `get_prospect_crm_readiness()` — checks which required fields are populated vs missing
- Schema drift detection — compares against live describe() to detect changes
- Frontend validation — documents which fields need client-side checks

## Schema Drift Detection

On app startup, the system diffs `describe()` results against `sf_field_requirements`. Changes are logged to `bedrock.sf_schema_drift_log` and flagged for admin review (HITL). No automatic schema changes are applied.
