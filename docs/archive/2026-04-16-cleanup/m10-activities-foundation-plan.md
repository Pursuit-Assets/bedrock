# M10: Activities Foundation (Backend Only) — Vetted Implementation Plan

**Milestone**: M10 (was Sprint 9A)
**Prerequisite**: M9 (Schema Qualification) must be complete — all SQL uses `bedrock.` prefix

## Context

Bedrock mirrors Salesforce data locally. The team needs Activities (logged meetings, emails, calls) synced from SF Tasks + Events into a local PostgreSQL table, with CRUD/search endpoints. This sprint is backend-only — zero frontend changes.

**Current state**: SF Tasks are queried live via SOQL (no local storage). SF Events are not synced at all. No `activity` table exists in PostgreSQL.

**Source plan**: `tasks/sprint9-activities-extension-plan.md`
**Sprint index**: `docs/PLAN-INDEX.md` (M10 entry)

---

## Decisions Made (Verified in Planning Session)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Schema prefix | **Use `bedrock.` prefix on ALL SQL** — M9 runs first | M9 prefixes all existing SQL. M10 writes `bedrock.activity` from day one. **Every table reference in routes, sync, and tests must use `bedrock.` prefix** (e.g., `bedrock.activity`, `bedrock.project_task`). SQL snippets in this plan show bare names for readability — implementation must prefix all of them. |
| 2 | DB access for sync | Add `get_pool()` to db.py, pass to DataSyncService | Clean accessor, no circular imports, backward compatible via `db_pool=None` default |
| 3 | Sync watermark | `MAX(sf_last_modified) FROM activity WHERE source = 'salesforce'` | No extra table needed. NULL = full sync. Self-correcting. |
| 4 | Permissions | Reuse existing keys (`view_tasks`, `create_tasks`, `trigger_data_sync`) | Avoids updating 3 profiles + backfills. Can split later. |
| 5 | GCS attachments | Defer to 9C | Schema column exists (`attachments JSONB`), but upload code not needed until extension |
| 6 | Thread-aware email | Defer to 9C | Schema column exists (`source_thread_id`), logic not needed until extension |
| 7 | AI insights | Structured output with graceful degradation | Always returns `{summary, key_findings[], action_items[], momentum, confidence}`. Falls back to raw text in summary if parse fails. |
| 8 | SF pagination | Use `query_all()` (auto-paginates via simple-salesforce) | Exists at `salesforce.py:253`, proven in codebase |
| 9 | Sync gate | Run `sync_activities()` BEFORE the Intacct check in `sync_all_data()` | Activities sync needs only SF+DB, not Intacct. Isolated try/except ensures Intacct syncs run even if activity sync fails. |
| 10 | Sync trigger | Both: existing trigger includes activities via `sync_all_data()`, plus dedicated `/api/activities/sync/trigger` | Background loop covers it, admins can trigger activity-only sync independently. |
| 11 | _sync_lock | Move from `main.py` to `dependencies.py` | Avoids circular import (main.py imports routes/activities.py, activities.py needs the lock). Update test imports. |
| 12 | Task linking | `project_task_id UUID FK` + `sf_task_id TEXT` | project_task_id: FK to Bedrock project tasks (real use case — Activities relate to project work). sf_task_id: stores SF Task ID linked/completed when logging (admin debugging + audit trail). |
| 13 | Soft delete | `deleted_at TIMESTAMPTZ` for activity table only | Required: prevents sync resurrection of hard-deleted records. UPSERT WHERE guard skips soft-deleted rows. Project hierarchy soft-delete is a separate follow-up sprint. |
| 14 | Match-context | All 3 tiers (exact email, domain match, fuzzy name) | Full implementation. `difflib.SequenceMatcher` already imported at `main.py:10`. |
| 15 | Error isolation | `sync_activities()` wrapped in its own try/except inside `sync_all_data()` | Activity sync failure does NOT block Intacct syncs. Fully independent failure domains. |

---

## Concurrency Model (Verified)

**Three entry points to sync, one shared lock:**
1. Background loop (every 15 min) — SKIPS if lock held (non-blocking check)
2. Existing `POST /api/sync/trigger` — returns 409 if lock held
3. New `POST /api/activities/sync/trigger` — returns 409 if lock held

**Verified scenarios:**
- Background running + user triggers: user gets 409. No cancellation.
- Two users trigger simultaneously (race window): both get 200, tasks run sequentially, second finds nothing new (watermark moved). Idempotent UPSERT. No data issues.
- sync_activities() hangs: lock held until SF timeout (~300s). Background loops skip. Manual triggers return 409. Lock auto-releases on exception.
- Multiple uvicorn workers: lock is per-process, but PostgreSQL `ON CONFLICT` makes UPSERT idempotent at DB level. No corruption.

**Pebble interaction**: Pebble is a separate process (port 8001) with its own SQLite DB. Communicates with Bedrock via HTTP. Pebble batch research does NOT trigger Activity sync. No concurrency concern.

**Guardrails:**
1. `_sync_lock` in `dependencies.py` — shared across main.py and routes/activities.py without circular imports
2. Isolated try/except for `sync_activities()` in `sync_all_data()` — error isolation
3. UPSERT `WHERE activity.deleted_at IS NULL` — respects soft-deleted records
4. `_sync_lock.locked()` check before queueing background task — immediate 409 feedback

---

## Implementation Sequence

### Step 1: `db.py` — Add `get_pool()` accessor

**File**: `financial_forecasting/db.py`

Add after `close_db()` (after line 42):
```python
def get_pool() -> asyncpg.Pool:
    """Return the connection pool (for services that need direct access)."""
    if _pool is None:
        raise Exception("Database not available")
    return _pool
```

### Step 2: `dependencies.py` — Add sync lock, sync service dependency

**File**: `financial_forecasting/dependencies.py`

Add:
- `import asyncio`
- `_sync_lock = asyncio.Lock()` — moved from main.py:127
- `get_data_sync_service()` function — moved from main.py:223-228 (needs `from data_sync import DataSyncService` for type hint)

No circular imports: dependencies.py → data_sync.py → models.py. None import back.

### Step 3: `db/init.sql` — Append activity table

**File**: `financial_forecasting/db/init.sql`

Append after line 320 (after permission backfills). Schema:

```sql
-- ---------------------------------------------------------------------------
-- Activities (synced from SF Tasks + Events, plus manual/extension entries)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bedrock.activity (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Salesforce identifiers (for mirror sync)
    sf_id TEXT UNIQUE,
    sf_type TEXT CHECK (sf_type IN ('Task', 'Event')),

    -- Core fields
    type TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note', 'slack-message', 'calendar-event')),
    subject TEXT NOT NULL,
    description TEXT,
    description_html TEXT,
    activity_date TIMESTAMPTZ NOT NULL,

    -- Association (Opportunity-first model)
    opportunity_id TEXT,
    account_id TEXT,
    contact_ids TEXT[] DEFAULT '{}',
    project_task_id UUID REFERENCES project_task(id) ON DELETE SET NULL,
    sf_task_id TEXT,

    -- Source tracking
    source TEXT NOT NULL CHECK (source IN ('salesforce', 'extension', 'manual', 'gmail-sync', 'calendar-sync')),
    source_ref TEXT,
    source_thread_id TEXT,

    -- Email-specific fields
    email_from TEXT,
    email_to TEXT[],
    email_cc TEXT[],
    email_snippet TEXT,

    -- Meeting-specific fields
    meeting_duration_minutes INTEGER,
    meeting_attendees JSONB,
    meeting_location TEXT,

    -- Attachments (GCS URLs — populated by extension in 9C)
    attachments JSONB DEFAULT '[]',

    -- Ownership
    logged_by TEXT,
    owner_id TEXT,

    -- Sync metadata
    sf_last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ,
    sf_sync_status TEXT DEFAULT 'synced' CHECK (sf_sync_status IN ('synced', 'pending', 'failed')),

    -- Full-text search
    search_vector TSVECTOR,

    -- Soft delete (required: prevents sync resurrection of deleted records)
    deleted_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_activity_opportunity ON activity(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_activity_account ON activity(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_contact ON activity USING GIN(contact_ids);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity(activity_date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity(type);
CREATE INDEX IF NOT EXISTS idx_activity_source ON activity(source);
CREATE INDEX IF NOT EXISTS idx_activity_sf_id ON activity(sf_id);
CREATE INDEX IF NOT EXISTS idx_activity_search ON activity USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_activity_thread ON activity(source_thread_id);
CREATE INDEX IF NOT EXISTS idx_activity_not_deleted ON activity(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_activity_project_task ON activity(project_task_id);

-- Full-text search trigger (subject=A weight, snippet=B, description=C)
CREATE OR REPLACE FUNCTION activity_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.subject, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.email_snippet, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_activity_search_vector ON activity;
CREATE TRIGGER trg_activity_search_vector
    BEFORE INSERT OR UPDATE ON activity
    FOR EACH ROW EXECUTE FUNCTION activity_search_vector_update();

-- Updated_at trigger (reuses existing set_updated_at() function from line 64)
DROP TRIGGER IF EXISTS trg_activity_updated_at ON activity;
CREATE TRIGGER trg_activity_updated_at
    BEFORE UPDATE ON activity
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Key details:**
- `project_task_id UUID REFERENCES project_task(id) ON DELETE SET NULL` — FK to Bedrock project tasks. project_task is defined at line 39, so exists before activity table.
- `sf_task_id TEXT` — SF Task ID linked/completed when logging. No FK (SF is external).
- `sf_id TEXT UNIQUE` — allows multiple NULLs (PostgreSQL UNIQUE permits this). ON CONFLICT (sf_id) works for non-NULL values.
- Standalone triggers (not modifying the existing DO loop on line 72-84).
- `COMMENT ON TABLE/COLUMN` not included — column names are self-documenting with the CHECK constraints.

### Step 4: `models.py` — Add Activity enums and models

**File**: `financial_forecasting/models.py`

Add after `InvoiceStatus` enum (line 67). These are LOCAL models (map to PostgreSQL), not SF-aliased models:

- `ActivityType(str, Enum)` — CALL="call", EMAIL="email", MEETING="meeting", NOTE="note", SLACK_MESSAGE="slack-message", CALENDAR_EVENT="calendar-event"
- `ActivitySource(str, Enum)` — SALESFORCE="salesforce", EXTENSION="extension", MANUAL="manual", GMAIL_SYNC="gmail-sync", CALENDAR_SYNC="calendar-sync"
- `Activity(BaseModel)` — full response model, all fields Optional except type/subject/activity_date/source
- `ActivityCreate(BaseModel)` — POST request body. Required: type, subject, activity_date, source. All else Optional.
- `ActivityUpdate(BaseModel)` — PUT request body. All fields Optional.
- `ActivityInsightsRequest(BaseModel)` — opportunity_id or account_id (at least one required)
- `ActivityInsightsResponse(BaseModel)` — summary, key_findings, action_items, momentum, generated_at, confidence

### Step 5: `data_sync.py` — Add Activity sync

**File**: `financial_forecasting/data_sync.py`

**5a) Modify `__init__`** to accept `db_pool=None`:
```python
def __init__(self, mcp_client, db_pool=None):
    self.mcp_client = mcp_client
    self.db_pool = db_pool
    # ... existing fields unchanged
```

**5b) Add `sync_activities()` method:**

Logic flow:
1. Guard: if `self.db_pool` is None or `"salesforce"` not in `self.mcp_client.connected_services`, return early
2. Acquire connection from `self.db_pool`
3. Query watermark: `SELECT MAX(sf_last_modified) FROM activity WHERE source = 'salesforce'`
4. Build SOQL for Tasks:
   ```sql
   SELECT Id, Subject, Status, Priority, ActivityDate, Description,
          OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
          Type, TaskSubtype, CreatedById, CreatedBy.Name,
          CreatedDate, LastModifiedDate, IsClosed,
          CallType, CallDurationInSeconds
   FROM Task
   WHERE LastModifiedDate > {watermark}  -- omit for first run
   ORDER BY LastModifiedDate ASC
   ```
5. Build SOQL for Events:
   ```sql
   SELECT Id, Subject, Description, StartDateTime, EndDateTime,
          OwnerId, Owner.Name, WhoId, Who.Name, WhatId, What.Name,
          Type, Location, DurationInMinutes, IsAllDayEvent,
          CreatedById, CreatedBy.Name, CreatedDate, LastModifiedDate
   FROM Event
   WHERE LastModifiedDate > {watermark}  -- omit for first run
   ORDER BY LastModifiedDate ASC
   ```
6. Use `salesforce.query_all()` for auto-pagination
7. Map SF fields to activity columns:
   - **Task type mapping**: TaskSubtype='Email'→'email', TaskSubtype='Call'→'call', else check Type field, default→'note'
   - **Event type mapping**: IsAllDayEvent=True→'calendar-event', else→'meeting'
   - **WhatId routing**: prefix '006'→opportunity_id, prefix '001'→account_id
   - **WhoId routing**: prefix '003'→append to contact_ids array
   - **sf_type**: 'Task' or 'Event'
   - **source**: always 'salesforce'
   - **activity_date**: Task→ActivityDate, Event→StartDateTime
   - **meeting_duration_minutes**: Event→DurationInMinutes
   - **meeting_location**: Event→Location
8. UPSERT with soft-delete guard:
   ```sql
   INSERT INTO activity (sf_id, sf_type, type, subject, description, activity_date,
                         opportunity_id, account_id, contact_ids, source, owner_id,
                         logged_by, sf_last_modified, synced_at, ...)
   VALUES ($1, $2, $3, ...)
   ON CONFLICT (sf_id) DO UPDATE SET
       type = EXCLUDED.type,
       subject = EXCLUDED.subject,
       ...
       sf_last_modified = EXCLUDED.sf_last_modified,
       synced_at = now()
   WHERE activity.deleted_at IS NULL
   ```
9. Process records in loop with continue-on-error pattern
10. Log summary: "Synced {n} Tasks and {m} Events ({upserted} upserted, {skipped_deleted} skipped soft-deleted)"

**5c) Wire into `sync_all_data()`** — add BEFORE the Intacct check, with isolated try/except:
```python
async def sync_all_data(self):
    # SF → PostgreSQL (independent of Intacct, failure-isolated)
    if self.db_pool:
        try:
            await self.sync_activities()
        except Exception as e:
            logger.error(f"Activity sync failed (continuing): {e}")
            self.sync_history.append({
                "timestamp": datetime.now(), "type": "activity_sync",
                "status": "failed", "error": str(e)
            })

    # Intacct-dependent syncs (existing code, unchanged)
    if not self._intacct_available():
        logger.info("Skipping data sync — Sage Intacct not connected")
        return
    # ... existing sync_customer_mappings, sync_opportunity_invoicing, update_payment_statuses
```

### Step 6: `routes/activities.py` — New route file

**File**: `financial_forecasting/routes/activities.py` (NEW)

```python
router = APIRouter(prefix="/api/activities", tags=["activities"])
```

**Route declaration order** (static paths before `{id}` parameter):

| # | Path (relative to prefix) | Method | Auth | Purpose |
|---|---|---|---|---|
| 1 | `/sync/count` | POST | `check_permission("trigger_data_sync")` | SOQL count of SF Tasks + Events |
| 2 | `/sync/trigger` | POST | `check_permission("trigger_data_sync")` | Manual activity sync (uses shared _sync_lock) |
| 3 | `/sync/status` | GET | `require_auth` | Sync health: counts, last_sync, pending |
| 4 | `/search` | GET | `require_auth` | Full-text search (scoped + global) |
| 5 | `/match-context` | GET | `require_auth` | Contact matching — all 3 tiers |
| 6 | `/insights` | POST | `require_auth` | AI insights with structured output + graceful degradation |
| 7 | `/` | GET | `require_auth` | List with filters (opp, account, contact, type, date range) |
| 8 | `/` | POST | `require_auth` | Create activity (local + SF write-through) |
| 9 | `/{id}` | GET | `require_auth` | Get single by UUID |
| 10 | `/{id}` | PUT | `require_auth` | Update activity |
| 11 | `/{id}` | DELETE | `require_auth` | Soft delete (set deleted_at) |

**Key implementation details per endpoint:**

**Sync count (#1)**: Two SOQL queries via `client.salesforce.query()`: `SELECT COUNT() FROM Task`, `SELECT COUNT() FROM Event`. Returns `{task_count, event_count}`.

**Sync trigger (#2)**: Import `_sync_lock` from `dependencies`. Check `_sync_lock.locked()` → 409. Queue `BackgroundTasks.add_task(_locked_activity_sync)` where `_locked_activity_sync` acquires lock and calls `sync_service.sync_activities()`.

**Sync status (#3)**: Three queries: `SELECT COUNT(*) FROM activity WHERE deleted_at IS NULL`, `SELECT MAX(synced_at) FROM activity`, `SELECT COUNT(*) FROM activity WHERE sf_sync_status = 'pending'`.

**Search (#4)**: `plainto_tsquery('english', $1)` for safe user input. `ts_rank(search_vector, query) DESC` for ranking. Scope filter: `AND opportunity_id = $2` etc. Always includes `WHERE deleted_at IS NULL`. Default 12-month window via `AND activity_date > now() - interval '12 months'`.

**Match-context (#5)**: Three tiers:
- Tier 1: SOQL `SELECT Id, AccountId, ... FROM Contact WHERE Email = '{email}'` → Contact → their open Opportunities
- Tier 2: Extract domain from email → `SELECT Id FROM Account WHERE Website LIKE '%{domain}%'` → Account's Contacts → name similarity ranking via SequenceMatcher
- Tier 3: Fuzzy name match via `SELECT Id, Name FROM Contact WHERE Name LIKE '%{name_part}%'` → SequenceMatcher ranking → "possible match, confirm?" flag
- Returns: `{contacts: [{id, name, confidence}], opportunities: [{id, name, stage, amount}], match_tier: 1|2|3}`

**AI insights (#6)**: Query activities from local DB for the given opportunity/account. Build prompt with activity summary. Call `anthropic.Anthropic(api_key=ANTHROPIC_API_KEY).messages.create(model="claude-sonnet-4-20250514", ...)`. Parse response as JSON → structured fields. On parse failure → `confidence: "raw"`, raw text in summary.

**List (#7)**: Parameterized SQL with dynamic WHERE. All queries include `WHERE deleted_at IS NULL`. Filters: `opportunity_id`, `account_id`, `contact_id` (uses `$N = ANY(contact_ids)`), `type`, `source`, `start_date`, `end_date`. Pagination: `limit` (default 50, max 200), `offset`. Parameter numbering via `$i+1` pattern from routes/projects.py.

**Create (#8)**: INSERT INTO activity with RETURNING. If source is 'extension' or 'manual', queue BackgroundTask for SF write-through: `salesforce.create_record("Task", {Subject, Description, WhatId, WhoId, ActivityDate, Type, Status: "Completed"})`. On success → UPDATE sf_id. On failure → UPDATE sf_sync_status='pending'.

**Get by ID (#9)**: `fetchrow` with `WHERE id = $1 AND deleted_at IS NULL`. Convert UUID param: `uuid.UUID(id)`. 404 if not found.

**Update (#10)**: Dynamic SET clause (projects.py pattern). `model_dump(exclude_none=True)` for partial updates. Cannot update soft-deleted records: `WHERE id = $1 AND deleted_at IS NULL`.

**Soft delete (#11)**: `UPDATE activity SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`. Check result — if no rows affected, return 404.

### Step 7: `main.py` — Register router, update service construction

**File**: `financial_forecasting/main.py`

Changes:
1. Add import: `from routes.activities import router as activities_router`
2. Register: `app.include_router(activities_router)` after line 121
3. Update import: `from dependencies import _sync_lock` (replace local definition at line 127)
4. Update import: `from dependencies import get_data_sync_service` (replace local definition at lines 223-228)
5. Update DataSyncService construction (line 163):
   ```python
   from db import get_pool
   _services["data_sync_service"] = DataSyncService(client, db_pool=get_pool())
   ```
6. Remove local `_sync_lock = asyncio.Lock()` (line 127)
7. Remove local `get_data_sync_service()` function (lines 223-228)
8. Update `background_sync_task()` to import lock from dependencies

### Step 8: Tests

**File**: `financial_forecasting/tests/conftest.py`

Add mock factories:
- `make_sf_task(overrides)` — SF Task record dict with all fields
- `make_sf_event(overrides)` — SF Event record dict with all fields
- `make_activity(overrides)` — Local activity row dict

**File**: `financial_forecasting/tests/test_activities.py` (NEW)

Follow `test_projects_endpoints.py` pattern: TestClient, dependency_overrides, MockDBRow.

Test classes:
1. `TestActivitiesAuthEnforcement` — all 11 endpoints return 401 without auth
2. `TestActivityList` — filter by opportunity/account/type/date; pagination; deleted_at filtering
3. `TestActivityGetById` — found, not found, soft-deleted returns 404
4. `TestActivityCreate` — valid create, missing required fields 422, SF write-through queued
5. `TestActivityUpdate` — partial update, update non-existent 404, update soft-deleted 404
6. `TestActivitySoftDelete` — delete sets deleted_at, double-delete 404, verify row not hard-deleted
7. `TestActivitySearch` — full-text search, scoped by entity, empty results
8. `TestActivitySync` — count returns task+event counts, trigger starts sync, trigger returns 409 when lock held, status returns metadata
9. `TestActivityMatchContext` — Tier 1 email match, Tier 2 domain match, no match returns empty
10. `TestActivityInsights` — structured response, 503 when no API key, graceful degradation

**File**: `financial_forecasting/tests/test_api_endpoints.py`

Update imports: `_sync_lock` now imported from `dependencies` (line 20). Patch target changes from `main._sync_lock` to `dependencies._sync_lock` (line 703).

---

## Files Modified

| File | Change | Risk |
|------|--------|------|
| `financial_forecasting/db.py` | Add `get_pool()` | Zero — new function, no existing behavior changed |
| `financial_forecasting/db/init.sql` | Append activity table + indexes + triggers | Zero — idempotent, appended after existing content |
| `financial_forecasting/models.py` | Add ActivityType, ActivitySource, Activity, ActivityCreate, ActivityUpdate, insights models | Zero — append-only |
| `financial_forecasting/data_sync.py` | Add `db_pool` param, `sync_activities()`, update `sync_all_data()` | Low — `db_pool=None` default preserves existing construction. Isolated try/except. |
| `financial_forecasting/dependencies.py` | Add `_sync_lock`, `get_data_sync_service()` | Low — moved from main.py. Same objects, new location. |
| `financial_forecasting/routes/activities.py` | **NEW** — all 11 endpoints | Zero — new file |
| `financial_forecasting/main.py` | Register router, remove moved definitions, update imports | Medium — removing `_sync_lock` and `get_data_sync_service` definitions, updating construction. Must update all references. |
| `financial_forecasting/tests/conftest.py` | Add `make_sf_task()`, `make_sf_event()`, `make_activity()` | Zero — append-only |
| `financial_forecasting/tests/test_activities.py` | **NEW** — full test suite | Zero — new file |
| `financial_forecasting/tests/test_api_endpoints.py` | Update `_sync_lock` import and patch target | Low — two line changes |

## Files NOT Modified

- No `.tsx` files (backend only)
- No existing route files
- No `permissions.py` (reusing existing keys)
- No `requirements.txt` (no new dependencies — anthropic, asyncpg, httpx all exist)

---

## Verification Plan

```bash
# 1. Run database migration (init.sql is idempotent)
cd financial_forecasting && python -c "from db import init_db; import asyncio; asyncio.run(init_db())"

# 2. Verify table created
psql -U bedrock -d bedrock -c "\d activity"

# 3. Verify FK constraint
psql -U bedrock -d bedrock -c "SELECT conname FROM pg_constraint WHERE conrelid = 'activity'::regclass"

# 4. Verify full-text search trigger
psql -U bedrock -d bedrock -c "INSERT INTO activity (type, subject, activity_date, source) VALUES ('note', 'Test grant proposal', now(), 'manual') RETURNING search_vector"

# 5. Start server
cd financial_forecasting && uvicorn main:app --reload --port 8000

# 6. Test sync count (requires SF connection)
curl -X POST http://localhost:8000/api/activities/sync/count -H "Cookie: access_token=$TOKEN"

# 7. Trigger sync
curl -X POST http://localhost:8000/api/activities/sync/trigger -H "Cookie: access_token=$TOKEN"

# 8. List activities
curl "http://localhost:8000/api/activities?limit=10" -H "Cookie: access_token=$TOKEN"

# 9. Test search
curl "http://localhost:8000/api/activities/search?q=grant+proposal" -H "Cookie: access_token=$TOKEN"

# 10. Test soft delete (should return 404 after delete)
curl -X DELETE http://localhost:8000/api/activities/{id} -H "Cookie: access_token=$TOKEN"
curl http://localhost:8000/api/activities/{id} -H "Cookie: access_token=$TOKEN"  # expect 404

# 11. Run tests
cd financial_forecasting && python -m pytest tests/test_activities.py -v
cd financial_forecasting && python -m pytest tests/test_api_endpoints.py -v  # verify sync_lock import update
```

---

## Follow-Up Sprints (Noted During Planning)

### Project Hierarchy Soft-Delete (Separate Sprint)
See `tasks/project-soft-delete-plan.md` for full analysis. The `project` table with `ON DELETE CASCADE` is the highest-risk table — one DELETE wipes all children. Already flagged in `tasks/todo.md`. Requires CASCADE refactor.

### Sprint 9B Dependencies on 9A
- Timeline UI consumes `GET /api/activities` and `GET /api/activities/search`
- AI insights panel consumes `POST /api/activities/insights` (structured output ready)
- Opportunity detail modal needs activities by opportunity_id
- Contact detail modal needs activities by contact_id (uses `$N = ANY(contact_ids)`)

### Sprint 9C Dependencies on 9A
- Extension calls `POST /api/activities` (create) and `GET /api/activities/match-context`
- GCS attachment upload utility needed in 9C (deferred from 9A)
- Thread-aware email storage logic needed in 9C (deferred from 9A)
- sf_task_id TEXT column ready for extension to populate when linking SF Tasks
