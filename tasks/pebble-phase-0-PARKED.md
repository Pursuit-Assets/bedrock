# ⚠️ PARKED: feat/pebble-phase-0 — DO NOT MERGE WITHOUT JP'S OK

**Branch:** `feat/pebble-phase-0`
**Status:** parked, L1 scope complete — pushed to remote so the work
            is saved. Awaiting JP's signal to unpark + open PR.
**Last updated:** 2026-05-08

This branch contains substantial in-flight work on Pebble's Ask chat
path — search rebuild, audit middleware, agentic orchestrator,
end-to-end SSE wire-up, frontend panel, one worked workflow.

## What's done (and tested)

### Foundation (commits at parking point 2026-05-07)

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
  * **Orchestrator package** —
    `pebble/orchestrator/{schemas,budget,tools,scratchpad,executor,
    builtin_tools,planner,evaluator,renderer,chat_orchestrator}.py`.
  * **Frontend v2 dual-mode GlobalSearch** + vitest infrastructure.

### L1 wire-up (commits 2026-05-08)

Per JP's L1 scope decision: wire orchestrator + one worked workflow
+ charts. propose_write, sf_*_mirror tables, additional metrics
deferred to follow-up branches.

  * **`pebble/llm/`** — AsyncAnthropic client with prompt caching
    (~20% cost reduction). PlannerLLMClient + EvaluatorLLMClient
    protocols implemented. Cost accounting per call.
  * **chat_orchestrator refactor** — `run_stream_with_plan(plan,
    allow_replan=False)` exposed for workflow short-circuit.
  * **`generate_chart` tool** — pure ChartSpec emitter, planner-
    callable, JSON-schema enum on kind.
  * **`pebble/workflows/weekly_pipeline_review.py`** — first worked
    example. Three views (at-risk, stale, coverage). Sources data
    via `crm_bridge.get_opportunities()`. Registered as
    `aggregate_pipeline_views` tool so planner can also invoke it.
  * **`/pipeline` slash command** — router level=2 short-circuit.
    Bypasses LLM classifier; runs deterministic workflow.
  * **`pebble/orchestrator/sse.py`** — canonical `{kind, payload}`
    SSE encoder. encode_event / encode_error / encode_keepalive.
  * **`pebble/handlers/streaming.py`** — orchestrator construction
    + dispatch entry. Env-flag gate `PEBBLE_USE_ORCHESTRATOR`.
  * **`pebble/main.py:chat_query`** — SSE streaming for level in
    {1+orch, 2}; existing JSON path for everything else. Honors
    `X-Pebble-Force-Tier=L0` header.
  * **`routes/pebble_proxy.py`** — error frames switched to
    `{kind, payload}` matching the orchestrator's vocabulary.
  * **Frontend `/pebble` route** — single-conversation page with
    PlanTrace (plan-as-todos), ConversationView, ChartRenderer
    (Recharts), CitationList, MessageInput. URL `?conv=<uuid>` for
    shareable links.
  * **Frontend GlobalSearch Ask mode** — consumes new `{kind,
    payload}` stream. "Continue in Pebble →" CTA navigates to
    `/pebble?conv=<id>`.
  * **PebbleConversationContext** — useReducer state, discriminated
    union over event.kind, auto-cancel on unmount.

Test totals on the branch: **1052 backend + 672 pebble + 48 frontend
= 1772 tests passing** (was 1573 at parking point — +199 new).

## What's NOT done — required before/after merge

### Must-have for production

  1. **Apply the 6 migrations to staging/prod DB.** Files exist in
     `financial_forecasting/db/migrations/` (audit + search +
     scratchpad). Per JP/Jac decision 2026-05-08: stay-as-files for
     now, Jac applies on unpark. Idempotent; pgvector required.

  2. **Set `PEBBLE_USE_ORCHESTRATOR=true` in the staging env** when
     ready. Default OFF means the orchestrator path is dormant
     until you flip it. JSON dispatcher path stays for everything.

  3. **3-way merge with main** — main has moved 10 commits since
     branch base (cashflow polish, auth fix, perms grant). Conflict
     surfaces are clean (different file regions); resolve at unpark.

### L2 follow-up (separate PRs)

  4. **`propose_write` tool + JWT confirm flow** — write actions
     require their own design pass + security review.
  5. **`query_metric` tool + `sf_*_mirror` tables** — multi-day
     subsystem (sync, watermark, backfill, monitoring). When mirrors
     ship, swap `aggregate_pipeline_views` SQL backend without API
     change.
  6. **Additional workflows** — daily_digest, pre_call_briefing,
     renewal_check. Pattern is established; each is ~1 day.
  7. **History sidebar in /pebble** — `<HistorySidebar />` slot
     exists; populate via existing `/api/v1/chat/history`.
  8. **Always-on header omnibox** in AppShell. Per architecture doc.
  9. **Slash commands** `/digest`, `/at-risk`, `/research <name>`.
  10. **Conversation soft-delete + retention.**

### Operational

  11. **Real Anthropic happy-path cassette capture.** Two cassettes
     ship with hand-shaped responses; for production confidence,
     capture a real call once and pin.
  12. **End-to-end browser test** of /pebble flow via the gstack
     `/qa` skill once dev DB has migrations applied.

## How to resume

  * Open this file; review the not-done list.
  * Read `tasks/pebble-bi-architect.md` for the design.
  * Set `PEBBLE_USE_ORCHESTRATOR=true` + `ANTHROPIC_API_KEY` in dev
    env to enable the new path.
  * Hit `/api/v1/chat/query` with a level=1 query (e.g. "what's at
    risk for Acme this quarter?") to exercise the orchestrator.
  * Hit `/api/v1/chat/query` with `query="/pipeline"` to exercise
    the workflow path.

## Related docs

  * `tasks/pebble-bi-architect.md` — full design.
  * `tasks/pebble-search-spec.md` — search rebuild spec.
  * `tasks/pebble-overhaul-plan.md` — master plan.
  * Project memory `project_pebble_evolution.md` — 4-stage roadmap.

## Why parked

JP's directive 2026-05-07: build as much as you can as well as you
can — enterprise grade. Then on 2026-05-08: confirmed L1 scope
(wire + one workflow + charts), shipped. Branch holds for review-
budget reasons (Jac); PR opens when JP says go.
