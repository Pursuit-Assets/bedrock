# Ask Pebble Build Prompt

Copy everything below the line into your next Claude Code session.

---

Build Ask Pebble — a conversational CRM intelligence interface for Pebble with tiered query routing.

## What to read first

**Design spec (committed, authoritative):**
`product/crm-prds/ask-pebble-spec.md` — the tier model, disambiguation, CRM bridge, orchestrator direction, security, governance, build order. This is the source of truth for WHAT we're building.

**Implementation plan (local, detailed):**
`/Users/jp/.claude/plans/resilient-wiggling-marshmallow.md` — 75KB with full Python/TypeScript code examples, SQL DDL, Pydantic schemas, regex patterns, file-by-file change lists (14 new files, 8 modified), edge case tables, and 23 verification scenarios. This is the HOW. (This is in the global Claude plans directory, not the repo — it's not committed.)

**Existing codebase context:**
- `tasks/pebble-evolution-roadmap.md` — 4-stage Pebble roadmap; Stage 1 complete, Stages 2-4 future
- `pebble/main.py` — current Pebble backend (research endpoint lives here, needs refactoring)
- `pebble/orchestrator.py` — existing pipeline functions to reuse
- `financial_forecasting/main.py` — Bedrock backend where new search endpoints go
- `financial_forecasting/frontend/src/pages/Pebble.tsx` — current Pebble page (2 tabs: Research, Bulk Import)
- `financial_forecasting/security.py` — has `escape_soql_string()` to reuse

## Build order

Start with **Phase 1: Foundation** (backend plumbing):
1. `1a` — Security: internal API key middleware (`require_auth_or_internal`) on main app, fix SOQL injection in `mcp_client/services/salesforce.py:105`, fix `/health/services` auth
2. `1b` — Search endpoints on main app: SOSL cross-entity search + type-specific SOQL endpoints for contacts, accounts, opportunities
3. `1c` — CRM bridge (`pebble/crm_bridge.py`) — HTTP client calling main app's Salesforce endpoints
4. `1d` — Readiness module (`pebble/readiness.py`) — multi-layer disambiguation gate

Then **Phase 2: Chat Core**, then **Phase 3: Research Tiers**, then **Phase 4: Batch Workflow**. Each phase is testable independently.

## Key constraints

- Pebble is demo-only at launch — Ask Pebble tab gated to `jp@pursuit.org` (frontend + backend)
- Existing Research tab and Bulk Import tab must remain untouched (only Bulk Import's button text changes: "Run Pebble Research" → "Start Tiered Research")
- All existing Pebble API endpoints unchanged
- T3 delegates to the existing pipeline via an extracted `research_single_prospect()` function — not a rewrite
- CRM bridge uses `BEDROCK_INTERNAL_API_KEY` env var for service-to-service auth
- SOQL injection prevention via existing `escape_soql_string()` on all new search endpoints
