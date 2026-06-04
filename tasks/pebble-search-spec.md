# Pebble 1.0 — Enterprise-Grade Search: Unified Spec

> **Status:** Build spec. Synthesized from `pebble-search-spec-backend.md`, `pebble-search-spec-ux.md`, `pebble-search-spec-security.md`. Read those for depth; this doc is the build order.
> **Date:** 2026-05-06
> **Anchored against:** `origin/main`. Built on `feat/pebble-phase-0` worktree.
> **Bar:** "Enterprise level tool out of the box" — JP, 2026-05-06. No shortcuts.

## Decisions, locked

These are the load-bearing calls. Companion specs argue them; this doc commits.

1. **Backend = Postgres FTS (tsvector + GIN) for v1.0, pgvector embeddings as additive overlay.** One denormalized `bedrock.search_doc` table, queue-drained indexer, pg_trgm for typo tolerance. Data stays in-house. (`backend §1`)
2. **Permission model = pre-filter via accessible-id subquery in SQL, NEVER post-filter in Python.** Per-request resolution, request-scoped cache, no cross-request cache. (`security §1`, `backend §4`)
3. **`X-Originating-User` is mandatory on every internal-key write/search.** Reject service calls without it. Pebble becomes a delegated principal, not a god principal. (`security §1.5`)
4. **Two audit tables.** `bedrock.pebble_write_audit` (writes) + `bedrock.search_audit` (queries). 90d hot, 13mo Parquet archive. Full `query_text` stored, admin-gated read, access logged separately. (`security §2`)
5. **One bar, two modes.** GlobalSearch.tsx extends to `Find | Ask` segmented + permanent footer chip + `?`/`/` prefix. Inline takeover for Ask responses (NOT slide-over). Sidebar `/pebble` entry using the unused `Sparkles` import. (`ux §1, §6, §7`)
6. **Multi-tenant column from day 1.** `org_id` is the outermost predicate everywhere, default `'pursuit'`. CI grep enforces. (`security §7`)
7. **Trace propagation.** `X-Trace-Id` (UUIDv7) FE → Bedrock → Pebble → DB. 100% sampling at 1.0 scale. (`security §5`)
8. **Circuit breakers per backend** with explicit graceful-degradation order: `pgvector → postgres_fts → sf_sosl_fallback → empty + banner`. Permission resolver fails closed. (`security §6`, `backend §8`)
9. **Latency SLO p95 ≤ 200ms Find, p95 ≤ 3s first-token Ask.** `min-instances=1` on Cloud Run, dedicated read-only asyncpg pool for search. (`backend §5`)
10. **No SaaS data egress.** No Algolia, no external embeddings until vetted. pgvector + Voyage-3 embeddings (data-residency TBD; defer to v1.1). (`backend §1`)

## Architecture sketch

```
Frontend GlobalSearch (Find | Ask)
   │ /api/search?q=...&types=...&facets=...   /api/pebble/ask
   ▼                                             ▼
Bedrock :8000 ──── routes/search.py    ──── routes/pebble_proxy.py
   │  permission resolver (request-scoped)         │  proxy + cost gate
   │  search_crm tool gateway                      ▼
   ▼                                          Pebble :8001
PostgreSQL (Cloud SQL)                            │  router.classify_query
   │  bedrock.search_doc (GIN tsvector + pgvector)│  L1+ tools call /api/search
   │  bedrock.search_index_queue (LISTEN/NOTIFY)  │  via crm_bridge.py + X-Originating-User
   │  bedrock.search_audit                        ▼
   │  bedrock.pebble_write_audit              streams response
   │  bedrock.sf_*_mirror (thin SF mirrors)
   ▼
Async indexer worker (asyncio task in main.py lifespan)
```

## Build order

Each item: own commit on `feat/pebble-phase-0`, tests included, no shortcuts. Sequence respects dependencies.

### Phase 0 — Foundation (entry condition for everything else)

| # | Item | Depends on | Status |
|---|---|---|---|
| 0.5 | PEBBLE_WRITES_DISABLED kill switch in `auth.py` | — | ✅ DONE (commit 0372f33) |
| 0.6 | BEDROCK_API_URL startup assertion | — | next |
| 0.1 | `bedrock.pebble_write_audit` migration + idempotency UNIQUE on request_id | — | |
| 0.2 | X-Originating-User enforcement in `auth.py:require_auth_or_internal` | 0.1 | |
| 0.3 | Per-service rate limit (custom key_func keyed on `is_service`) | 0.2 | |
| 0.4 | Internal-key scopes in synthetic user dict | 0.2 | |
| 0.7 | Idempotency middleware (`X-Request-Id`, 24h replay window via 0.1's UNIQUE) | 0.1, 0.2 | |
| 0.9 | `services/sf_stages.py` canonical stage source + `bedrock.sf_picklist_cache` | — | |
| 0.10 | frontend-v2 vitest infrastructure + 1 sample test + CI step | — | |
| 0.8 | Audit-log integration in existing `logger.info` lines | 0.2 | |

### Layer 1 — Search infrastructure

| # | Item | Depends on |
|---|---|---|
| 1.1 | `bedrock.search_doc` table + GIN/trgm/vector indexes migration | Phase 0 done |
| 1.2 | `bedrock.search_index_queue` table + trigger function migration | 1.1 |
| 1.3 | `bedrock.search_audit` table migration | 0.1 |
| 1.4 | Thin SF mirror tables (`sf_account_mirror`, `sf_contact_mirror`, `sf_opportunity_mirror`, `sf_task_mirror`) | 1.2 |
| 1.5 | Mirror sync extension in `data_sync.py` (watermarked, 60s loop) | 1.4 |
| 1.6 | Indexer worker in `main.py` lifespan (LISTEN/NOTIFY + 2s polling fallback) | 1.2 |
| 1.7 | Backfill script for one-shot index population | 1.6 |
| 1.8 | `routes/search.py` — `/api/search` endpoint with permission resolver | 1.1, 0.4 |
| 1.9 | Circuit breakers (`pybreaker`) per backend | 1.8 |
| 1.10 | Test matrix: 4 profiles × all entity types × access scenarios | 1.8 |

### Layer 2 — Frontend (depends on 1.8 stable)

| # | Item |
|---|---|
| 2.1 | Vitest config + a11y test harness (`@testing-library/react`, `axe-core`) |
| 2.2 | `GlobalSearch.tsx` dual-mode refactor: segmented Find/Ask, footer Ask chip, `?`/`/` prefix |
| 2.3 | Result card components per entity type with WAI-ARIA Editable Combobox pattern |
| 2.4 | Facet chips (entity, mine/team, recency, status) |
| 2.5 | Saved searches reuse `bedrock.saved_view` with `view_kind` discriminator |
| 2.6 | Recent-search history via `GET /api/search/history` |
| 2.7 | `/pebble` sidebar nav entry (Sparkles icon, AppShell.tsx:11) |
| 2.8 | First-login coachmark for search discoverability |
| 2.9 | Mobile responsive: full-screen sheet < 768px |

### Layer 3 — Pebble Ask integration (depends on Layer 1 + Pebble alive)

| # | Item |
|---|---|
| 3.1 | `routes/pebble_proxy.py` — `/api/pebble/ask` (HTTP forward to Pebble :8001) with cost gate |
| 3.2 | Trace + originating-user header propagation |
| 3.3 | New `search_crm` tool in `pebble/tools/` calling `/api/search` |
| 3.4 | Streaming SSE response from Pebble through Bedrock to FE |
| 3.5 | Suggested-action cards (read-only at 3.x; writes deferred) |

### Layer 4 — Observability + Ops

| # | Item |
|---|---|
| 4.1 | `X-Trace-Id` middleware in both processes |
| 4.2 | Structured JSON logging |
| 4.3 | Cloud Monitoring custom metrics emission |
| 4.4 | Anomaly batch job (Cloud Scheduler → Cloud Run) |
| 4.5 | Pre-launch checklist verification |

## Test bar (per item)

- Unit: every public function on every code path, parameterized for edge cases
- Integration: route-level for every new endpoint
- Permission: matrix across 4 profiles × every entity × access/no-access
- Concurrency: race tests where applicable (singleton, queue drain)
- A11y: axe-core in v2 component tests
- Observability: assert audit row written on every gated path

## Open product calls deferred to JP

These don't block building — pick a default, JP overrides.

1. UX: inline vs slide-over for Ask response — defaulting **inline** per UX agent's argument.
2. `view_contact_email` permission default — defaulting **ON for RM/Exec/PM**.
3. Recent-search retention — defaulting **30 days**.
4. Ask cost cap — defaulting **$5/user/day** (matches existing `pebble_daily_usage`).
5. Anomaly threshold per-profile — defaulting **uniform 100 records/hour**, refine post-launch.
6. v1-frontend deprecation date — defaulting **2026-Q3**.

## What I don't do without JP's call

- Open the eventual PR (JP confirms when 1.0 is reached)
- Change SF picklist values
- Apply migrations to prod (only to dev DB / test DB until JP says go)
- Modify any production secret
