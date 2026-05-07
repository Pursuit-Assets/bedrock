# ⚠️ PARKED: feat/pebble-phase-0 — DO NOT MERGE AS-IS

**Branch:** `feat/pebble-phase-0`
**Status:** parked, unfinished — pushed to remote so the work is saved.
**Last updated:** 2026-05-07

This branch contains substantial in-flight work on Pebble's Ask chat
path — search rebuild, audit middleware, agentic orchestrator. Each
commit individually passes its tests. The branch as a whole is not
production-ready.

## What's done (and tested)

  * **Search rebuild** — `bedrock.search_doc` + `search_index_queue`
    + composer triggers + indexer worker; `/api/search` read route
    with permission filter via canonical `routes.permissions`.
  * **Internal-key auth hardening** — kill switch
    (`PEBBLE_WRITES_DISABLED`), mandatory `X-Originating-User` +
    `X-Request-Id` headers, scope checking.
  * **Audit middleware** — `bedrock.pebble_write_audit` populated on
    every internal-key write; `search_audit_access_log` for the read
    path.
  * **Pebble proxy** — `/api/pebble/ask` SSE relay with daily-cost
    cap and 80% degrade-to-L0 trigger.
  * **Orchestrator package** (NEW, this branch's last commit):
    - `pebble/orchestrator/{schemas,budget,tools,scratchpad,executor,
      builtin_tools,planner,evaluator,renderer,chat_orchestrator}.py`
    - 117 new unit tests, 27 + 20 + 25 + 22 + 13 + (10 carried).
    - Legacy `pebble/orchestrator.py` moved to
      `pebble/orchestrator/_pipeline.py`; symbols re-exported.
  * **Frontend v2 dual-mode GlobalSearch** + vitest infrastructure.

Test totals on the branch: **1052 backend + 497 pebble + 24 frontend
= 1573 tests passing**.

## What's NOT done — required before merge

  1. **Wire chat_orchestrator into `/api/pebble/ask` route.** The
     orchestrator is fully built and tested but the SSE route still
     calls the OLD path. Need to add an `AnthropicClient`
     implementation conforming to `PlannerLLMClient` /
     `EvaluatorLLMClient` protocols and pass it into a
     `ChatOrchestrator` per request.
  2. **No real LLM client implementation yet.** The orchestrator's
     planner/evaluator are dependency-injected; tests use stubs.
     Production needs a thin wrapper around Anthropic's Messages API
     in `pebble/llm/anthropic_client.py` — does not exist.
  3. **Frontend Pebble panel.** The dual-mode search dropdown lands
     "Ask" mode but the response surface is still the placeholder.
     Need to consume the SSE event stream and render plan-as-todos +
     citations + suggested-action cards.
  4. **`/pebble` route in App.tsx.** Sidebar entry exists but
     dead-links — no route handler.
  5. **Concrete workflows** (weekly_pipeline_review, daily_digest,
     pre_call_briefing, renewal_check). Architecture-doc says these
     are 1.0 ship items; none implemented.
  6. **Additional tools** (`query_metric`, `propose_write`,
     `generate_chart`). Stubbed in the architecture doc; not built.
  7. **SF mirror tables** (`sf_account_mirror`, etc.). Multi-day
     work; orchestrator currently calls /api/search and Bedrock REST
     directly.
  8. **Migrations not applied to prod.** Six migrations land in
     `database/migrations/` (audit + search + scratchpad). Need
     manual review + apply.

## Why parked

JP's directive 2026-05-07: "build as much as you can as well as you
can — enterprise grade." That said: review-budget on Jac is tight
(per JP's prefer-prs memory), so we bundle the work onto one branch
and wait for an explicit unparking signal before opening a PR.

## How to resume

  * Open this file; review the not-done list.
  * Spawn `pebble-dev` agent for the chat_orchestrator wiring task.
  * Spawn `frontend` agent for the Pebble panel + /pebble route.
  * Build `pebble/llm/anthropic_client.py` BEFORE wiring the route —
    everything else depends on it.

## Related docs

  * `tasks/pebble-bi-architect.md` — full design.
  * `tasks/pebble-search-spec.md` — search rebuild spec.
  * `tasks/pebble-overhaul-plan.md` — master plan.
  * Project memory `project_pebble_evolution.md` — 4-stage roadmap.
