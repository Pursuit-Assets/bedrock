# Sprint 6: Agentic Alignment + Test Coverage

## How to use this file
Paste the contents of this file into a new Claude Code terminal as the first message.

---

You are building Sprint 6 for Ask Pebble. Enter plan mode, read the files below, then build.

## Sprint 6: Agentic Alignment + Test Coverage

### Context
Ask Pebble is a fundraising research assistant with tiered query handling (T0-T3).
Sprints 3-4.5 + Stage B Sprint 1 shipped the full research pipeline: router,
6 handlers, 11 data sources (all cached), 3 concurrent clusters, org intelligence
with 990 XML parsing, and CRM write agent with conversational approval.

An audit against agentic architecture principles (data isolation, resilience,
scratchpad, data retention, conflict resolution) identified 4 gaps. This sprint
fixes those gaps and adds comprehensive test coverage.

### Agentic Principles Reference
From `/Users/jp/Downloads/Agentic_Principles.md`:
1. **Resilience**: Workers must never fail silently. On failure, return partial results and query orchestrator for continuation.
2. **Scratchpad**: Agent must explicitly update plan, progress, conclusions every iteration. Scratchpad injected into every call.
3. **Data Retention**: Retain only conclusions/decisions. Drop raw tool outputs.
4. **Conflict Resolution**: If evidence is contradictory, log the conflict with source, timestamp, context.

### Files to read first
- Cluster dispatcher: `pebble/clusters/__init__.py` (how clusters run concurrently)
- Budget/scratchpad: `pebble/clusters/budget.py` (ResearchScratchpad — currently only budgets + status)
- Source router: `pebble/clusters/source_router.py` (SourceConfig — which sources are critical per type)
- Research context: `pebble/research_context.py` (ProspectResearchContext — shared data store)
- Financial cluster: `pebble/clusters/financial.py` (data source calls + claim building)
- Affiliation cluster: `pebble/clusters/affiliation.py` (data source calls + claim building)
- Public profile cluster: `pebble/clusters/public_profile.py` (Wikipedia + web search)
- T2 handler: `pebble/handlers/tier2.py` (cluster orchestration + response)
- T3 handler: `pebble/handlers/tier3.py` (quorum + synthesis)
- Orchestrator: `pebble/orchestrator.py` (synthesis prompt, worker pipeline)
- Existing tests: `pebble/tests/` (patterns for mocking, class-based tests)
- Router: `pebble/router.py` (classification logic)
- CRM agent: `pebble/handlers/crm_agent.py` (tool-use loop)
- CRM tools: `pebble/tools/crm_tools.py` (tool definitions + executor)
- CRM bridge: `pebble/crm_bridge.py` (read + write methods)
- Claim templates: `pebble/claim_templates.py` (all claim generators)

### What to build — Part A: Agentic Alignment

#### A1. Scratchpad enrichment (`pebble/clusters/budget.py` MODIFY)
Add to `ResearchScratchpad`:
- `findings_summary: str = ""` — narrative summary of what was found
- `skipped_sources: list[str] = field(default_factory=list)` — sources that failed/timed out
- `source_outcomes: dict[str, str] = field(default_factory=dict)` — per-source status ("ok", "timeout", "error", "skipped")

#### A2. Source outcome tracking (`pebble/clusters/__init__.py` MODIFY)
In `_run_with_timeout()`:
- On success: `scratchpad.source_outcomes[name] = "ok"`
- On timeout: `scratchpad.source_outcomes[name] = "timeout"`, append to `skipped_sources`
- On error: `scratchpad.source_outcomes[name] = "error"`, append to `skipped_sources`

In each cluster (financial.py, affiliation.py, public_profile.py):
- When `_safe_result()` returns None for a source, track the source name in a local `failed_sources` list
- After claim building, return the failed_sources alongside claims (or store on budget)

#### A3. Orchestrator continuation logic (`pebble/clusters/__init__.py` MODIFY)
After `asyncio.gather()` returns:
- Add `_assess_sufficiency(scratchpad, source_config, ctx) -> tuple[bool, list[str]]`
  - For each prospect type, define which sources are "critical" (e.g., ProPublica for FOUNDATION, FEC for GOVERNMENT)
  - Check if critical sources succeeded (via `source_outcomes`)
  - If critical sources failed and total budget has headroom: return `(False, failed_clusters)`
- If insufficient: re-dispatch failed clusters with extended timeout (1.5x original)
- If still insufficient after retry: populate `scratchpad.skipped_sources` and continue
- Log: "Research sufficiency: {sufficient/insufficient} — {details}"

#### A4. Conclusion extraction (`pebble/research_context.py` MODIFY)
Add `condense()` method to `ProspectResearchContext`:
- Extract key findings from `raw_data` into `conclusions: dict[str, Any]` field:
  - `"person_roles"`: list of (title, org, source) tuples from claims
  - `"financial_summary"`: total contributions, assets, compensation if available
  - `"org_connections"`: list of connected org names + relationship type
  - `"source_count"`: number of sources that returned data
- Clear processed `raw_data` entries (keep claims, conclusions, source_scores)
- Add `conclusions: dict[str, Any] = field(default_factory=dict)` to the dataclass

Call `ctx.condense()` in `clusters/__init__.py` after all clusters complete and claims are merged.

#### A5. Claim conflict detection (NEW `pebble/clusters/conflict_detector.py`)
- `detect_conflicts(claims: list[dict], person_name: str) -> list[dict]`
- Detect:
  - **Role conflicts**: same person listed with different current titles at same org (check claims with "serves as" or "is" patterns)
  - **Financial conflicts**: significantly different figures for same metric from different sources
  - **Temporal conflicts**: claim says "current" but another source says "former" for same position
- Each conflict: `{"type": "role"|"financial"|"temporal", "claim_a": str, "claim_b": str, "description": str}`
- Return list of conflicts (may be empty)

#### A6. Wire into handlers
- `pebble/handlers/tier2.py` (MODIFY): After cluster research, if `scratchpad.skipped_sources` is non-empty, append a note to response text
- `pebble/handlers/tier3.py` (MODIFY):
  - Call `detect_conflicts()` before synthesis
  - Pass conflicts + skipped_sources into synthesis prompt
  - Add to Opus system prompt: "The following data conflicts were detected: {conflicts}. Address them in your analysis. The following sources were unavailable: {skipped}."

#### A7. Doc update (15 min)
- `docs/PLAN-INDEX.md` — mark Stage B Sprint 1 complete, add Sprint 6/7/8
- `docs/architecture-decisions.md` — add entry for agentic alignment decisions

### What to build — Part B: Test Coverage

Follow existing patterns from `pebble/tests/test_propublica_xml.py` (class-based, @patch decorators, MagicMock).

#### B1. Router tests (NEW `pebble/tests/test_router.py`)
- Test regex redirect patterns (drafting → CoWork, calendar → Calendar)
- Test LLM classification mock (mock model_client, verify routing levels)
- Test entity extraction (person_name, org_name from query)
- Test fallback behavior (no client → defaults to L1)
- Test mode override (mode="full" → level 30)

#### B2. CRM agent tests (NEW `pebble/tests/test_crm_agent.py`)
- Test tool-use loop (mock model_client returning tool_use, verify tool dispatch)
- Test guardrails (max 5 tool calls, 15s timeout, $0.02 cost cap)
- Test write permission gating (no permissions → write tools hidden)
- Test conversation context threading

#### B3. Cluster tests (NEW `pebble/tests/test_clusters.py`)
- Test financial cluster: mock all data sources, verify claims generated
- Test affiliation cluster: mock data sources, verify FINRA + LDA integration
- Test public_profile cluster: mock Wikipedia + web search
- Test cluster timeout handling (asyncio.TimeoutError → empty claims)
- Test budget exhaustion (budget.can_call() returns False → stops queuing)

#### B4. CRM bridge + tools tests (NEW `pebble/tests/test_crm_bridge.py`)
- Test read methods (mock httpx responses, verify correct Bedrock URLs)
- Test write methods (create_account, create_contact — mock POST)
- Test error handling (HTTP errors → return None)
- Test tool execution dispatch (tool name → correct bridge method)
- Test write permission check

#### B5. Agentic alignment tests
- Test `_assess_sufficiency()` (critical source failed → returns insufficient)
- Test `condense()` (raw_data → conclusions, raw_data cleared)
- Test `detect_conflicts()` (contradictory claims → flagged)
- Test retry logic (failed cluster → re-dispatched)

#### B6. Integration test (NEW `pebble/tests/test_integration.py`)
- 1 end-to-end test: query string → route → dispatch → handle → response
- Mock all external calls (LLM, data sources, CRM bridge)
- Verify: response has text, level, cost; no exceptions

### Key constraints
- All data source calls must be mocked in tests (no real API calls)
- LLM calls (Haiku, Opus) must be mocked
- CRM bridge calls must be mocked
- Existing 77 tests must still pass
- `condense()` must not break tier data reuse — only call AFTER all clusters complete
- Sufficiency retry must respect overall budget (don't double-spend)
- Conflict detection is heuristic, not ML — simple string/pattern matching

### Verification
1. `pytest pebble/tests/ -v` — all tests pass (existing 77 + new)
2. Scratchpad tracks source outcomes after cluster research
3. Sufficiency assessment identifies missing critical sources
4. `condense()` reduces raw_data to conclusions
5. Conflict detector flags contradictory claims
6. T2 response includes "data unavailable" note when sources fail
7. T3 synthesis prompt includes conflicts and skipped sources
8. Doc updates committed
