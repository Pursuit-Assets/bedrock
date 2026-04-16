# Sprint 8: Universal Object Edit Dialogs (Contact, Account, Payment)

## Context

Sprint 7 builds the Opportunity Edit Dialog as the first full-object editor (+ permission system overhaul with ownership enforcement, `reassign_opportunities` key, Manager profile). This sprint replicates the pattern for the remaining CRM objects: Contact, Account, and Payment. The team constantly switches to Salesforce to edit fields not available in inline editing — these dialogs eliminate that friction.

## Prerequisites

- Sprint 7 complete (OpportunityEditDialog, permission system, ownership enforcement, Manager profile)
- Patterns proven: section layout, permission gating, ConfirmSaveButton, cache lookup

## Scope

### Contact Edit Dialog
- **Trigger**: Click Contact name in Contacts page (currently only has create dialog, no full edit)
- **Fields**: FirstName, LastName, Email, Phone, Title, Department, Primary_Affiliation__c (Autocomplete → Account), AccountId
- **Permission model**: Follows edit_own/edit_all pattern (contacts don't have owners in the same way — may need `edit_contacts` permission or tie to Account ownership)
- **Backend**: Need PUT `/api/salesforce/contacts/{id}` endpoint (may not exist yet — verify)

### Account Edit Dialog
- **Trigger**: Click Account name in Accounts page (currently view-only with tabs)
- **Fields**: Name, Type, Industry, AnnualRevenue, NumberOfEmployees, Phone, Website
- **Permission model**: Likely needs `edit_accounts` permission (Accounts are shared, not individually owned)
- **Backend**: Need PUT `/api/salesforce/accounts/{id}` endpoint (may not exist yet — verify)

### Payment Edit Dialog
- **Trigger**: Click payment row in PaymentTrackingModal or payment schedule views
- **Fields**: Amount, scheduled_date, Status, payment method, notes
- **Backend**: Different from Salesforce — uses Sage Intacct API. Separate service pattern.
- **Note**: May be more complex due to dual-system (Salesforce payment fields + Sage invoices). Plan carefully.

## Design Decisions to Make

1. **Shared field kit**: After building 3 dialogs in Sprint 7+8, should we extract shared components (FieldSection, EditableField, SectionDivider) into a reusable kit? Or keep per-object dialogs self-contained?
2. **Contact ownership model**: Contacts don't have a standard OwnerId in Salesforce NPSP. How should edit permissions work? By Account ownership? By role?
3. **Account edit permissions**: Since Accounts are shared entities, what permission granularity? A simple `edit_accounts` flag?
4. **Payment write-back**: Payments touch both Salesforce (payment fields on Opportunity) and Sage (invoice/payment records). Which system is the source of truth for edits?

## Estimated Effort

- Contact Edit Dialog: ~1 session (similar structure to Opportunity, fewer fields)
- Account Edit Dialog: ~1 session (simpler, no ownership complexity)
- Payment Edit Dialog: ~1-2 sessions (dual-system complexity with Sage)
- Shared component extraction (optional): ~0.5 session

## Dependencies

- Verify PUT endpoints exist for Contacts and Accounts (check `main.py`)
- Verify Sage payment update API is available
- Permission keys may need expansion for Contact/Account editing
