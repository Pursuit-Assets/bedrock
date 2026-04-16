# Sprint 10: Pebble PostgreSQL + Async Migration (Track A — Database Infrastructure)

## Context

Pebble uses synchronous SQLite (`pebble/pebble.db`) for all storage. This must migrate to PostgreSQL (asyncpg) in the `bedrock` schema with `pebble_` prefix. SQLite data loss on restart, no concurrent access, and sync-in-async event loop blocking make it unsuitable for production.

## Prerequisites

- Sprint 9 complete (schema qualification, segundo-db verified)
- `bedrock` schema accessible on segundo-db

## Scope

### 1. Create 12 Pebble tables in bedrock schema

10 migrated from SQLite + 2 new (conflict_log, scratchpad). See `docs/database-schema.md` Domain D for full DDL. All use `bedrock.pebble_*` naming.

Fresh start -- no data migration from SQLite.

### 2. Rewrite storage layer: sqlite3 -> asyncpg (7 core files)

| File | What changes |
|---|---|
| `pebble/storage/db.py` | Replace sqlite3 with asyncpg pool. All 20+ functions become async. Connection pool shared with Bedrock or separate pool via same DATABASE_URL. |
| `pebble/storage/cache.py` | Replace sqlite3 `_get_conn()` with async pool access. `get_cached()`, `set_cached()`, `clear_expired()` become async. |
| `pebble/main.py` | `init_db()` call becomes async (already in lifespan). All storage function calls get `await`. ~15 call sites. |
| `pebble/harness.py` | `log_harness_outcome()` becomes async. Already called via `asyncio.to_thread()` from orchestrator. |
| `pebble/data_sources/finra.py` | `get_cached()` / `set_cached()` calls become `await`. |
| `pebble/data_sources/lda.py` | Same as finra.py. |
| `pebble/data_sources/propublica.py` | Same as finra.py. |

### 3. Propagate async to dependent files (~26 files)

Handlers, clusters, orchestrator already use `async def` and call data sources via `asyncio.to_thread()`. After migration:

- Data source cache calls (finra, lda, propublica) become natively async -- remove `asyncio.to_thread()` wrappers for those calls
- `harness.log_harness_outcome()` becomes async -- update call sites in harness + orchestrator
- Storage calls in `main.py` endpoints already in async context -- just add `await`

### 4. Schema changes (SQLite -> PostgreSQL)

| SQLite pattern | PostgreSQL equivalent |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `UUID PK DEFAULT uuid_generate_v4()` |
| `TEXT DEFAULT (datetime('now'))` | `TIMESTAMPTZ DEFAULT now()` |
| `REAL` | `NUMERIC` |
| `INTEGER` (boolean) | `BOOLEAN` |
| `PRAGMA journal_mode=WAL` | Remove (PostgreSQL MVCC handles concurrency natively) |
| `INSERT OR REPLACE` | `INSERT ... ON CONFLICT ... DO UPDATE` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |
| `datetime('now', '-30 days')` | `now() - INTERVAL '30 days'` |

### 5. Table name mapping

| SQLite table | PostgreSQL table |
|---|---|
| `profiles` | `bedrock.pebble_profiles` |
| `research_sessions` | `bedrock.pebble_research_sessions` |
| `feedback` | `bedrock.pebble_feedback` |
| `harness_log` | `bedrock.pebble_harness_log` |
| `source_scores` | `bedrock.pebble_source_scores` |
| `api_cache` | `bedrock.pebble_api_cache` |
| `chat_conversations` | `bedrock.pebble_chat_conversations` |
| `chat_messages` | `bedrock.pebble_chat_messages` |
| `research_batches` | `bedrock.pebble_research_batches` |
| `batch_prospects` | `bedrock.pebble_batch_prospects` |
| (new) | `bedrock.pebble_conflict_log` |
| (new) | `bedrock.pebble_scratchpad` |

## Files to modify

**Core rewrites:**
- `pebble/storage/db.py`
- `pebble/storage/cache.py`
- `pebble/storage/__init__.py`
- `pebble/main.py`
- `pebble/harness.py`
- `pebble/data_sources/finra.py`
- `pebble/data_sources/lda.py`
- `pebble/data_sources/propublica.py`

**Async propagation (add `await` to storage calls):**
- `pebble/orchestrator.py`
- `pebble/handlers/*.py` (if they call storage directly)

**New DDL:**
- `financial_forecasting/db/init.sql` (add Pebble table definitions) or `pebble/db/init.sql` (new file)

## Verification

```bash
# Create tables on segundo-db
psql ... -f <pebble init SQL>

# Verify 12 pebble_ tables exist
psql ... -c "SELECT tablename FROM pg_tables WHERE schemaname = 'bedrock' AND tablename LIKE 'pebble_%';"

# Start Pebble with DATABASE_URL pointed at segundo-db
# Run a research query end-to-end
# Verify data appears in pebble_research_sessions, pebble_profiles, pebble_harness_log
# Verify chat messages persist in pebble_chat_messages
# Run existing tests (236 tests) -- many will need async fixtures (pytest-asyncio)
```

## Estimated effort

Large -- 2-3 sessions. Core rewrite is ~1 session, async propagation + testing is ~1-2 sessions.
