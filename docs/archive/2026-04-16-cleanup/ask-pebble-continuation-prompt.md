# Ask Pebble — Continuation Prompt (Sprint 3+)

Copy-paste this into a new Claude Code session to continue where we left off.

---

## Prompt

```
Continue building Ask Pebble Stage B — the orchestrator redesign with worker clusters, org-linked research, and CRM entity creation.

## What's already built

### PR #50 (merged) — Ask Pebble core system
- **Tiered query routing**: Haiku-first classifier + regex redirect fast-path
- **6 handlers**: redirect, L0 (CRM lookup), L1 (CRM analysis), T1 (ID & triage), T2 (structured intel), T3 (full research)
- **ProspectResearchContext** (`pebble/research_context.py`): in-memory tier data sharing
- **CRM bridge** (`pebble/crm_bridge.py`): httpx client for Pebble→Bedrock Salesforce data (read-only)
- **Readiness module** (`pebble/readiness.py`): multi-layer disambiguation gate
- **Frontend**: 3 tabs (Research, Bulk Import, Ask Pebble chat), permission-gated

### PR #51 (merged) — Stage B data foundation (Sprint 1 + 2)
- **Temporal accuracy**: `data_as_of` + `source_currency` on every claim. Current-position claims from non-recent sources flagged `verified_current: false` with "(verify current status)" text.
- **FEC claim rebalancing**: `claims_from_fec_summary()` produces 1-3 aggregated claims instead of 10 individual contributions.
- **5 new data source modules** (all verified, free APIs):
  - `pebble/data_sources/lda.py` — LDA lobbying (lda.senate.gov/api/v1/, no auth, person-indexed)
  - `pebble/data_sources/finra.py` — FINRA BrokerCheck (api.brokercheck.finra.org/, no auth)
  - `pebble/data_sources/fec.py` — FEC extended: search_committees(), search_independent_expenditures(), search_disbursements()
  - `pebble/data_sources/sec.py` — search_person_cik() for EDGAR Form 4 insider trading
  - `pebble/data_sources/federal_register.py` — Federal Register (federalregister.gov/api/v1/, no auth)
- **ProPublica org financials**: `extract_org_financials()` reads from `filings_with_data[]` JSON (no filing detail endpoint exists — verified)
- **Wikipedia net_worth claim** from infobox
- **Pronoun resolution**: `pebble/context_resolver.py` wired into chat endpoint
- **Dimension quotas**: T2 caps 5 per dimension, sorted by recency, 10yr=old/20yr=very_old
- **Source richness scoring** updated for 12 total sources
- **7 new claim templates**: claims_from_fec_summary, claims_from_org_financials, claims_from_fec_committees, claims_from_insider_transactions, claims_from_lobbying, claims_from_finra, claims_from_federal_register

## What needs to happen next — Sprints 3-5

Read the full implementation plan: `/Users/jp/.claude/plans/floating-wobbling-sedgewick.md`

### Sprint 3: Cluster Architecture
Build the worker cluster system with bounded autonomy (session-2 Claude Certified Architect patterns).

**CRITICAL — Prospect Type Classification (3-PREREQ in plan):**
Before clusters activate data sources, T1 should classify the prospect type (foundation/nonprofit, corporate, government, individual). Each cluster only activates relevant sources based on type. If ambiguous, ask the user. FEC extended only runs if the person has FEC data or is government type.

**New files to create:**
- `pebble/clusters/__init__.py` — cluster package
- `pebble/clusters/models.py` — Pydantic output contracts (FinancialOutput, AffiliationOutput, PublicProfileOutput)
- `pebble/clusters/scratchpad.py` — ClusterBudget (max_api_calls, max_seconds, can_call(), record_call()) + ResearchScratchpad
- `pebble/clusters/financial.py` — Financial Cluster (15 calls, 60s): FEC summary, FEC committees, ProPublica financials, USAspending, EDGAR, EDGAR Form 4, FINRA. Sub-category cap 5 claims each.
- `pebble/clusters/affiliation.py` — Affiliation Cluster (15 calls, 60s): OpenCorporates, Wikipedia, EDGAR, LDA lobbyists, LDA filings, Federal Register. Outputs connected_orgs list.
- `pebble/clusters/public_profile.py` — Public Profile Worker (5 calls, 30s): Wikipedia full profile, net_worth

All 3 clusters run **concurrently** with ProspectResearchContext deduplication (existing pattern at tier2.py:79).

### Sprint 4: Org Intelligence + CRM Flow
- `pebble/clusters/org_intelligence.py` — investigate connected orgs (T2: top 2, T3: top 5). Resolve org name → EIN via search_organizations(), then fetch_organization() + extract_org_financials(). 2 API calls per org.
- ProPublica XML officer extraction (T3 only, async, 1/min rate limit, cached in SQLite)
- `pebble/schemas/recommendations.py` — ResearchRecommendation model (investigate_org, create_contact, create_account)
- CRM write bridge: `crm_bridge.create_account()`, `crm_bridge.create_contact()` → new Bedrock POST endpoints
- CRM write permissions (3-tier, following task management pattern): pebble_create_crm_records, pebble_modify_related_records, pebble_modify_all_records
- Ownership gate: check OwnerId on related Opportunities via sf_user_id matching
- Human review gate: ConfirmSaveButton pattern on recommendation cards in chat
- Salesforce create_record() already works at mcp_client/services/salesforce.py:206 (verified)

### Sprint 5: Orchestrator Integration
- Add `run_cluster_research()` to orchestrator.py
- Refactor research_single_prospect() to use cluster pipeline
- Rewire T2 handler to use clusters
- Temporal awareness in synthesis prompt
- T2 timing: 30-60s (up from 15-30s) — accuracy over speed tradeoff
- Backward compatibility for /api/v1/research/request

## Critical verified findings (do NOT re-assume)
- ProPublica has NO filing detail endpoint (/organizations/{ein}/{tax_period}.json = 404)
- ProPublica officer data only in XML download (1/min rate limit). Tag: <Form990PartVIISectionAGrp>
- EDGAR Form 4 via EFTS: must resolve person→CIK first (doc text search, not filer metadata)
- FEC DEMO_KEY has 40 calls/hour — need real key from api.data.gov for extended use
- Pursuit's EIN 142164034 is NOT in ProPublica's database

## NEEDS_GOOGLE_CSE — Pickup List
When Google CSE credentials arrive:
1. clusters/affiliation.py: enable search_person(name, org, "boards"/"giving")
2. handlers/tier1.py: search_web() auto-activates (zero code change)
3. End-to-end test: "Jukay Hsu at Pursuit" through T1→T2→T3

## Key design docs
- Full implementation plan: `/Users/jp/.claude/plans/floating-wobbling-sedgewick.md`
- Design spec: `product/crm-prds/ask-pebble-spec.md`
- Pebble evolution roadmap: `tasks/pebble-evolution-roadmap.md`
- CLAUDE.md: project conventions, agent workflows, core principles

## Important preferences
- Accuracy over cost — spend more per prospect for genuinely useful results
- Build production-ready — no demo/placeholder implementations
- Plan mode for non-trivial tasks
- Verify assumptions against actual code before building
- Current title/org claims must be from very recent sources (verified_current flag)
- CRM writes follow task management gating pattern (3-tier permissions + ownership check + ConfirmSaveButton)
```

---

## Starting the servers

```bash
# Terminal 1: Bedrock (port 8000) — must run from financial_forecasting/ dir for .env loading
cd financial_forecasting && python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 2: Pebble (port 8001) — run from project root
cd /Users/jp/Desktop/pursuit-financial-forecasting && python3 -m uvicorn pebble.main:app --host 0.0.0.0 --port 8001 --reload

# Terminal 3: Frontend (port 3000) — auto-reloads
cd financial_forecasting/frontend && npm start
```
