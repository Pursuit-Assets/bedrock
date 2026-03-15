# Pursuit CRM (Bedrock) — User Role & Journey Matrix

> Phase 2 Deliverable | Version: 1.0 | Date: 2026-03-15
>
> Companion to: `product/crm-scope-constitution.md`, `product/crm-architecture/entity-map.md`

---

## Roles

| Role | Who | Count | Primary Goal |
|------|-----|-------|-------------|
| **Partnerships IC** | JP, Nick, + 2 others | 4 | Manage pipeline, close deals, maintain relationships |
| **Executive** | CEO (Jac) | 1 | Financial visibility, strategic decisions |
| **Finance** | Bookkeeper | 1 | Invoice, track payments, reconcile with Sage |
| **Program Staff** | Program leads | 2–3 | Know which grants fund their programs, report on deliverables |
| **Admin** | System administrator | 1 | Data quality, user management, integration health |

---

## Role × Journey Matrix

### Partnerships IC

| # | Job | Information Needed | Information Created/Updated | Decision Supported |
|---|-----|-------------------|---------------------------|-------------------|
| 1 | **Manage my pipeline** | My open opportunities, stages, amounts, close dates | Opportunity stage, amount, notes, close date | Which deals to prioritize this week |
| 2 | **Prepare for meetings** | Contact history, recent activities, opportunity details, related docs | Meeting notes (Activity), follow-up Tasks | What to discuss, what to ask for |
| 3 | **Track deadlines & follow-ups** | Tasks due this week, grant deadlines, stale opportunities | Task status, new tasks | What's urgent vs. what can wait |
| 4 | **Research & qualify prospects** | Network matches, wealth tiers, LinkedIn connections, giving history | Lead status, qualification notes, converted Opportunities | Who to pursue, who to pass on |
| 5 | **Log interactions** | Previous conversation context | Activities (calls, emails, meetings, notes) | What happened, what's next |

**Frequency:** Daily (pipeline review, task check), weekly (prospect research, meeting prep).

---

### Executive (CEO)

| # | Job | Information Needed | Information Created/Updated | Decision Supported |
|---|-----|-------------------|---------------------------|-------------------|
| 1 | **See financial state** | Total pipeline, weighted pipeline, cash flow by quarter | Nothing — read-only consumer | Runway, hiring, strategic investments |
| 2 | **Identify risks** | Stale opportunities, overdue payments, concentration risk (too much from one funder) | Flag for follow-up (assigns Task to IC) | Where to intervene |
| 3 | **Report to board** | Revenue by stream (nonprofit/PBC), year-over-year trends, win rate | Nothing — exports reports | Board narrative |
| 4 | **Make intro decisions** | Prospect scores, network connections, capacity signals | Approval/assignment of high-value leads | Which relationships to invest CEO time in |

**Frequency:** Weekly (dashboard glance), monthly (deep dive, board prep), ad-hoc (deal escalation).

---

### Finance (Bookkeeper)

| # | Job | Information Needed | Information Created/Updated | Decision Supported |
|---|-----|-------------------|---------------------------|-------------------|
| 1 | **Create invoices** | Closed-won Opportunities with payment schedules, Account billing info | Payment records (status: invoiced), Sage invoice reference | What to invoice, when |
| 2 | **Track payment receipt** | Outstanding payments, expected dates, aging | Payment status (received, overdue), received date, Sage reconciliation | What's overdue, who to follow up with |
| 3 | **Reconcile with Sage** | Bedrock payment records vs. Sage transactions | Sage ID on Payment record, reconciliation status | Are the books in sync |
| 4 | **Cash flow reporting** | All payments (scheduled + received) by month/quarter | Nothing — consumes data | Cash position, timing of inflows |

**Frequency:** Weekly (invoicing, payment tracking), monthly (reconciliation, reporting).

---

### Program Staff

| # | Job | Information Needed | Information Created/Updated | Decision Supported |
|---|-----|-------------------|---------------------------|-------------------|
| 1 | **Know grant-to-program mapping** | Which Opportunities fund which programs, amounts, restrictions | Nothing (set by Partnerships IC) | Program budgets, staffing |
| 2 | **Report on deliverables** | Grant requirements, timeline, what's been delivered | Deliverable status notes (via Activities or Tasks) | Are we on track for funder reporting |
| 3 | **Flag capacity issues** | Upcoming grants that require program delivery | Capacity notes/concerns | Can we deliver if this grant closes |

**Frequency:** Monthly (program reviews), quarterly (funder reporting), ad-hoc.

---

### Admin

| # | Job | Information Needed | Information Created/Updated | Decision Supported |
|---|-----|-------------------|---------------------------|-------------------|
| 1 | **Maintain data quality** | Duplicate contacts/accounts, stale records, incomplete fields | Merged records, archived stale records, corrected data | Where are the data gaps |
| 2 | **Manage user access** | Who has access, what role, last active | User roles, permissions, active status | Who should see what |
| 3 | **Monitor integrations** | Salesforce sync status, Sage sync status, error logs | Error resolution, retry triggers | Are systems healthy |

**Frequency:** Weekly (data quality check), as-needed (user management, integration issues).

---

## Cross-Cutting Observations

1. **Partnerships ICs are the primary data creators.** Almost all important data (Opportunities, Activities, Contact updates) originates from them. If the IC experience is painful, data quality collapses.

2. **Executive is a read-only consumer.** The CEO needs dashboards and alerts, not data entry forms. Design for scanning, not input.

3. **Finance needs structured payment data that doesn't exist yet.** The Payment entity is the most under-specified piece of the current system. Phase 2 is entirely gated on getting this right.

4. **Program Staff have the lightest CRM needs** but are critical for grant compliance. They need visibility, not full CRM access.

5. **"What should I do this week?"** is the #1 question for both ICs and Executives — answered differently (ICs: my tasks/deadlines; CEO: which deals need attention) but from the same underlying data.
