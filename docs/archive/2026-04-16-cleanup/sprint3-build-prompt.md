# Sprint 3 Build Prompt — Cluster Architecture with Prospect Type Routing

Paste everything below the line into a new Claude Code session.

---

```
Build Ask Pebble Sprint 3 — the cluster architecture with prospect type routing from Salesforce Account.Type.

## What's already built (PRs #50 + #51, both merged)

- **Ask Pebble core**: Tiered query routing (L0/L1/T1/T2/T3), chat UI, CRM bridge, readiness module
- **Stage B data foundation**: 5 new data source modules (LDA, FINRA, FEC extended, EDGAR Form 4, Federal Register), temporal accuracy on all claims, FEC claim rebalancing, pronoun resolution, dimension quotas
- **12 data source modules** in `pebble/data_sources/` — all implemented with claim templates and scoring. But the 5 new sources are NOT yet wired into any handler.
- **T2 handler** (`pebble/handlers/tier2.py`) queries ALL data sources regardless of prospect type — this is what Sprint 3 fixes.

## The implementation plan

Read the full plan: `/Users/jp/.claude/plans/snazzy-floating-mango.md`

This plan was reviewed and designed with JP. Key decisions already made:

### Salesforce Account.Type values (verified from SF screenshot)
- Corporate
- Government
- Foundation
- Nonprofit / Nonprofit Organization
- Academic Institution
- Donor Advised Fund
- (Account RecordType "Household" = Individual)
- --None-- / null = Unknown

### Core design: 8 prospect type research templates

Each Salesforce Account Type maps to a ProspectType enum value. Each type has a specific data source activation matrix — which of the 13 source groups to activate, skip, or conditionally include. The full templates with per-source routing tables are in the plan file (Section 2).

Quick summary:
- **CORPORATE**: EDGAR, FINRA, Form 4, FEC, OpenCorporates. Skip ProPublica 990.
- **GOVERNMENT**: Federal Register, LDA, FEC extended. Skip FINRA, Form 4.
- **FOUNDATION**: ProPublica 990, USAspending, FEC, OpenCorporates. Skip FINRA, Form 4.
- **NONPROFIT**: Same as Foundation (separate enum for future differentiation).
- **ACADEMIC**: ProPublica 990, USAspending, Federal Register. Skip FINRA, Form 4.
- **DAF**: Research the PERSON behind the fund. FEC, FINRA, Form 4, OpenCorporates. Skip ProPublica 990.
- **INDIVIDUAL**: Broad — FEC, FINRA, Form 4, EDGAR, OpenCorporates. Conditionals for 990/LDA/FedReg.
- **UNKNOWN**: All sources with reduced limits (shallow pass).

### Classification hierarchy (first match wins)
1. Account RecordType = "Household" → INDIVIDUAL (confidence 0.95)
2. Account.Type from CRM match → direct mapping (confidence 0.95)
3. Wikipedia categories/infobox → infer type (confidence 0.80)
4. Organization name heuristics ("Foundation", "Inc", "Department of") → (confidence 0.70)
5. Haiku LLM fallback → (confidence varies)
6. Default → UNKNOWN (confidence 0.50)

### Architecture: 3 concurrent clusters with bounded budgets
- **Financial Cluster** (15 calls, 60s): FEC, ProPublica, USAspending, EDGAR, FINRA
- **Affiliation Cluster** (15 calls, 60s): OpenCorporates, Wikipedia, LDA, Federal Register
- **Public Profile Cluster** (5 calls, 30s): Wikipedia full profile, web search

All 3 run concurrently via asyncio.gather. Each cluster reads the SourceConfig for the prospect type to know which sources to activate.

## Build sequence (from plan Section 9)

1. **SOSL + readiness plumbing** — Add Account.Type + RecordType.Name to SOSL queries, flow through EntityMatch → crm_match
2. **ProspectType module** — Enum + classify_prospect() with 6-level hierarchy
3. **Source router** — SourceConfig per ProspectType (activation matrix from templates)
4. **Cluster budget + scratchpad** — ClusterBudget, ResearchScratchpad
5. **Three clusters** — financial.py, affiliation.py, public_profile.py
6. **Cluster dispatcher** — run_cluster_research() in clusters/__init__.py
7. **Wire into T1** — classify and store prospect_type in ProspectResearchContext
8. **Rewrite T2** — replace flat fetch-all with cluster dispatch
9. **Forager adjustment** — threshold tuning per prospect type

## Critical files to read before building

- **The plan**: `/Users/jp/.claude/plans/snazzy-floating-mango.md` (read ALL of it)
- **Current T2 handler**: `pebble/handlers/tier2.py` — this is being rewritten
- **Current T1 handler**: `pebble/handlers/tier1.py` — adding classification step
- **SOSL queries**: `financial_forecasting/routes/salesforce_search.py` — adding Account.Type
- **Readiness module**: `pebble/readiness.py` — adding account_type to EntityMatch
- **Research context**: `pebble/research_context.py` — adding prospect_type fields
- **Claim templates**: `pebble/claim_templates.py` — all 15 templates, already complete
- **Source richness**: `pebble/orchestrator.py` — score_source_richness() already supports all sources
- **Data sources**: `pebble/data_sources/` — all modules complete, Sprint 3 wires them in
- **Canonical definitions**: `product/crm-architecture/canonical-definitions.md`
- **Entity map**: `product/crm-architecture/entity-map.md`

## Critical verified findings (do NOT re-assume)

- ProPublica has NO filing detail endpoint (/organizations/{ein}/{tax_period}.json = 404)
- ProPublica officer data only in XML download (1/min rate limit). Tag: <Form990PartVIISectionAGrp>
- EDGAR Form 4 via EFTS: must resolve person→CIK first (doc text search, not filer metadata)
- FEC: Will have real API key (not DEMO_KEY) before Sprint 3 goes live
- Pursuit's EIN 142164034 is NOT in ProPublica's database
- SOSL already supports Account.Name in Contact RETURNING — Account.Type should work the same way
- RecordType.Name in SOSL RETURNING for Account needs verification during implementation
- Salesforce Account.Type values are NOT the same as canonical-definitions.md (see above for actual values)

## Important preferences

- Accuracy over cost — spend more per prospect for genuinely useful results
- Build production-ready — no demo/placeholder implementations
- Plan mode for non-trivial tasks
- Verify assumptions against actual code before building
- DAFs are often a barrier to the actual individual or for deceased funders — research the person, not the fund
- Keep all 8 prospect types separate (don't collapse Foundation + Nonprofit + Academic)
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
