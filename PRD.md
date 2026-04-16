# Pursuit Grants Management Platform PRD

> **⚠ HISTORICAL CONTEXT — Partially Superseded (March 2026 + April 2026)**
>
> This PRD was the original spec for Phase 1 (Nov 2025). It remains valuable for:
> - Problem statement, user needs, and success metrics (still accurate)
> - Implementation checklist status (reflects what shipped)
>
> **The following sections have been superseded:**
> - **Stage names:** This doc uses old Salesforce stages (Lead Gen, Qualifying, etc.). Live SF org now has 22 distinct StageName values (verified 2026-04-14). Canonical Bedrock-future stages in `product/crm-architecture/canonical-definitions.md` §1; live SF stage drift + bucket-vocabulary fix plan in `tasks/stage-schema-drift.md` + `tasks/f1-stage-buckets-plan.md` (2026-04-16).
> - **Data model:** Entity definitions, field names, and relationships are now canonical in `product/crm-architecture/entity-map.md`.
> - **Payment fields:** NPSP field references here are mapped to Bedrock fields in `product/crm-architecture/integration-register.md` (Salesforce Field Mapping section).
> - **Phase 2/3 roadmap:** Multi-invoice, smart completion, amendments, variance handling, Sage payment sync, advanced reporting, workflow automation — captured in `tasks/finance-phase-2-3-roadmap.md`.
>
> When in doubt, the `product/crm-architecture/` docs and `tasks/f1-stage-buckets-plan.md` govern.

**Project:** Grants Management Platform (Phase 1: Partnerships Pipeline)
**Owner:** Jac
**Date:** November 9, 2025
**Last Updated:** November 9, 2025 (banner refreshed 2026-04-16; core content unchanged)

---

## Problem

Pursuit's grant management and finance systems are disconnected, resulting in poor data quality and limited financial visibility. The partnerships team doesn't maintain an accurate pipeline in Salesforce—close dates routinely slip by months and confidence levels are unreliable. For closed grants, there's no systematized way to track which payments have actually been received.

The bookkeeper operates in a silo, manually creating invoices based on word-of-mouth information with no connection to Salesforce records. Finance data exists as a black box, accessible only through ad-hoc manual updates. The partnerships team lacks trustworthy finance data, while the bookkeeper has no reliable pipeline projections or payment schedules.

Salesforce and Sage Intacct operate as completely separate systems with no integration. This disconnect forces the finance and partnerships teams to collectively spend over 80 hours per month manually tracking and forecasting cash flows. Millions of dollars in outstanding revenue remain untracked in any organized way. The new CEO cannot get reliable visibility into the organization's financial state.

**Supporting Context:**
- Finance and partnerships teams collectively spend over 80 hours per month tracking and attempting to forecast cash flows
- Millions of dollars of outstanding revenue are not being tracked in an organized way
- New CEO needs immediate visibility into financial state but cannot get it with current systems

---

## Opportunity

Enable Pursuit's CEO and leadership to have real-time visibility into the organization's financial pipeline and cash flow projections, while reducing manual data entry burden on partnerships and finance teams.

---

## Users & Needs

### Primary users:
- 4 Partnerships ICs managing grant opportunities
- 1 Bookkeeper managing invoicing and payments (Phase 2)
- CEO monitoring financial state

### Secondary users:
- Potentially other executives/leadership who need pipeline visibility

### Key user needs:

#### Partnerships ICs:
- As a partnerships IC, I need to quickly create and update grant opportunities without navigating Salesforce's complex UI, because the current system is too cumbersome and discourages regular updates
- As a partnerships IC, I need to see all my opportunities and my team's pipeline in one place, because I need context on our overall capacity and relationships with funders
- As a partnerships IC, I need to be reminded when opportunities are stale or close dates are approaching, because it's easy to lose track across multiple active grants
- As a partnerships IC, I need to track payment schedules for multi-year grants, because funders have different payment structures and I need to set accurate expectations

#### CEO:
- As CEO, I need real-time visibility into total pipeline value and weighted projections, because I need to understand our financial runway and make strategic decisions
- As CEO, I need to see projected cash flow by quarter, because I need to plan organizational capacity and hiring
- As CEO, I need to drill into individual deals when needed, because high-level metrics sometimes require investigating specific opportunities

#### Bookkeeper (Phase 2):
- As a bookkeeper, I need to create invoices that are automatically linked to Salesforce opportunities, because manual invoice creation from word-of-mouth leads to errors and disconnected data
- As a bookkeeper, I need to track which payments have been received against the expected payment schedule, because I need to know what's outstanding and what's overdue

---

## Proposed Solution

Build a custom AI-powered grants management platform that sits on top of Salesforce and Sage Intacct, providing a simplified interface for partnerships team to manage their pipeline and for finance to track payments. The platform eliminates the need to directly use Salesforce's complex UI by offering a purpose-built experience with only essential fields, AI-assisted data entry for payment schedules, and automatic real-time syncing to both systems. An executive dashboard provides the CEO with live visibility into pipeline value, cash flow projections, and deal health metrics. Phase 1 focuses on partnerships pipeline management, with Phase 2 adding bookkeeper invoicing and payment tracking once Sage Intacct integration is available.

### Top 3 MVP Value Props:

**[The Vitamin] - The must-have that maintains status quo**  
Real-time pipeline visibility and cash flow forecasting that replaces 80 hours/month of manual tracking, ensuring CEO always has current financial state

**[The Painkiller] - Solves the biggest pain point**  
Simple, purpose-built UI with only 9 essential opportunity fields (vs 50+ in Salesforce) and AI-assisted payment schedule entry, eliminating the friction that prevents partnerships team from keeping data current

**[The Steroid] - The magic moment that delights**  
Automatic context aggregation from across Pursuit's systems (Slack notifications, Gmail threads, Fireflies meeting transcripts, Google Drive documents) that surfaces in one place, so partnerships never has to hunt for information or manually log updates

---

## Goals & Non-Goals

### Goals:
- Provide CEO with real-time visibility into grant pipeline and cash flow projections
- Reduce time spent on manual pipeline tracking and forecasting from 80 hours/month
- Ensure partnerships team maintains high-quality, up-to-date opportunity data (90%+ complete, updated within 24 hours of stage changes)
- Simplify grant management workflow by replacing complex Salesforce UI with purpose-built platform
- Create single source of truth connecting Salesforce (pipeline) and Sage Intacct (payments)

### Non-Goals (Phase 1):
- Bookkeeper invoicing and payment tracking workflows (Phase 2)
- Automated note capture from Fireflies, Gmail, Google Drive, or Slack (P1 post-MVP)
- AI-generated summaries of Google Doc notes (P1 post-MVP)
- Program/budget alignment tracking
- Grant reporting requirements tracking
- Document storage/management (we're linking to docs, not hosting them)

---

## Success Metrics

| Goal | Signal | Metric | Target |
|------|--------|--------|--------|
| Adoption | Partnerships team actively uses platform | % of opportunities updated within 24 hours of stage change | 100% |
| Data Quality | Opportunity data is complete and accurate | % of opportunities with all required fields complete | 90% |
| CEO Visibility | CEO can self-serve financial insights | CEO accesses dashboard without requesting manual reports | Weekly access |
| Time Savings | Reduced manual tracking burden | Hours spent per month on pipeline tracking/forecasting | <40 hours (50% reduction from 80) |

---

## Requirements

**Legend:**
- **[P0]** = MVP for Phase 1 launch
- **[P1]** = Important for delightful experience, post-MVP
- **[P2]** = Nice-to-have, future consideration

---

## User Journey 1: Partnerships IC - Creating and Managing Opportunities

**Context:** Partnerships team members need to easily create and update grant opportunities without the complexity of Salesforce's overwhelming field structure. The platform must capture essential information while being simple enough to ensure consistent adoption and data quality.

### Creating New Opportunities, Accounts, and Contacts

- [x] **[P0]** User can create a new opportunity with required fields:
  - [x] Opportunity name
  - [x] Account (funder)
  - [x] Primary contact
  - [x] Amount
  - [x] Close date
  - [x] Stage
  - [x] Probability (auto-assigned based on stage, with manual override capability)
  - [x] Opportunity owner
- [x] **[P0]** User can search for and select existing accounts when creating an opportunity
- [x] **[P0]** User can create a new account if it doesn't exist, with fields:
  - [x] Account name
  - [x] Type (Foundation/Corporate/Government dropdown)
  - [x] Website
  - [x] Phone (added)
- [x] **[P0]** User can search for and select existing contacts when creating an opportunity
- [x] **[P0]** User can create a new contact if it doesn't exist, with fields:
  - [x] First Name
  - [x] Last Name
  - [x] Account
  - [x] Primary affiliation
  - [x] Title
  - [x] Email
  - [x] Phone
- [x] **[P0]** User can view all contacts associated with an account
- [x] **[P0]** System validates that all required fields are completed before saving an opportunity

### Entering Payment Schedules

- [ ] **[P0]** User can enter payment schedule information in natural language (e.g., "$300K total, $100K per year for 3 years starting January 2026")
- [ ] **[P0]** AI parses natural language into structured payment schedule table with columns:
  - [ ] Payment date
  - [ ] Amount
  - [ ] Status (Expected/Received - status will be editable in Phase 2)
- [ ] **[P0]** User reviews and confirms/edits the AI-generated payment schedule before saving
- [ ] **[P0]** User can manually add, edit, or delete individual payment schedule rows
- [ ] **[P0]** Payment schedule is not required until opportunity reaches "Design / Proposal Creation" stage
- [ ] **[P0]** System validates that payment schedule is entered once opportunity moves to or past "Design / Proposal Creation" stage

### Updating Opportunities

- [x] **[P0]** User can update any opportunity field at any time
- [x] **[P0]** User can change opportunity stage via dropdown with these options:
  - **Open Pipeline Stages (actively pursuing):**
    - [x] Lead Gen
    - [x] New Lead
    - [x] Qualifying
    - [x] Design / Proposal Creation
    - [x] Proposal Negotiation
    - [x] Contract Creation
    - [x] Negotiating Contract
  - **Closed Won / Collection Stages:**
    - [x] Collecting / In Effect
    - [x] Closed / Completed
  - **Closed Lost Stages:**
    - [x] Closed / Did not Fulfill
    - [x] Closed Lost
- [x] **[P0]** When user changes stage, probability auto-updates based on stage mapping (with ability to manually override)
- [x] **[P0]** System timestamps all updates for audit trail
- [x] **[P0]** All updates sync to Salesforce in real-time

### Linking Documents

- [ ] **[P0]** User can add link to Google Doc for notes (supports multiple doc links)
- [ ] **[P0]** User can add link to submitted proposal document (single link only)
- [ ] **[P0]** User can add links to reporting documents (supports multiple doc links)
- [ ] **[P0]** Clicking document links opens in new tab
- [ ] **[P1]** System displays AI-generated summary of latest updates from linked Google Docs for notes

---

## User Journey 2: Partnerships IC - Monitoring Their Pipeline

**Context:** Partnerships team needs multiple views into their work - tracking their own opportunities, understanding team capacity, and viewing complete funder relationship history. The platform must surface stale opportunities requiring attention to maintain data quality.

### Individual Pipeline View

- [x] **[P0]** User can view all opportunities they own in a list/table view
- [x] **[P0]** User can filter opportunities by:
  - [x] Stage
  - [x] Close date range
  - [x] Amount range
  - [x] Account
- [x] **[P0]** User can sort opportunities by:
  - [x] Close date
  - [x] Amount
  - [x] Stage
  - [x] Last modified date
- [x] **[P0]** User can search opportunities by name or account name
- [x] **[P0]** List view displays key fields: Opportunity name, Account, Amount, Close date, Stage, Probability
- [x] **[P0]** User can click into any opportunity to view full details

### Team Pipeline View

- [x] **[P0]** User can view all team opportunities (across all 4 ICs) in a list/table view
- [x] **[P0]** Team view includes all same filtering, sorting, and search capabilities as individual view
- [x] **[P0]** Team view displays opportunity owner column

### Account History View

- [x] **[P0]** User can view all opportunities associated with a specific account (current and historical)
- [x] **[P0]** User can view all contacts associated with a specific account
- [x] **[P0]** User can see account details (name, type, website, primary contact)
- [x] **[P0]** Account view displays timeline of all opportunities with that funder, sorted by create date

### Stale Opportunity Alerts

- [ ] **[P0]** System flags opportunities as "stale" if:
  - [ ] Close date has passed but opportunity is not marked as closed (Closed/Did not Fulfill, Closed/Completed, or Closed Lost)
  - [ ] Opportunity has been in the same stage for 30+ days
- [ ] **[P0]** Stale opportunities display visual banner/badge on the opportunity detail page
- [ ] **[P0]** Dashboard includes filtered view showing "Opportunities requiring attention" (all stale opportunities)
- [ ] **[P0]** Stale opportunities count displays prominently on main dashboard

### Close Date Notifications

- [ ] **[P0]** System sends Slack notification to opportunity owner 7 days before close date
- [ ] **[P0]** System sends Slack notification to opportunity owner on the day of close date
- [ ] **[P0]** Notifications include: Opportunity name, Account, Amount, Current stage

---

## User Journey 3: CEO - Understanding Financial State

**Context:** CEO needs immediate visibility into the organization's financial position without relying on manual reports from finance or partnerships. Executive dashboard must provide both high-level metrics and ability to drill into deal details.

### Executive Dashboard - High-Level Metrics

**Note:** "Open pipeline" refers only to opportunities in active pursuit stages: Lead Gen, New Lead, Qualifying, Design / Proposal Creation, Proposal Negotiation, Contract Creation, and Negotiating Contract. Closed won, collecting, and closed lost opportunities are excluded from pipeline calculations.

- [x] **[P0]** CEO can view total pipeline value (sum of all open opportunities)
- [x] **[P0]** CEO can view weighted pipeline value (sum of all open opportunities × their probability)
- [x] **[P0]** CEO can view pipeline breakdown by stage with:
  - [x] Number of opportunities in each stage
  - [x] Total $ amount in each stage
  - [x] Weighted $ amount in each stage (factored by probability)
- [x] **[P0]** CEO can view projected cash flow by quarter, based on:
  - [x] Expected close dates
  - [x] Payment schedules
  - [x] Probability-weighted amounts
- [x] **[P0]** CEO can view projected cash flow by year
- [x] **[P0]** CEO can view current quarter metrics:
  - [x] Total $ expected to close this quarter
  - [x] Number of deals expected to close
  - [x] Deals at risk of slipping (close date in current quarter but in early stages)
- [x] **[P0]** CEO can view win rate metric:
  - [x] % of opportunities that reached Closed/Completed vs Closed Lost (trailing 12 months)
- [x] **[P0]** CEO can view average deal size (across all open opportunities)
- [x] **[P0]** Dashboard updates in real-time as opportunities are updated
- [ ] **[P1]** CEO can view year-over-year comparison metrics
- [ ] **[P1]** CEO can view pipeline by funding source type (Foundation/Corporate/Government)

### Drill-Down Capabilities

- [x] **[P0]** CEO can click on any metric to see underlying opportunities
- [x] **[P0]** CEO can click into individual opportunity details to see:
  - [x] All opportunity fields
  - [x] Payment schedule
  - [ ] Linked documents
  - [x] Last updated timestamp
- [x] **[P0]** CEO can view list of all opportunities with same filtering/sorting capabilities as partnerships team
- [x] **[P0]** CEO has read-only access (cannot edit opportunities, accounts, or contacts)

---

## User Journey 4: Bookkeeper - Managing Invoicing and Payment Tracking (Phase 2)

**Context:** Once Sage Intacct developer license is available, the bookkeeper needs to create invoices tied to closed grant opportunities and track which payments have actually been received. This eliminates manual invoice creation via word-of-mouth and connects finance data back to the Salesforce pipeline.

### Invoice Creation

- [ ] **[P1]** Bookkeeper can view all opportunities in "Collecting / In Effect" stage that need invoicing
- [ ] **[P1]** Bookkeeper can create an invoice in Sage Intacct directly from an opportunity
- [ ] **[P1]** Invoice automatically pulls data from opportunity:
  - [ ] Account name (bill to)
  - [ ] Primary contact information
  - [ ] Total amount
  - [ ] Payment schedule breakdown
- [ ] **[P1]** Invoice is automatically linked back to the Salesforce opportunity record
- [ ] **[P1]** Bookkeeper can edit invoice details before finalizing in Sage Intacct
- [ ] **[P1]** System validates that invoice total matches opportunity amount

### Payment Tracking

- [ ] **[P1]** Bookkeeper can view all expected payments from payment schedules across all opportunities in "Collecting / In Effect" stage
- [ ] **[P1]** Bookkeeper can mark individual payments as "Received" when payment comes in
- [ ] **[P1]** When payment is marked as received in platform, it updates:
  - [ ] Payment schedule status in Salesforce
  - [ ] Associated invoice status in Sage Intacct
- [ ] **[P1]** Bookkeeper can view overdue payments (expected payment date has passed but not marked as received)
- [ ] **[P1]** Bookkeeper receives notification for payments that are 7+ days overdue
- [ ] **[P1]** Payment status updates sync to both Salesforce and Sage Intacct in real-time

### Payment Dashboard

- [ ] **[P1]** Bookkeeper can view dashboard showing:
  - [ ] Total outstanding receivables (expected but not received)
  - [ ] Payments received this month vs expected
  - [ ] Overdue payments by account
  - [ ] Upcoming payments in next 30 days
- [ ] **[P1]** Bookkeeper can filter payment view by:
  - [ ] Account
  - [ ] Date range
  - [ ] Status (Expected/Received/Overdue)
- [ ] **[P1]** CEO has read-only access to bookkeeper's payment dashboard for cash flow visibility

---

## User Journey 5: Complete Grant Lifecycle - From Opportunity to Payment (NEW)

**Context:** The complete workflow connects partnerships' opportunity management with finance's invoice and payment tracking, creating a seamless handoff and automated stage transitions based on payment status.

### Workflow Overview

```
1. Partnerships: Create opportunity → Link account & contact
2. Partnerships: Update through pipeline stages
3. System: When "Closed Won" → Prompt for payment schedule
4. Finance: View new closed opportunities awaiting invoices
5. Finance: Create invoice in Sage Intacct → Auto-move to "Collecting / In Effect"
6. Finance: Track payments as received
7. System: When all payments received → Auto-move to "Closed / Completed"
```

### 1. Payment Schedule on Closed Won

- [ ] **[P0]** When opportunity stage changes to "Closed Won", system automatically opens payment schedule modal
- [ ] **[P0]** User enters payment schedule in natural language (e.g., "3 payments of $100k each, quarterly starting Jan 2026")
- [ ] **[P0]** AI parses natural language into structured table with columns:
  - [ ] Payment Date
  - [ ] Amount
  - [ ] Status (defaults to "Scheduled")
- [ ] **[P0]** User can review and edit generated schedule:
  - [ ] Edit individual payment dates and amounts
  - [ ] Add or delete payment rows
  - [ ] Manual entry if AI parsing fails
- [ ] **[P0]** System validates:
  - [ ] Total of all payments matches opportunity amount
  - [ ] All payment dates are in the future (or reasonable past)
  - [ ] At least one payment is entered
- [ ] **[P0]** Payment schedule saves to Salesforce NPSP Payment records
- [ ] **[P0]** User can skip and add payment schedule later from opportunity detail page
- [ ] **[P0]** Payment schedule displays on opportunity detail page for all users

### 2. Finance Dashboard - Awaiting Invoices

- [ ] **[P0]** Finance team can access dedicated "Finance Dashboard" from main navigation
- [ ] **[P0]** Dashboard shows three tabs:
  - [ ] "Awaiting Invoice" - Closed Won opportunities that need invoicing
  - [ ] "Active Collections" - Opportunities in Collecting/In Effect stage
  - [ ] "Completed" - Opportunities in Closed/Completed stage
- [ ] **[P0]** "Awaiting Invoice" tab displays:
  - [ ] Opportunity name
  - [ ] Account name
  - [ ] Total amount
  - [ ] Close date
  - [ ] Payment schedule summary (e.g., "3 payments, first due 01/15/2026")
  - [ ] "Create Invoice" button
- [ ] **[P0]** Each opportunity card shows payment schedule details when expanded
- [ ] **[P0]** Finance can filter by:
  - [ ] Date range (when opportunity was closed)
  - [ ] Amount range
  - [ ] Account
- [ ] **[P0]** Finance can sort by:
  - [ ] Close date
  - [ ] Amount
  - [ ] First payment due date

### 3. Invoice Creation in Sage Intacct

- [ ] **[P0]** Finance clicks "Create Invoice" button on opportunity
- [ ] **[P0]** Modal opens pre-filled with opportunity data:
  - [ ] Customer name (from Account)
  - [ ] Contact email (from Primary Contact)
  - [ ] Invoice amount
  - [ ] Payment schedule breakdown
  - [ ] Invoice date (defaults to today)
  - [ ] Due date (defaults to first payment due date)
  - [ ] Description (defaults to opportunity name)
- [ ] **[P0]** Finance can edit invoice details before creating
- [ ] **[P0]** System validates invoice data before submission
- [ ] **[P0]** On "Confirm & Create":
  - [ ] Create invoice in Sage Intacct via API
  - [ ] Store Sage invoice ID in Salesforce custom field `Sage_Invoice_ID__c`
  - [ ] Create `Grant_Invoice__c` junction record linking opportunity to invoice
  - [ ] Automatically update opportunity stage to "Collecting / In Effect"
  - [ ] Set `Invoice_Created_Date__c` custom field
- [ ] **[P0]** Success message displays with Sage invoice ID and link
- [ ] **[P0]** If invoice creation fails, show detailed error message and don't update opportunity stage
- [ ] **[P0]** Invoice creation action is logged in opportunity history

### 4. Payment Tracking - Active Collections

- [ ] **[P0]** "Active Collections" tab shows all opportunities in "Collecting / In Effect" stage
- [ ] **[P0]** Each opportunity displays:
  - [ ] Opportunity name and account
  - [ ] Total amount and amount received
  - [ ] Progress bar showing payment completion (e.g., "2 of 3 payments received")
  - [ ] Sage invoice ID with link to Sage Intacct
  - [ ] Payment schedule with status for each payment
  - [ ] "Track Payments" button/link
- [ ] **[P0]** Payment schedule shows each payment with:
  - [ ] Due date
  - [ ] Amount
  - [ ] Status: "Scheduled" (gray) | "Received" (green) | "Overdue" (red)
  - [ ] Action button: "Mark Received" for scheduled/overdue payments
- [ ] **[P0]** Overdue status applies when:
  - [ ] Payment due date has passed
  - [ ] Payment has not been marked as received
- [ ] **[P0]** Finance clicks "Mark Received" on a payment
- [ ] **[P0]** Confirmation modal opens with fields:
  - [ ] Received date (defaults to today)
  - [ ] Received amount (defaults to scheduled amount, editable)
  - [ ] Payment method (dropdown: Wire Transfer, Check, ACH, Credit Card, Other)
  - [ ] Notes (optional)
- [ ] **[P0]** On confirmation:
  - [ ] Update NPSP Payment record: set `npe01__Paid__c = true`
  - [ ] Set `npe01__Payment_Date__c` to received date
  - [ ] Set `npe01__Payment_Method__c`
  - [ ] Update payment status in Sage Intacct (if supported by API)
  - [ ] Recalculate opportunity payment totals
  - [ ] Show success message
- [ ] **[P0]** Payment schedule updates in real-time to show "Received" status

### 5. Auto-Complete on Full Payment

- [ ] **[P0]** When finance marks the final payment as received:
  - [ ] System checks if all payments in schedule are marked "Received"
  - [ ] If all received, automatically update opportunity stage to "Closed / Completed"
  - [ ] Show success notification: "All payments received! Opportunity marked as complete."
  - [ ] Log stage change in opportunity history
  - [ ] Send Slack notification to opportunity owner
- [ ] **[P0]** Opportunity appears in "Completed" tab of Finance Dashboard
- [ ] **[P0]** Opportunity no longer appears in "Active Collections" tab
- [ ] **[P0]** Partnerships team sees opportunity in "Closed / Completed" stage
- [ ] **[P0]** Executive dashboard reflects completed opportunity in metrics

### 6. Manual Stage Override

- [ ] **[P0]** Partnerships team can still manually change opportunity stage at any time
- [ ] **[P0]** If stage is manually changed away from "Collecting / In Effect", payment tracking remains available but doesn't auto-update stage
- [ ] **[P0]** Finance can manually move opportunity to "Closed / Completed" even if not all payments received (for exceptions)

### 7. Payment Dashboard Metrics

- [ ] **[P0]** Finance Dashboard header shows summary metrics:
  - [ ] Total outstanding receivables (sum of unpaid scheduled payments)
  - [ ] Payments due this month (count and amount)
  - [ ] Overdue payments (count and amount)
  - [ ] Payments received this month (count and amount)
- [ ] **[P0]** Metrics update in real-time as payments are marked received
- [ ] **[P0]** CEO has read-only access to Finance Dashboard

---

## Implementation Status

### ✅ Completed Features

**Core Infrastructure:**
- [x] FastAPI backend with Salesforce integration
- [x] React + TypeScript frontend with Material-UI
- [x] Real-time data sync between frontend and Salesforce
- [x] MCP Client architecture for multi-service integration

**Opportunities Management:**
- [x] View all opportunities with filtering, sorting, and searching
- [x] Inline editing of opportunity fields (Amount, Close Date, Stage, Probability, Owner, Account)
- [x] Sales Pipeline view (open opportunities)
- [x] Payment Tracking view (closed opportunities with payment data)
- [x] Display of NPSP payment fields (Payments Made, Outstanding, Number of Payments)
- [x] Searchable dropdowns for Owner and Account fields
- [x] Pagination for large datasets (6,016+ opportunities)

**Accounts Management:**
- [x] View all accounts with summary metrics
- [x] Account detail view with opportunity history
- [x] Tabs for All Opportunities, Open Pipeline, and Won/Collecting
- [x] Metrics: Total Opps, Open, Won, Total Value, Received, Outstanding
- [x] Create new accounts with Name, Type, Website, Phone
- [x] View contacts associated with each account (Contacts tab)

**Contacts Management:**
- [x] View contacts for each account
- [x] Create new contacts with Name, Title, Email, Phone, Primary Affiliation
- [x] Associate contacts with accounts
- [x] Search and select contacts when creating opportunities

**Executive Dashboard:**
- [x] Total pipeline value and weighted pipeline
- [x] Pipeline breakdown by stage
- [x] Projected cash flow by quarter and year
- [x] Current quarter metrics
- [x] Average deal size
- [x] Real-time updates

**Slack Integration:**
- [x] Slack bot integration (MCP Client Bot)
- [x] Search messages by account name (direct mentions)
- [x] Search by channel context (dedicated account channels)
- [x] Display message history (up to 500 messages per channel)
- [x] Visual badges for match type (Mentioned vs Dedicated Channel)
- [x] Links to view messages in Slack
- [x] Slack Activity tab in Account detail view

### 🚧 In Progress

None currently

### 📋 Next Up (P0 - MVP)

**Creating & Managing:**
- [x] Create new opportunity flow
- [x] Create new account flow
- [x] Create new contact flow
- [x] Contact management (view contacts per account)
- [x] Primary contact field on opportunities
- [ ] Document linking (Google Docs, proposals, reports)

**Payment Schedules:**
- [ ] Natural language payment schedule entry
- [ ] AI parsing of payment schedule text
- [ ] Manual payment schedule editor
- [ ] Payment schedule validation by stage

**Stale Opportunity Detection:**
- [x] Flag opportunities with passed close dates
- [x] Flag opportunities in same stage for 30+ days
- [ ] Visual indicators on opportunity cards
- [x] "Needs Attention" dashboard view

**Notifications:**
- [ ] Slack notifications 7 days before close date
- [ ] Slack notifications on close date
- [ ] Notification content (name, account, amount, stage)

**Dashboard Enhancements:**
- [x] Win rate metric (12-month trailing)
- [x] Deals at risk indicator
- [ ] Linked documents display in opportunity detail

### 📅 Future (P1 - Post-MVP)

**Phase 2 - Bookkeeper Workflows:**
- [ ] Sage Intacct integration (awaiting developer license)
- [ ] Invoice creation from opportunities
- [ ] Payment received tracking
- [ ] Overdue payment notifications
- [ ] Bookkeeper payment dashboard

**AI & Automation:**
- [ ] AI-generated summaries of Google Doc notes
- [ ] Automated note capture from Fireflies
- [ ] Gmail thread integration
- [ ] Google Drive document indexing

**Analytics:**
- [ ] Year-over-year comparison metrics
- [ ] Pipeline by funding source type
- [ ] Advanced forecasting models

---

## Appendix

- **Designs:** [To be added]
- **Meeting notes:** [To be added]
- **Other resources:** 
  - GitHub Repository: https://github.com/jacrev-pursuit/pursuit-financial-forecasting
  - Salesforce Instance: Pursuit (jac@pursuit.org)
  - Slack Workspace: Pursuit (MCP Client Bot)

---

**Change Log:**
- 2025-11-09: Initial PRD created
- 2025-11-09: Updated with current implementation status and completed features
- 2025-11-09: Added account and contact creation features - users can now create new accounts and contacts inline when creating opportunities, and view all contacts associated with an account
- 2025-11-13: Added complete grant lifecycle workflow from opportunity creation to payment completion, including payment schedule management, finance dashboard, invoice creation in Sage Intacct, and automated stage transitions based on payment status

