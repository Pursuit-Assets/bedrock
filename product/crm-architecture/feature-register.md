# Pursuit CRM (Bedrock) — Feature Inventory & Prioritization

> Phase 5 Deliverable | Version: 1.0 | Date: 2026-03-15
>
> Companion to: `product/crm-scope-constitution.md`, `product/crm-architecture/user-journey-matrix.md`

---

## Prioritization Key

| Phase | Meaning |
|-------|---------|
| **MVP** | Must ship for Bedrock to be usable. Serves core jobs 1–5 from Scope Constitution. |
| **Post-MVP** | High value but not blocking initial adoption. Ship within 3 months of MVP. |
| **Backlog** | Nice to have. Not scheduled. Requires justification against Scope Constitution to promote. |

---

## Feature Register

### Pipeline & Opportunity Management

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F01 | **Create/edit Opportunity** (simplified form, 9 fields) | Partnerships IC | Opportunity, Account, Contact | Both | MVP | F03, F04 |
| F02 | **Pipeline view** (filterable by stage, IC, stream, date range) | Partnerships IC, Executive | Opportunity | Both | MVP | F01 |
| F03 | **Account management** (search, create, edit, org hierarchy) | Partnerships IC | Account | Both | MVP | — |
| F04 | **Contact management** (search, create, edit, link to Accounts) | Partnerships IC | Contact, ContactAccount | Both | MVP | F03 |
| F05 | **Opportunity stage progression** (auto-probability, stage history) | Partnerships IC | Opportunity | Both | MVP | F01 |
| F06 | **Stale opportunity detection** (flag if close date passed or same stage 30+ days) | Partnerships IC, Executive | Opportunity | Both | MVP | F01 |
| F07 | **Kanban pipeline view** (drag-and-drop stage changes) | Partnerships IC | Opportunity | Both | Post-MVP | F01, F05 |
| F08 | **Bulk opportunity actions** (mass stage update, reassign) | Admin | Opportunity | Both | Backlog | F01 |

### Weekly Priorities & Task Management

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F09 | **Weekly priorities view** (next 7 days: deadlines, tasks, follow-ups) | Partnerships IC | Task, Opportunity | Both | MVP | F01, F12 |
| F10 | **CSV prospect import** (upload, map columns, validate, create Contacts) | Partnerships IC | Contact | N/A | MVP | F04 |
| F11 | **Prospect-to-grant assignment** (link imported prospect to Opportunity) | Partnerships IC | Contact, Opportunity | Both | MVP | F10, F01 |
| F12 | **Task CRUD** (create, assign, due date, link to Opp/Lead) | Partnerships IC | Task | Both | MVP | — |
| F13 | **Task notifications** (due today, overdue) | Partnerships IC | Task | Both | Post-MVP | F12 |

### Lead & Prospect Management

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F14 | **Lead tracker** (list, filter by status/source/score) | Partnerships IC | Lead, Contact | N/A | Post-MVP | F04 |
| F15 | **Lead → Opportunity conversion** | Partnerships IC | Lead, Opportunity | Both | Post-MVP | F14, F01 |
| F16 | **Network search** (LinkedIn CSV × prospect list fuzzy match) | Partnerships IC | NetworkMatch, Contact | N/A | Post-MVP | F04, F10 |
| F17 | **Prospect scoring** (composite score from wealth tier, network, engagement) | Partnerships IC | Contact, NetworkMatch | N/A | Post-MVP | F16 |
| F18 | **AI prospect intelligence** (Claude API enrichment) | Partnerships IC | Contact, Lead | N/A | Backlog | F17, Integration #7 |

### Reporting & Dashboards

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F19 | **Executive dashboard** (total pipeline, weighted pipeline, cash flow by quarter) | Executive | Opportunity, Payment | Both | MVP | F01 |
| F20 | **Cash flow projection** (weighted pipeline + scheduled payments + received) | Executive, Finance | Opportunity, Payment | Both | MVP | F01, F22 |
| F21 | **Revenue by stream report** (nonprofit vs. PBC breakdown) | Executive | Opportunity | Both | MVP | F01 |
| F22 | **Win rate & deal metrics** (trailing 12-month, by IC, by Account) | Executive | Opportunity | Both | Post-MVP | F01 |
| F23 | **Campaign performance report** (goal vs. pipeline vs. closed vs. received) | Executive, Partnerships IC | Campaign, Opportunity, Payment | Both | Post-MVP | F27, F01 |
| F24 | **Concentration risk alert** (>30% from single Account) | Executive | Opportunity, Account | Both | Post-MVP | F19 |
| F25 | **CSV export** (any report → CSV download) | All | N/A | Both | MVP | F19 |
| F26 | **Custom report filters** (pre-built prompts + filter combos) | Executive, Partnerships IC | Various | Both | Backlog | F19 |

### Payments & Finance

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F27 | **Payment schedule creation** (milestone or recurring, linked to Opportunity) | Partnerships IC, Finance | Payment, Opportunity | Both | Post-MVP | F01 |
| F28 | **Payment tracking** (status updates: scheduled → invoiced → received → overdue) | Finance | Payment | Both | Post-MVP | F27 |
| F29 | **Sage invoice creation** (push Payment to Sage as invoice) | Finance | Payment | Both | Post-MVP | F27, Integration #2 |
| F30 | **Sage payment reconciliation** (match Sage receipt to Bedrock Payment) | Finance | Payment | Both | Post-MVP | F29, Integration #2 |
| F31 | **Overdue payment alerts** | Finance, Executive | Payment | Both | Post-MVP | F28 |

### Campaign Management

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F32 | **Campaign CRUD** (create, set goal, dates, assigned_to) | Partnerships IC | Campaign | Both | Post-MVP | — |
| F33 | **Campaign ↔ Opportunity linking** | Partnerships IC | Campaign, CampaignOpportunity, Opportunity | Both | Post-MVP | F32, F01 |

### Activity & Interaction Logging

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F34 | **Manual activity logging** (call, email, meeting, note) | Partnerships IC | Activity | Both | MVP | F04 |
| F35 | **Slack activity ingest** (MCP bot → review queue → Activity) | Partnerships IC | Activity | Both | Post-MVP | F34, Integration #3 |
| F36 | **Activity timeline** (chronological view per Contact or Opportunity) | Partnerships IC | Activity | Both | MVP | F34 |
| F37 | **Meeting transcript pipeline** (Fireflies → structured summary) | Partnerships IC | Activity | Both | Backlog | F34, Integration #7 |

### Integration & Sync

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F38 | **Salesforce bidirectional sync** (Opportunity, Account, Contact) | Admin | Opportunity, Account, Contact | Both | MVP | Integration #1 |
| F39 | **Sage Intacct integration** (invoice push, payment pull) | Admin, Finance | Payment | Both | Post-MVP | Integration #2 |
| F40 | **Sync status dashboard** (last sync, errors, retry) | Admin | N/A | Both | Post-MVP | F38 |
| F41 | **Google Calendar sync** (meeting → task/activity suggestions) | Partnerships IC | Task, Activity | Both | Backlog | Integration #6 |

### User & Access Management

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F42 | **Role-based access control** (IC, Executive, Finance, Program, Admin) | Admin | User | Both | MVP | — |
| F43 | **Data visibility rules** (ICs see own + team; Executive sees all; Finance sees payments) | Admin | User | Both | Post-MVP | F42 |

### Data Quality & Migration

| # | Feature | Role(s) | Entities | Stream | Phase | Dependencies |
|---|---------|---------|----------|--------|-------|-------------|
| F44 | **Duplicate detection** (Contact, Account — name + org fuzzy match) | Admin | Contact, Account | Both | Post-MVP | F03, F04 |
| F45 | **Salesforce data migration** (initial import, mapping, validation) | Admin | All | Both | MVP | F38 |
| F46 | **Data quality dashboard** (incomplete records, stale data, dupes) | Admin | All | Both | Backlog | F44 |

---

## Phase Summary

| Phase | Feature Count | Core Jobs Served |
|-------|-------------|-----------------|
| **MVP** | 18 features | All 5 core jobs at minimum viable level |
| **Post-MVP** | 20 features | Deepens jobs 1–5; adds finance workflows, campaigns, prospect intelligence |
| **Backlog** | 8 features | Nice-to-haves: AI enrichment, custom reports, advanced dedup, calendar sync |

### MVP Feature List (for quick reference)

F01, F02, F03, F04, F05, F06, F09, F10, F11, F12, F19, F20, F21, F25, F34, F36, F38, F42, F45

---

## Scope Control Rule

To promote a feature from Backlog to Post-MVP or from Post-MVP to MVP:
1. Map it to a user journey in the Role × Journey Matrix
2. Confirm it serves one of the 5 core jobs in the Scope Constitution
3. Document the dependency chain — what must exist first?
4. Get sign-off from product owner (Jac)

Features that cannot be mapped to a user journey stay on Backlog.
