# Finance / Invoicing — Phase 2 + Phase 3 Roadmap

> **Status:** Future work. Captured 2026-04-16 from `docs/implementation-plan.md` (Nov 2025 pre-launch spec, now archived).
> Phase 1 shipped. Phase 2 and Phase 3 remain unbuilt unless noted. Sections below are preserved verbatim from the original spec so no design context is lost during the archive.

## Context

The original grant-lifecycle implementation plan (Nov 2025) defined three phases:

- **Phase 1 — Manual & Safe** (payment schedule management, finance dashboard, single invoice per grant, manual payment tracking, grant agreement upload, duplicate detection, permission sets). **Shipped.** Code lives under `financial_forecasting/routes/payment_schedules.py`, `financial_forecasting/routes/finance.py`, `data_sync.py`, `bedrock.opportunity_lock`, and the Salesforce Sage_Invoice__c object.
- **Phase 2 — Automation & Multi-Invoice** (below). Not shipped.
- **Phase 3 — Advanced Features** (below). Partial — `bedrock.opportunity_lock` is in use; other items not shipped.

These phases gate on finance-team adoption and feedback. Do not build speculatively — revisit as usage patterns emerge.

---

## Phase 2 — Automation & Multi-Invoice

### 2.1 Multi-Invoice Support

- Create multiple invoices per grant
- Link specific payments to specific invoices
- Track "Invoice 1 of 3" status

Current Phase 1 limitation: one invoice per grant (MVP). Data model already has `Invoice__c` lookup on `npe01__OppPayment__c` so payments can be linked to specific invoices without schema change.

### 2.2 Smart Completion

System suggests completion when conditions met:

- All payments marked received
- All invoices paid
- 30 days past final payment date

Requires finance approval to complete.

### 2.3 Amendment Workflow

- "Create Amendment" button
- Tracks amendment history
- Creates new invoice for additional funding
- Links amended records

### 2.4 Enhanced Validations

- Lock payment schedule after invoice created
- Prevent opportunity amount changes if payments exist
- Validate payment-invoice amount matching

*Partially shipped — some validation exists in `routes/payment_schedules.py`. Remaining: post-invoice lock, amount-change gating, amount matching.*

### 2.5 Payment Variance Handling

- Record expected vs actual amount
- Track payment variance reasons
- Show variance alerts

---

## Phase 3 — Advanced Features

### 3.1 Sage Payment Sync

- Nightly job to check Sage for received payments
- Auto-update Salesforce payments when Sage shows paid
- Reconciliation report

### 3.2 Advanced Reporting

- Overdue invoice alerts
- Revenue forecasting
- Payment aging report
- Grant portfolio dashboard
- Custom report builder

### 3.3 Workflow Automation

- Auto-send invoice reminders
- Escalation for overdue payments
- Email notifications
- Slack integrations

### 3.4 Error Recovery

- Transaction rollback on failure
- Retry logic for API calls
- Error logging and monitoring
- Audit trail

### 3.5 Concurrency Control

- Record locking during operations
- "In progress" indicators
- Prevent duplicate operations

*Partially shipped — `bedrock.opportunity_lock` table exists and is actively used in `routes/ai.py` (stage-change gate) and `routes/permissions.py` (lock CRUD). Remaining: "in-progress" UI indicators, duplicate-operation prevention in non-opportunity flows.*

---

## Prerequisites before starting Phase 2+

- Phase 1 running in production for 3+ months with stable usage
- Finance team has submitted feedback on pain points
- At least 100 invoices processed (data signal for variance/amendment frequency)
- Decision on whether to accept current partial-payment limitation (Option C in `docs/architecture-decisions.md` §2) before investing in Phase 2.1 + 2.5

## Related decisions (in `docs/architecture-decisions.md`)

- §1: Invoice__c object — flagged for review
- §2: Partial payment tracking — boolean only, flagged for review
- §3: Invoice creation — manual (current)
- §6: Multi-currency support — flagged as Phase 2 consideration
- §7: Invoice line items — single line per invoice (flagged if itemization requested)

## Pipeline Cleanup Tool (related, not part of Phase 2/3)

Stale-opportunity hygiene feature (past close date or no updates in 30+ days) was removed from the Overview dashboard and flagged as its own future tool. See `tasks/bedrock-ui-improvements.md` for the current UI-polish backlog.
