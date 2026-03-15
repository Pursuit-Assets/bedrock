# Pursuit CRM (Bedrock) — Scope Constitution

> Version: 1.0 | Status: Active | Date: 2026-03-15
>
> Every future feature, integration, and PRD gets tested against this document.
> "Does this serve the mission?" If no, it goes on a backlog — not into scope.

---

## Mission Statement

Bedrock is Pursuit's unified fundraising CRM: a single system of record that connects people, organizations, opportunities, grants, payments, and interactions so the fundraising team can manage pipeline, prioritize prospects, and forecast revenue — without toggling between disconnected tools or maintaining manual spreadsheets.

Bedrock exists to make fundraising **operationally reliable** (clean data, clear ownership, no duplicates) and **strategically visible** (pipeline health, cash flow projections, prospect intelligence) for a small team that cannot afford overhead.

---

## Core Jobs (Plain Language)

Bedrock must do these 5 things well. Everything else is secondary.

1. **Know who we're talking to and why.** Maintain a clean, deduplicated record of every organization, contact, and prospect — with relationship context (who introduced whom, what's the history, what's the ask).

2. **Track every dollar from possibility to bank account.** Manage the full opportunity lifecycle — from first conversation through proposal, award, invoicing, and payment receipt — with clear stage definitions and ownership.

3. **Tell us what to do this week.** Surface time-sensitive actions (grant deadlines, follow-ups, stale deals, pending payments) so the team works on the right things without manually scanning spreadsheets or calendars.

4. **Show leadership where the money stands.** Provide accurate, up-to-date pipeline value, weighted forecasts, and cash flow projections — broken out by revenue stream (nonprofit grants vs. PBC contracts) — without requiring someone to build a report from scratch.

5. **Keep Salesforce and Sage as sources of truth, not silos.** Sync cleanly with Salesforce (opportunity and contact data) and Sage Intacct (invoices and payments) so no one re-keys data and the books always reconcile.

---

## Explicit Out of Scope

This list is the most important part of this document. These items are **not** part of Bedrock, even if they sound useful.

| Item | Why It's Out | Where It Lives Instead |
|------|-------------|----------------------|
| **Learning management / admissions** | Different lifecycle, different users, different data model | Unified learning platform (Pathfinder, Sputnik, admissions) |
| **Marketing automation** (email campaigns, drip sequences, newsletter management) | Bedrock tracks *relationships*, not *broadcast communications* | Future: dedicated email/marketing tool or Salesforce Marketing Cloud |
| **Event management** (registration, ticketing, logistics) | Distinct operational domain; Bedrock records the *fundraising outcome* of events, not the event itself | Eventbrite, Luma, or similar + manual Bedrock entry for resulting opportunities |
| **HR / payroll / internal staffing** | Completely separate domain | Internal HR systems |
| **Donor portal / external-facing UI** | Bedrock is an *internal* tool for the fundraising team | Future: separate donor-facing experience if needed |
| **AI-generated outreach drafts** | Intelligence (scoring, suggestions) yes; auto-generated donor communications no — relationships require human voice | Claude API can *inform* but not *send* |
| **Accounting / general ledger** | Bedrock tracks revenue *pipeline*; Sage owns the books | Sage Intacct |
| **Builder career services / job placements** | Pathfinder domain, not fundraising | Learning platform (Pathfinder module) |
| **Custom report *builder* (drag-and-drop, SQL)** | Over-engineered for team size; pre-built reports + basic filters are sufficient for MVP and likely long-term | Pre-built dashboards + CSV export |
| **Real-time Slack bot conversations** | Bedrock *ingests* structured data from Slack; it does not become a chatbot | MCP Client handles Slack interaction; Bedrock provides the review queue |

### Boundary Rule

If a proposed feature doesn't directly serve one of the 5 core jobs above, it requires explicit justification and sign-off before entering any phase other than Backlog.

---

## Revenue Stream Separation

Bedrock must cleanly handle two revenue streams with different characteristics:

| Dimension | Nonprofit (Grants) | PBC (Contracts/Partnerships) |
|-----------|-------------------|------------------------------|
| **Opportunity type** | Grant applications with deadlines, reporting requirements | Service contracts, sponsorships, earned revenue |
| **Pipeline stages** | Prospect → LOI → Full Proposal → Submitted → Awarded → Active → Closed | Prospect → Qualified → Proposal → Negotiation → Closed Won/Lost |
| **Payment pattern** | Milestone-based or reimbursement; often multi-year | Invoice on delivery or net-30/60 terms |
| **Reporting** | Grant compliance reports, restricted vs. unrestricted | Revenue recognition, contract deliverables |

The data model and pipeline views must support both without conflating them. A single Account may have both grant and contract Opportunities.

---

## Success Criteria — 12-Month Check

How we know Bedrock is working by March 2027:

### Operational

1. **Single source of truth.** The fundraising team uses Bedrock (via Salesforce sync) as their primary pipeline tool — not spreadsheets, not email threads, not memory. Measured: <2 spreadsheets actively maintained for pipeline data (down from current state).

2. **Weekly priorities without manual assembly.** The "what do I do this week" view is generated automatically from pipeline data. Measured: weekly priority list takes <5 minutes to review (vs. current ~60 minutes of spreadsheet wrangling).

3. **Pipeline accuracy.** Weighted pipeline forecast is within 15% of actual revenue received per quarter. Measured: quarterly retrospective comparison.

4. **No re-keying.** Data entered in Salesforce appears in Bedrock (and vice versa) without manual copy. Sage payment data reconciles without manual matching. Measured: zero routine manual data transfer tasks.

### Strategic

5. **Cash flow visibility.** Leadership can see a 12-month rolling cash flow projection at any time, updated within 24 hours of pipeline changes. Measured: dashboard exists and is consulted at least monthly.

6. **Prospect intelligence.** Team can identify and prioritize top prospects using network data and giving capacity signals — not just gut feel. Measured: prospect scoring is used in at least 50% of outreach prioritization decisions.

### Technical

7. **Data quality.** Duplicate contact/account rate stays below 5%. Stale opportunities (no update in 30+ days) are flagged and resolved within one week. Measured: monthly data quality audit.

8. **Integration reliability.** Salesforce and Sage syncs succeed >99% of the time on a weekly basis; failures are surfaced and resolved within 24 hours. Measured: sync logs and error rates.

---

## What This Document Does NOT Cover

This Scope Constitution defines *boundaries*. The following are defined in companion documents:

| Topic | Document |
|-------|----------|
| Data model (entities, fields, relationships) | `product/crm-architecture/entity-map.md` |
| User roles and journeys | `product/crm-architecture/user-journey-matrix.md` |
| Information flows | `product/crm-architecture/information-flows.md` |
| Integration contracts | `product/crm-architecture/integration-register.md` |
| Feature inventory and prioritization | `product/crm-architecture/feature-register.md` |
| Individual component PRDs | `product/crm-prds/` (one per component) |
| Week 1 prototype spec | `product/fundraising-team/phases/week-1-prototype.md` |
| Long-term platform integration | `product/learning-platform-integration.md` |
