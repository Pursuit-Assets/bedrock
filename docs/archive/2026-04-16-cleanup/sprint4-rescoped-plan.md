# Sprint 4 / 4.5 / 5 — Rescoped Plan (Post-3.5)

> Generated 2026-03-24. Replaces the original Sprint 4 plan in `floating-wobbling-sedgewick.md` (lines 385–534).

## Why Rescoping

The original Sprint 4 bundles 6 features into one sprint. Sprint 3.5's tool-use agent (PR #53) changes the architecture: CRM writes should be agent tools with conversational confirmation, not separate REST endpoints with a card-based approval UI. The 6 features split naturally into 3 focused sprints.

---

## Sprint Breakdown

| Sprint | Name | Focus | Depends On | Enables |
|--------|------|-------|-----------|---------|
| **4** | Org Intelligence + 990 XML | Pure backend research enrichment | Sprint 3.5 (done) | Richer T3 results, officer discovery, recommendation data model |
| **4.5** | CRM Write Agent | Extend tool-use agent with writes | Sprint 4 (recommendations to act on) | Team can save discoveries to Salesforce from chat |
| **5** | Enhanced Write UX | Frontend cards + batch ops | Sprint 4.5 | Batch save, audit trail, permission UI *(conditional — only if conversational flow insufficient)* |

---

## Design Decisions (Resolved)

### 1. Same agent vs elevated agent for writes → **Same Haiku agent**
- Bounded autonomy guardrails (5 rounds, 15s, $0.02) apply equally to writes
- Conversation context (last 3 turns) is critical for confirmation — separate agent loses it
- Safety gate is the confirmation loop, not the model tier
- Write tools conditionally included based on user permissions

### 2. Conversational vs card-based approval → **Conversational first, cards deferred**
- Agent says "Want me to save Robin Hood Foundation?" → user says "yes" → agent creates
- Existing `conversation_context` flow handles multi-turn naturally
- Card-based batch approval deferred to Sprint 5 (only if team asks for it)

### 3. Org intelligence timing → **Auto for T3, user-triggered for T2**
- T2 targets 15–45s — can't add 10s+ of org lookups
- T3 is already 45s+ — org investigation adds acceptable 15–30s
- T2 stores `connected_orgs` in context for follow-up ("investigate connected orgs")

### 4. 990 XML rate limit (1/min) → **Cache + top 1 org**
- Cache by `(source="propublica_990_xml", key=object_id)` using existing `api_cache` table, 30-day TTL
- Fetch top 1 highest-relevance org XML for T3 only
- Additional XMLs deferred to background work in Sprint 5

---

## Sprint 4: Org Intelligence + 990 XML

### What it builds
Enriches T2/T3 research by investigating organizations discovered during cluster research. Adds 990 XML officer parsing for T3. Creates the recommendation data model that Sprint 4.5 acts on.

### Architecture hooks already in place
- `_extract_connected_orgs()` at `pebble/clusters/affiliation.py:168` — called but output not stored
- `connected_orgs` field on `ResearchScratchpad` at `pebble/clusters/budget.py:68` — never populated
- `fetch_organization(ein)` returns `filings_with_data[].object_id` for XML download
- `api_cache` table + `cache.py:get_cached()` reusable for XML caching

### Files

| Action | File | What |
|--------|------|------|
| CREATE | `pebble/clusters/org_intelligence.py` | `investigate_connected_orgs()` — collect, rank, resolve, cross-ref, XML parse |
| CREATE | `pebble/schemas/recommendations.py` | `ResearchRecommendation` model (type, entity, rationale, claims, priority, status) |
| MODIFY | `pebble/data_sources/propublica.py` | `download_990_xml()` + `parse_officers_from_xml()` |
| MODIFY | `pebble/claim_templates.py` | `claims_from_org_officers()` — claims for ALL officers at an org |
| MODIFY | `pebble/clusters/affiliation.py` | Store connected_orgs in ctx after line 146 |
| MODIFY | `pebble/handlers/tier2.py` | Note connected_orgs count in response (store-only) |
| MODIFY | `pebble/handlers/tier3.py` | Auto-run org intelligence before synthesis |

### Verification
1. Unit: `parse_officers_from_xml()` with sample 990 XML fixture
2. Unit: `investigate_connected_orgs()` with mocked ProPublica + CRM bridge
3. Integration: T3 for nonprofit leader → org recommendations + officer names appear
4. T2 latency stays under 45s (store-only)
5. XML cache prevents redundant downloads
6. All existing tests pass

---

## Sprint 4.5: CRM Write Agent + Conversational Approval

### What it builds
Extends T0/T0.5 CRM agent with write tools. Conversational confirmation flow. Removes write redirect to Pipeline page.

### Architecture hooks already in place
- Bedrock write endpoints: POST `/api/salesforce/accounts` (main.py:400), POST `/api/salesforce/contacts` (main.py:461)
- `mcp_client/services/salesforce.py` has full CRUD
- `user_email` in `ChatQueryRequest` already used for access gating
- `crm_bridge.py` exclusively does GETs — clean extension point

### Files

| Action | File | What |
|--------|------|------|
| MODIFY | `pebble/crm_bridge.py` | `create_account()`, `create_contact()` — POST to Bedrock |
| MODIFY | `pebble/tools/crm_tools.py` | `CRM_WRITE_TOOLS` list + permission-aware `execute_tool()` |
| MODIFY | `pebble/handlers/crm_agent.py` | WRITE GUIDELINES in system prompt, conditional tool exposure |
| MODIFY | `pebble/router.py` | Remove `redirect_crm_write`, classify writes at level 0 |
| MODIFY | `pebble/handlers/__init__.py` | Thread `user_permissions` through dispatch |
| MODIFY | `pebble/main.py` | Resolve permissions from `PEBBLE_CHAT_WRITE_EMAILS` env var |

### Permission approach
- Sprint 4.5: `PEBBLE_CHAT_WRITE_EMAILS=jp@pursuit.org` (JP-only, expand as trust builds)
- Sprint 5: Upgrade to Bedrock permission API (`pebble_crm_write` key)

### Confirmation flow
```
User: "Create an account for Robin Hood Foundation"
Agent: "I can create Robin Hood Foundation. Shall I save it to Salesforce?"
User: "yes" → Agent creates, returns SF ID
User: "no"  → Agent acknowledges, moves on
No permission → Write tools hidden, graceful message
```

### Verification
1. Write query no longer redirects to Pipeline page
2. Agent confirms before write, creates on "yes", skips on "no"
3. No-permission user: write tools hidden
4. Existing read queries work identically
5. Multi-turn confirmation works
6. All existing tests pass

---

## Sprint 5: Enhanced Write UX (Conditional)

**Trigger:** Only build if team reports conversational approval insufficient for batch scenarios.

- Recommendation cards rendered in chat from T3 org intelligence
- Batch "Save All" for multiple recommendations
- Audit trail table for CRM writes
- Permission management UI
- Upgrade from env-var to Bedrock permission resolution

---

## Team Rollout Strategy

1. **Sprint 4** — enriches research for everyone immediately. No behavior changes.
2. **Sprint 4.5** — JP-only write access first. Validate flow. Expand to team.
3. **Sprint 5** — deferred. Monitor for: batch save requests, permission confusion, audit needs.

---

## Build Prompts

### Sprint 4 Build Prompt

```
You are building Sprint 4 for Ask Pebble. Enter plan mode, read the files below, then build.

## Sprint 4: Org Intelligence + 990 XML

### Context
Ask Pebble is a fundraising research assistant with tiered query handling (T0-T3).
Sprint 3.5 shipped a CRM tool-use agent for T0/T0.5. The cluster architecture (Sprint 3)
runs 3 concurrent clusters (Financial, Affiliation, Public Profile) for T2/T3 research.

The Affiliation cluster already extracts connected_orgs from OpenCorporates and
Wikipedia (pebble/clusters/affiliation.py:_extract_connected_orgs, line 168).
The ResearchScratchpad has a connected_orgs field (pebble/clusters/budget.py:68).
Neither is currently wired to downstream processing — output is logged but not stored.

### Files to read first
- Rescoped plan: `tasks/sprint4-rescoped-plan.md` (Sprint 4 section)
- Affiliation cluster: `pebble/clusters/affiliation.py` (connected_orgs hook at line 146)
- Financial cluster: `pebble/clusters/financial.py` (ProPublica phases)
- ProPublica source: `pebble/data_sources/propublica.py` (search + fetch + extract)
- Claim templates: `pebble/claim_templates.py` (existing claims_from_propublica_officers at line 336)
- Budget/scratchpad: `pebble/clusters/budget.py` (connected_orgs field)
- Research context: `pebble/research_context.py` (add_source, raw_data)
- T2 handler: `pebble/handlers/tier2.py` (cluster orchestration)
- T3 handler: `pebble/handlers/tier3.py` (quorum + synthesis)
- Cache system: `pebble/storage/cache.py` (get_cached pattern for XML caching)
- DB init: `pebble/storage/db.py` (existing table patterns)

### What to build

1. **pebble/clusters/org_intelligence.py** (NEW)
   - `investigate_connected_orgs(ctx, person_name, crm_bridge, budget, max_orgs, enable_xml)`
   - Collect connected_orgs from `ctx.raw_data.get("connected_orgs", [])`
   - Also collect orgs from Financial cluster: propublica_data org names
   - Deduplicate by name (case-insensitive)
   - Rank by: has EIN/data > no data, revenue if known, recency
   - For top N: resolve name→EIN via `search_organizations()`, fetch org data via `fetch_organization(ein)`
   - Cross-reference against CRM: `crm_bridge.search_accounts(org_name, limit=3)`
   - If enable_xml and has filings_with_data[0].object_id: download + parse XML
   - Return list of ResearchRecommendation dicts
   - Budget: ClusterBudget(max_api_calls=10, max_seconds=30.0)

2. **pebble/data_sources/propublica.py** (MODIFY)
   - Add `download_990_xml(object_id: str) -> str | None`
     - URL: `https://projects.propublica.org/nonprofits/download-xml?object_id={object_id}`
     - Check cache first: `get_cached("propublica_990_xml", object_id)`
     - On success: cache via existing api_cache (30-day TTL)
   - Add `parse_officers_from_xml(xml_content: str) -> list[dict]`
     - Parse `<Form990PartVIISectionAGrp>` elements
     - Extract: PersonNm, TitleTxt, AverageHoursPerWeekRt, ReportableCompFromOrgAmt, OtherCompensationAmt
     - Handle IRS XML namespace: `urn:us:gov:treasury:irs:ext:efile`
     - Return list of {name, title, hours_per_week, compensation, other_compensation}

3. **pebble/schemas/recommendations.py** (NEW)
   - ResearchRecommendation(BaseModel):
     recommendation_type (investigate_org | create_account | create_contact),
     entity_name, entity_type (account | contact | organization),
     rationale, supporting_claims: list[str], priority (high | medium | low),
     status = "pending", crm_match: dict | None, metadata: dict = {}

4. **pebble/claim_templates.py** (MODIFY)
   - Add `claims_from_org_officers(officers, org_name, ein="", tax_year="")`
   - Returns claims for ALL officers (not person-matching like existing)
   - Pattern: "{name} is {title} at {org_name} ({tax_year} Form 990), compensation ${comp:,.0f}"

5. **pebble/clusters/affiliation.py** (MODIFY)
   - After line 146 (_extract_connected_orgs call): add `ctx.add_source("connected_orgs", connected_orgs)`

6. **pebble/handlers/tier2.py** (MODIFY)
   - After cluster research: store connected_orgs count in response.data
   - Add to response text if connected_orgs found: "N connected organizations available for investigation"

7. **pebble/handlers/tier3.py** (MODIFY)
   - After cluster/pipeline completes, before synthesis:
     Run investigate_connected_orgs(ctx, person_name, crm_bridge, org_budget, max_orgs=5, enable_xml=True)
   - Include recommendations in profile data and response

### Key constraints
- ProPublica XML rate limit: 1 req/min. Fetch top 1 org only, cache aggressively.
- T2 latency must stay under 45s — org intelligence is store-only for T2.
- Use existing api_cache table for XML caching (source="propublica_990_xml").
- crm_bridge methods return None on failure (never raise).
- No changes to CRM agent, router, or write path in this sprint.

### Verification
1. Unit test: parse_officers_from_xml() with sample XML fixture
2. Unit test: investigate_connected_orgs() with mocked dependencies
3. Integration: T3 for known nonprofit leader → org recommendations appear
4. T2 latency check: stays under 45s
5. XML cache: second call hits cache, no network request
6. All existing tests pass
```

### Sprint 4.5 Build Prompt

```
You are building Sprint 4.5 for Ask Pebble. Enter plan mode, read the files below, then build.

## Sprint 4.5: CRM Write Agent + Conversational Approval

### Context
Ask Pebble's T0/T0.5 CRM agent (pebble/handlers/crm_agent.py) is a Haiku tool-use
agent with 5 read-only tools. Sprint 4 added org intelligence that generates research
recommendations. This sprint enables the agent to ACT on recommendations by creating
accounts and contacts in Salesforce via conversational confirmation.

### Files to read first
- Rescoped plan: `tasks/sprint4-rescoped-plan.md` (Sprint 4.5 section)
- CRM agent: `pebble/handlers/crm_agent.py` (tool-use loop, system prompt)
- Tool definitions: `pebble/tools/crm_tools.py` (read tools, execute_tool dispatcher)
- CRM bridge: `pebble/crm_bridge.py` (read-only methods, _get_client pattern)
- Router: `pebble/router.py` (redirect_crm_write at line 53, classifier prompt)
- Handler dispatch: `pebble/handlers/__init__.py` (dispatch_handler routing)
- Pebble main: `pebble/main.py` (chat_query endpoint, user_email access)
- Bedrock write endpoints: `financial_forecasting/main.py` (POST /api/salesforce/accounts at line 400, POST /api/salesforce/contacts at line 461)
- Model client: `pebble/model_client.py` (complete_with_tools method)

### What to build

1. **pebble/crm_bridge.py** (MODIFY) — Add write methods
   - `create_account(name, account_type="", industry="") -> dict | None`
   - `create_contact(first_name, last_name, account_id=None, title="", email="") -> dict | None`
   - Both POST to existing Bedrock endpoints (already work, just need bridge methods)
   - Same error handling: try/except, return None on failure, log error
   - Bedrock expects: {"Name": name, "Type": type} for accounts, {"FirstName": ..., "LastName": ..., "AccountId": ...} for contacts

2. **pebble/tools/crm_tools.py** (MODIFY) — Add write tools
   - New `CRM_WRITE_TOOLS` list (separate from CRM_TOOLS for conditional inclusion)
   - crm_create_account: name (required), account_type, industry
   - crm_create_contact: first_name, last_name (required), account_id, title, email
   - Tool descriptions MUST say "Only call AFTER user explicitly confirms"
   - Modify `execute_tool()` to accept `user_permissions: dict | None`
   - Add `_check_write_permission(perms)` helper
   - Add write dispatch cases to _dispatch()

3. **pebble/handlers/crm_agent.py** (MODIFY) — Write-aware agent
   - Add WRITE GUIDELINES section to _CRM_AGENT_SYSTEM prompt
   - Accept `user_permissions` parameter in handle_crm_agent()
   - Conditionally expose write tools based on permissions
   - Pass permissions through to execute_tool()

4. **pebble/router.py** (MODIFY) — Unblock write queries
   - Remove the redirect_crm_write pattern (line 53)
   - Remove "redirect_crm_write" from _REDIRECT_TARGETS
   - Update _CLASSIFIER_SYSTEM to classify write intents at level 0

5. **pebble/handlers/__init__.py** (MODIFY) — Thread permissions
   - Add `user_permissions: dict | None = None` to dispatch_handler()
   - Pass to handle_crm_agent()

6. **pebble/main.py** (MODIFY) — Resolve permissions
   - Add `_CHAT_WRITE_EMAILS` env var set (PEBBLE_CHAT_WRITE_EMAILS)
   - Build user_permissions dict from email check
   - Pass to dispatch_handler()

### Key constraints
- CRM agent guardrails stay unchanged: MAX_TOOL_CALLS=5, TIMEOUT_SECONDS=15, COST_CAP_USD=0.02
- crm_bridge uses X-Internal-Key for service-to-service auth (bypasses Bedrock user perms)
- Permission check happens in Pebble's tool executor, not Bedrock
- Start with JP-only write access, expand as trust builds
- Existing read queries must work identically (regression)

### Confirmation flow examples
User: "Create an account for Robin Hood Foundation"
Agent: "I can create Robin Hood Foundation. Shall I save it to Salesforce?"
User: "yes" → Agent: [calls crm_create_account] "Done! Robin Hood Foundation created (ID: 001xx...)."
User: "no" → Agent: "Okay, skipping."
No permission → Write tools not in tool list, agent says "I don't have write access."

### Verification
1. Write query → agent confirms before acting
2. "yes" → crm_create_account called, SF ID returned
3. "no" → acknowledged, no CRM call
4. No-permission user → write tools hidden, graceful message
5. Existing read queries work identically
6. Router no longer redirects write queries
7. All existing tests pass
```
