# Pursuit CRM (Bedrock) — Integration & External Dependency Register

> Phase 4 Deliverable | Version: 1.0 | Date: 2026-03-15
>
> Companion to: `product/crm-scope-constitution.md`, `product/crm-architecture/information-flows.md`

---

## Integration Summary

| # | System | Direction | Phase | Status |
|---|--------|-----------|-------|--------|
| 1 | Salesforce | Bidirectional | MVP (Phase 1) | Active — existing integration |
| 2 | Sage Intacct | Bidirectional | Phase 2 | Not started |
| 3 | Slack (MCP Client) | Slack → Bedrock | Phase 1 | Active — existing MCP bot |
| 4 | LinkedIn CSV | Import only | Phase 1 | In-browser parsing (no API) |
| 5 | Prospect Lists (CSV) | Import only | Phase 1 | In-browser parsing |
| 6 | Google Calendar | Read only | Phase 2+ | Not started |
| 7 | Claude API | Bedrock → Claude | Phase 2+ | Not started |
| 8 | Learning Platform | Shared identity | Long-term | Architecture defined |

---

## Integration Details

### 1. Salesforce

**Direction:** Bedrock ↔ Salesforce (bidirectional)

**What syncs:**

| Entity | Bedrock → SF | SF → Bedrock | Key Fields |
|--------|-------------|-------------|------------|
| Opportunity | Create, stage change, amount, close date | All fields on record | `salesforce_id` as link key |
| Account | Create, update name/type | All fields on record | `salesforce_id` as link key |
| Contact | Create, update | All fields on record | `salesforce_id` as link key |

**Trigger:** On create/update in Bedrock → push to Salesforce. Periodic pull (every 15 min or on-demand) from Salesforce → Bedrock.

**Frequency:** Near-real-time for writes (Bedrock → SF); polling or webhook for reads (SF → Bedrock).

**Conflict resolution:** Salesforce wins on field-level conflicts (it's the system of record for these entities). Bedrock can create records, but SF is authoritative.

**Owner:** Engineering (backend integration in `financial_forecasting/data_sync.py`).

**Current state:** Working integration exists for Opportunities, Accounts, Contacts via FastAPI backend.

---

### 2. Sage Intacct (Revenue Hub)

**Direction:** Bedrock ↔ Sage Intacct (bidirectional)

**What syncs:**

| Data | Bedrock → Sage | Sage → Bedrock | Key Fields |
|------|---------------|---------------|------------|
| Invoices | Create invoice from Payment schedule | — | `sage_id` on Payment record |
| Payments | — | Payment received confirmation | `amount`, `received_date`, `status` |
| Accounts | Account billing info | — | Account reference |

**Trigger:**
- Bedrock → Sage: When Payment status moves to `invoiced` (manual trigger by bookkeeper).
- Sage → Bedrock: When payment is recorded in Sage (batch sync or webhook).

**Frequency:** Batch (daily) or triggered. Not real-time — bookkeeper works in batches.

**Conflict resolution:** Sage wins on payment data. Sage is the financial system of record.

**Owner:** Engineering + Finance (bookkeeper validates).

**Current state:** Not started. Phase 2. Requires Sage API access and credential setup.

**Open questions:**
- Which Sage API version? REST or SDK?
- What's the invoice creation workflow in Sage — can we push directly or does bookkeeper review in Sage first?
- How to handle partial payments (e.g., milestone-based grants)?

---

### 3. Slack (MCP Client)

**Direction:** Slack → Bedrock (ingest)

**What flows:**

| Data | Source | Target | Processing |
|------|--------|--------|-----------|
| Activity updates | Slack messages from team | Activity records in Bedrock | MCP Client parses → proposes structured data → human reviews in Bedrock |
| Deal updates | Slack messages mentioning deals | Opportunity notes/stage updates (proposed) | Same review queue |

**Trigger:** Team member posts in designated Slack channel. MCP Client bot processes and proposes Bedrock updates.

**Frequency:** Real-time (Slack event) → queued for human review.

**Conflict resolution:** Nothing is written to Bedrock without human approval via review queue.

**Owner:** Engineering (MCP Client in `financial_forecasting/mcp_client/`).

**Current state:** MCP Client Bot exists and logs activities. Review queue for proposed changes is specified but not yet built (see `product/fundraising-team/phases/slack-data-entry-and-review.md`).

---

### 4. LinkedIn CSV Import

**Direction:** Import only (file → Bedrock)

**What flows:**

| Data | Source | Target | Processing |
|------|--------|--------|-----------|
| Contact records | LinkedIn "Connections" CSV export | Contact entity | PapaParse in-browser; column mapping; dedup by name+org |

**Trigger:** Manual file upload by user.

**Frequency:** Ad-hoc (when user exports new connections).

**Owner:** Frontend (in-browser parsing, no backend).

**Current state:** Specified for week-1 prototype (CSV import in `WeeklyPriorities.tsx`). Column mapping and validation rules locked.

---

### 5. Prospect Lists (CSV)

**Direction:** Import only (file → Bedrock)

**What flows:**

| Data | Source | Target | Processing |
|------|--------|--------|-----------|
| HNWI / prospect records | External prospect lists (CSV) | Contact entity + NetworkMatch | PapaParse; fuzzy match (Fuse.js) against existing Contacts |

**Trigger:** Manual file upload.

**Frequency:** Ad-hoc (when new prospect list is acquired).

**Owner:** Frontend (Phase 1 prototype); backend (Phase 2+ for larger lists).

**Current state:** Architecture defined in prospect-dashboard specs. Merge key and dedup logic specified in `REQUIREMENTS-GAPS-AND-STRUCTURE.md` as needing further definition.

---

### 6. Google Calendar (Future)

**Direction:** Read only (Google Calendar → Bedrock)

**What flows:**

| Data | Source | Target |
|------|--------|--------|
| Meeting events | Google Calendar | Task/Activity suggestions in Bedrock |

**Trigger:** Periodic sync or webhook.

**Frequency:** Every 15 minutes or real-time via webhook.

**Owner:** Engineering (Phase 2+).

**Current state:** Not started. Specified in home-page-spec (`product/fundraising-team/phases/home-page-spec.md`) — calendarized view matching meetings to prospect/grant context.

---

### 7. Claude API (Prospect Intelligence)

**Direction:** Bedrock → Claude API

**What flows:**

| Data | Sent to Claude | Returned | Purpose |
|------|---------------|----------|---------|
| Contact + Account context | Name, org, title, giving history signals | Prospect score, research summary, suggested approach | Prospect scoring and intelligence |
| Meeting transcripts | Transcript text + context | Structured summary, action items, confidence scores | Activity logging from Fireflies transcripts |

**Trigger:** On-demand (user requests score) or batch (nightly scoring run).

**Frequency:** Per-request or nightly batch.

**Owner:** Engineering.

**Current state:** Not started. Phase 2+. Architecture referenced in prospect-dashboard specs.

**Constraints:** PII handling — minimize data sent; no donor financial details in prompts; results cached locally.

---

### 8. Learning Platform (Long-term)

**Direction:** Shared identity + optional data links

**What flows:**

| Data | Bedrock → Platform | Platform → Bedrock |
|------|-------------------|-------------------|
| User identity | Shared JWT auth, roles | Same |
| Organization links | Funder Accounts | Employer Companies (optional cross-link) |
| People links | Contacts (funders) | Users (Builders) — shared identity where applicable |

**Trigger:** Shared authentication; optional API calls for cross-references.

**Frequency:** On login (auth); on-demand (cross-reference queries).

**Owner:** Engineering (joint with learning platform team).

**Current state:** Architecture defined in `product/learning-platform-integration.md`. No code yet. Long-term phase.

**Key constraint:** Fundraising leads stay in Salesforce (system of record), not in the learning platform's `lead` table. Optional `fundraising_lead` table in PostgreSQL for cross-platform joins post-merge.

---

## Integration Principles

1. **One system of record per entity.** Salesforce for Opportunities/Accounts/Contacts. Sage for financial transactions. Bedrock for Leads/Tasks/Activities (Bedrock-native). Never let two systems both claim authority over the same field.

2. **Human-in-the-loop for ingest.** Data from Slack, CSV imports, and AI enrichment is always *proposed*, never auto-written. Review queue required.

3. **Idempotent sync operations.** Every sync operation must be safe to retry. Use external IDs (`salesforce_id`, `sage_id`) as dedup keys.

4. **Fail visibly.** Sync failures surface in an admin dashboard or notification — never silently swallowed. See Scope Constitution success criterion #8.

5. **Minimize PII in external calls.** Claude API, Slack logging, and any future integrations receive the minimum data necessary. No donor financial details in API calls.
