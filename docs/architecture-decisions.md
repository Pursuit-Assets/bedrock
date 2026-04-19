# 🏗️ Architecture Decisions & Questions

## 💰 Invoicing & Payments Decisions

## ⚠️ **Flagged for Review**

### **1. Invoice__c Object - Is it needed?**

**Current Implementation:**
```
Payment → Invoice__c (junction object) → Sage Invoice ID
```

**Alternative (Simpler):**
```
Payment.Sage_Invoice_ID__c → "30555" (direct field)
```

**Trade-offs:**

| Aspect | Current (Invoice__c Object) | Simpler (Direct Field) |
|--------|---------------------------|----------------------|
| Complexity | More complex | Simpler to maintain |
| Data tracking | Can track invoice status in SF | Status only in Sage |
| Relationship | Supports M:M (if needed) | 1:1 only |
| Queries | More joins needed | Direct access |
| Audit trail | Full invoice history in SF | Minimal SF history |

**Current Decision:** Keep Invoice__c object for now

**Reason:** Provides flexibility and cleaner data model

**Revisit When:** 
- System is in production for 3+ months
- We have usage patterns data
- Finance team feedback on what data they actually need in SF

**Recommendation for Future:**
If we find we're always querying Sage for invoice details anyway, and the Invoice__c object is just a lookup table with no real value-add, consider simplifying to direct field.

---

### **2. Partial Payment Tracking**

**Current Implementation:**
- Boolean only: `npe01__Paid__c` (TRUE/FALSE)
- No tracking of partial amounts

**Gap:**
```
Scenario: Invoice for $50,000
- Customer pays $25,000 on Jan 10
- Customer pays $25,000 on Jan 20

Current System: 
- Shows as "Not Paid" until both payments received
- Can't see partial progress
```

**Potential Solutions:**

#### **Option A: Add Amount Paid Field** (Recommended)
```sql
-- Add to npe01__OppPayment__c:
Sage_Amount_Paid__c (Currency)

-- Sync logic:
if amount_paid >= scheduled_amount:
    npe01__Paid__c = TRUE
else:
    npe01__Paid__c = FALSE
    
Sage_Amount_Paid__c = amount_paid (always updated)
```

**Dashboard shows:**
- Expected: $50,000
- Received: $25,000
- Status: Partially Paid (50%)

#### **Option B: Split Payment Records**
When partial payment received, split into:
- Payment 1: $25,000 (Paid)
- Payment 2: $25,000 (Unpaid)

**Cons:** Retroactively changes payment schedule ❌

#### **Option C: Accept Current Limitation**
- Partial payment details only visible in Sage
- Salesforce shows binary paid/unpaid
- Good enough if partial payments are rare

**Current Decision:** Keep boolean for now (Option C)

**Reason:** Need to understand how common partial payments are

**Data to Collect:**
1. How often do partial payments happen?
2. Do they eventually pay in full, or are there write-offs?
3. What does finance team need to see in SF vs. what they check in Sage?

**Revisit When:**
- Finance team reports confusion about payment status
- Partial payments become common
- We need better cash flow forecasting

---

### **3. Invoice Creation - When and How?**

**Current:** Manual creation by finance team via dashboard

**Alternatives:**

#### **Option A: Fully Manual** (Current)
- Finance decides when to create invoice
- Full control over timing and details
- Good for complex situations

#### **Option B: Auto-create on Stage Change**
- When opportunity moves to "Collecting / In Effect"
- Automatically create invoices for all payments
- Could be optional with confirmation

#### **Option C: Auto-create on Payment Due Date**
- Background job creates invoice X days before due date
- Sends reminder to finance team
- More proactive

**Current Decision:** Manual (Option A)

**Reason:** 
- Early in system adoption
- Finance team wants control
- Not all grants follow same process

**Revisit When:**
- Process is more standardized
- Team is comfortable with system
- Volume increases

---

### **4. Sage Invoice ID Format**

**Current Issue:** Demo mode uses `DEMO-xxxxxxxx` format

**Real Sage Format:** Numeric ID (e.g., `30555`)

**Questions:**
1. Should we generate a Sage invoice number in advance?
2. Or create invoice in Sage first, then get ID back?
3. How to handle duplicate detection?

**Current Decision:** Create in Sage first (when ready), get ID back

**To Implement:**
- Replace DEMO mode with real Sage invoice creation
- Use Sage's `create` API to generate invoice
- Store returned RECORDNO in Sage_Invoice_ID__c

---

### **5. Customer Matching - Salesforce Account → Sage Customer**

**Challenge:** Salesforce Account names might not exactly match Sage Customer names

**Example:**
- Salesforce: "Ford Foundation"
- Sage: "The Ford Foundation"

**Current Solution:** Use exact Account name from Salesforce opportunity

**Potential Issues:**
- Customer might not exist in Sage
- Name might not match exactly
- Could create duplicate customers

**Better Solution (To Build):**
1. Add `Sage_Customer_ID__c` field to Salesforce Account
2. One-time mapping: Link SF Accounts to Sage Customers
3. Invoice creation uses the Sage Customer ID
4. If no mapping, show dropdown to select/create

**Current Decision:** Use Account name, let finance edit on form

**Reason:** Simple for MVP

**Revisit When:** 
- Customer matching errors occur
- Need to create invoices in Sage (not DEMO mode)

---

### **6. Multi-Currency Support**

**Current:** Assumes all grants in USD

**Future Consideration:**
- International funders pay in different currencies
- Need currency conversion tracking
- Sage supports multi-currency

**Not addressed yet.** Flag for Phase 2.

---

### **7. Invoice Line Items**

**Current:** Each invoice has one line item (the payment amount)

**Potential Need:**
- Itemized invoices (Program A: $25k, Program B: $25k)
- Multiple GL accounts per invoice
- Tax/fees as separate line items

**Current Decision:** Single line item per invoice (simple)

**Reason:** Matches most grant use cases

**Revisit If:** Finance team requests itemization

---

## 📊 **Decision Log**

| Decision | Date | Status | Owner |
|----------|------|--------|-------|
| Keep Invoice__c object | 2025-11-13 | ⚠️ Flagged for review | TBD |
| Partial payments: Boolean only | 2025-11-13 | ⚠️ Flagged for review | TBD |
| Manual invoice creation | 2025-11-13 | ✅ Accepted | Finance Team |
| Create invoice in Sage first | 2025-11-13 | 🔄 To Implement | Dev |
| Simple customer matching | 2025-11-13 | ✅ Accepted (MVP) | Finance Team |
| Ask Pebble tiered query router | 2026-03-23 | ✅ Shipped (PR #50 + Sprint 3.5 PR #53) | JP |
| CRM bridge — internal API key auth | 2026-03-23 | ✅ Shipped (PR #50 + Sprint 4.5) | JP |
| Sprint 4 — Pebble CRM writes as agent tools | 2026-03-24 | ✅ Shipped (Sprint 4.5) | JP |
| Sprint 4 — Conversational approval for CRM writes | 2026-03-24 | ✅ Shipped (Sprint 4.5) | JP |
| Sprint 4 — Org intelligence timing (T3 auto / T2 user-triggered) | 2026-03-24 | ✅ Shipped (Sprint 4) | JP |
| Sprint 4 — 990 XML rate-limit handling (cache + top 1 org) | 2026-03-24 | ✅ Shipped (Sprint 4) | JP |

---

## 🎯 **Next Review:**

Schedule architecture review after:
- [ ] 100 invoices created
- [ ] 3 months of usage
- [ ] Feedback from finance team collected
- [ ] Common pain points identified

Then decide on simplifications or enhancements.

---

## 🔍 Pebble Architecture Decisions

### **8. Ask Pebble — Tiered Query Architecture**

**Current Decision:** Hybrid regex → Haiku LLM classifier routes queries to the appropriate depth.

**Alternatives Considered:**
- (A) Single-depth research for all queries — current model, wastes $0.20+ on simple CRM lookups
- (B) Manual mode selection only — user picks tier, bad UX since they don't know which tier is right

**Reason:** 80%+ of queries will be CRM lookups (L0/L1, free). Running full research on these is wasteful. The regex layer catches obvious patterns for free; Haiku ($0.001, <1s) handles ambiguous queries. Progressive cost control — expensive research only when the user explicitly asks.

**Date:** 2026-03-23

**Status:** Shipped in PR #50 (core tiered router) + Sprint 3.5 PR #53 (CRM tool-use agent consolidating L0/L1)

**Reference:** `product/crm-prds/ask-pebble-spec.md`, `pebble/router.py`, `pebble/handlers/crm_agent.py`

---

### **9. CRM Bridge — Service-to-Service Authentication**

**Current Decision:** Internal API key (`BEDROCK_INTERNAL_API_KEY` env var) for Pebble → Bedrock calls. SOSL for cross-entity search.

**Alternatives Considered:**
- (A) Shared database access — breaks service separation, couples Pebble to Bedrock's DB
- (B) OAuth between services — overhead for internal services on the same machine
- (C) Service mesh/API gateway — premature for 2-service architecture

**Reason:** Preserves service separation; reuses existing Salesforce endpoints; simple single-env-var configuration. SOSL is already supported by `simple-salesforce` (`salesforce.py:339-362`).

**Date:** 2026-03-23

**Status:** Shipped in PR #50 (read bridge) + Sprint 4.5 (write bridge — create_account, create_contact)

**Reference:** `product/crm-prds/ask-pebble-spec.md`, `pebble/crm_bridge.py`

---

## 🔮 **Future Sprint: Technical Debt & Planned Work**

*Documented 2026-03-17 during OAuth2 Connectivity sprint. DO NOT IMPLEMENT — for planning only.*

### 6A. Server Merge: `simple_server.py` → `main.py` — COMPLETE

**Status**: Completed in two phases (PRs #42, #43). See [architecture-server-migration.md](architecture-server-migration.md) for full details.

- **Phase 1 (PR #42)**: `main.py` connects to Salesforce directly via `SalesforceLogin` fallback chain. Removed mock MCP transport, added `.env` support, fixed SOQL field mappings.
- **Phase 2 (PR #43)**: Ported 50 endpoints from `simple_server.py` into 8 modular route files. Created `dependencies.py` for shared `get_mcp_client()` dependency injection.

`simple_server.py` remains in the repo pending Phase 4 deprecation (Dockerfile update, deprecation notice).

### 6B. Per-User Slack OAuth

**Problem**: Bot token only reads channels the bot is added to. Per-user OAuth needed for DMs, posting as user, private channels, and user preferences.

**Implementation plan**:
- `GET /auth/slack` → redirect to Slack OAuth consent
- `GET /auth/slack/callback` → exchange code, store in encrypted cookie
- Settings page: "Connect Slack" button
- User preferences: channel monitoring, DM access opt-in

### 6C. User Calendar Preferences

**Problem**: Currently hardcoded to PBD shared calendar only.

**Future feature**:
- `GET /api/calendar/available` → list all user-accessible calendars
- `POST /api/calendar/preferences` → save selected calendar IDs
- Store preferences per-user (database or encrypted cookie)
- Frontend: multi-select in Settings page

### 6D. Automation Queue Persistence

**Problem**: `_automation_queue` is in-memory, lost on restart.

**Resolution**: PostgreSQL table `automation_queue` with columns:
`id`, `source`, `raw_text`, `parsed_json`, `status`, `created_at`, `reviewed_by`, `reviewed_at`

---

## 🤖 Agentic Alignment (Sprint 6)

### Scratchpad Enrichment
**Decision:** Extend ResearchScratchpad beyond budget tracking to include source outcomes, skipped sources, and findings summary.
**Reason:** Agentic principle requires explicit plan/progress/conclusions tracking at every iteration. Budget-only scratchpad hid failures.

### Sufficiency Assessment + Retry
**Decision:** After initial cluster research, check if critical sources (per prospect type) returned data. Retry failed clusters with 1.5x timeout budget.
**Reason:** Agentic resilience principle — workers must never fail silently. Critical source failures warrant a retry before giving up.
**Trade-off:** Retry adds latency (up to 90s extra). Acceptable because it only triggers when type-specific critical sources fail, not common sources.

### Conflict Detection
**Decision:** Heuristic regex-based conflict detection across claims, not ML.
**Reason:** All claim text is template-generated with predictable patterns. Regex is correct for structured input. ML would be over-engineering for ~36 known patterns.

### Conclusion Extraction (condense)
**Decision:** condense() extracts structured conclusions from claims but does NOT clear raw_data.
**Reason:** T2 and T3 handlers read ctx.raw_data after clusters complete (source scoring, forager activation, wiki context for synthesis). Clearing mid-pipeline would break these reads. The 5-minute context TTL handles cleanup.

---

## 🔄 Sprint 4 Rescoping (2026-03-24)

The original Sprint 4 plan bundled six features (org intelligence, 990 XML, recommendations, CRM write bridge, write permissions, human review gate). Sprint 3.5 shipped the tool-use agent and changed the architecture for CRM writes, so the plan was rescoped into three focused sprints (4, 4.5, 5). Four design decisions came out of that rescope and shaped the shipped implementation.

### Same Haiku agent for CRM reads and writes
**Decision:** Extend the existing T0/T0.5 Haiku tool-use agent with write tools rather than building an elevated agent.
**Reason:** Bounded autonomy guardrails (5 rounds, 15s, $0.02) apply equally to writes. Conversation context (last 3 turns) is critical for confirmation — a separate agent would lose it. The safety gate is the confirmation loop, not the model tier. Write tools are conditionally exposed based on user permissions.
**Alternatives considered:** Dedicated Sonnet-tier write agent (rejected — loses context, doesn't improve safety). REST endpoints outside the agent (rejected — duplicates CRM interaction pattern, bypasses conversation context).

### Conversational approval (not card-based) as the default write UX
**Decision:** Agent asks "Shall I save Robin Hood Foundation to Salesforce?" → user says "yes"/"no" → agent creates or skips. No rendered recommendation cards in v1.
**Reason:** The existing `conversation_context` flow handles multi-turn naturally. Card-based batch approval adds frontend complexity (review queue, status tracking, bulk save UI) that isn't warranted until the team asks for it. Defer to conditional Sprint 5 if needed.
**Status:** Shipped in Sprint 4.5. Sprint 5 (cards + batch save + audit trail + permission UI) remains conditional — only build if team reports conversational flow insufficient.

### Org intelligence timing — auto for T3, user-triggered for T2
**Decision:** T3 automatically runs `investigate_connected_orgs()` before synthesis (45s+ budget has headroom). T2 stores connected orgs in context for follow-up ("investigate connected orgs") but doesn't auto-run (T2 targets 15–45s — can't add 10s+ of org lookups).
**Reason:** Latency budgets differ by tier. T3 is already the heavyweight tier; org lookups fit. T2 must stay snappy for browsing / bulk workflows.
**Status:** Shipped in Sprint 4. `pebble/clusters/org_intelligence.py:investigate_connected_orgs()`.

### 990 XML rate limit — cache + top 1 org for T3 only
**Decision:** Cache by `(source="propublica_990_xml", key=object_id)` in existing `api_cache` table, 30-day TTL. Fetch top 1 highest-relevance org XML for T3 only. Additional XMLs deferred.
**Reason:** ProPublica's 990 XML download endpoint is 1 req/min. Fetching multiple orgs would exhaust the budget for any single T3 run. Caching aggressively plus capping at 1-per-run respects the rate limit while still enriching T3 profiles.
**Status:** Shipped in Sprint 4. `pebble/data_sources/propublica.py:download_990_xml()` + `parse_officers_from_xml()`.

