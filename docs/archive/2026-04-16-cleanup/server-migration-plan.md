# Server Migration: simple_server.py → main.py

## Status: Phase 5 COMPLETE

**PR History:**
- Phase 2: Port missing endpoints into 8 route files + shared services (in progress)
- PR #42: Phase 1 — main.py connects to Salesforce directly (merged)
- PRs #36-41: Permission system, lock enforcement, save confirmations, UI polish (merged)

## What's Done

### Phase 1 (COMPLETE — PR #42)
- Removed mock MCP StdioTransport — services connect via direct API
- Added `load_dotenv()` to main.py, SF credentials in `.env`
- SalesforceLogin 3-step fallback chain
- Null-checks on `self.client.available_tools` (7 methods)
- `query_all()` method for Salesforce pagination
- SOQL field mappings fixed to match Pursuit SF org (NPSP fields)
- Returns raw SF records (no Pydantic model mapping)
- Priority filter always visible

### Already in main.py (from earlier PRs)
- Permission profiles (19 permissions, Admin/Fundraiser profiles)
- Settings page (Users + Profiles tabs)
- Opportunity locking (backend + UI)
- ConfirmSaveButton on all SF writes
- SaveStatusIndicator + useUndoableAction
- resolve_task_lock (server-side lock enforcement)
- 427 tests passing
- Auth on all project endpoints

## What's Next

### Phase 2: Port Missing Endpoints (COMPLETE)

**These endpoints exist in simple_server.py but NOT in main.py.** They need to be extracted into route files.

#### Priority Order (frontend actively uses these):

**1. `routes/opportunities_extra.py`** — Bulk ops + stage management
- `PUT /api/salesforce/opportunities/bulk-update` (used by Opportunities page bulk actions)
- `POST /api/opportunities/update-stage` (used by stage dropdown)
- `POST /api/opportunities/validate-stage-change` (pre-validation)
- `GET /api/salesforce/opportunities/stage-history` (stage change timeline)

**2. `routes/payment_schedules.py`** — Payment schedule CRUD
- `GET /api/opportunities/{id}/payment-schedule`
- `POST /api/opportunities/create-payment-schedule`
- `PUT /api/opportunities/{id}/payment-schedule/{payment_id}`
- `DELETE /api/opportunities/{id}/payment-schedule/{payment_id}`

**3. `routes/finance.py`** — Finance dashboard endpoints
- `POST /api/finance/create-invoice`
- `POST /api/finance/sync-payments`
- `GET /api/finance/awaiting-invoices`
- `GET /api/finance/active-collections`
- `GET /api/finance/unsent-invoices`
- `POST /api/finance/send-invoice-email`
- `POST /api/finance/sync-invoice-status`

**4. `routes/sage.py`** — Sage Intacct data
- `GET /api/sage/customers`
- `GET /api/sage/gl-accounts`
- `GET /api/sage/gl-accounts-balance`
- `GET /api/sage/departments`
- `GET /api/sage/locations`
- `GET /api/sage/classes`
- `GET /api/sage/expenses`
- `GET /api/sage/unpaid-bills`

**5. `routes/prospects.py`** — Prospect import pipeline
- `GET /api/prospect-import/persons`
- `POST /api/prospect-import/parse`
- `POST /api/prospect-import/preview`
- `POST /api/prospect-import/write-to-crm`

**6. `routes/activity_intelligence.py`** — Activity feeds
- `GET /api/activity-intelligence/{account_name}`
- `GET /api/drive/account-activity/{account_name}`
- `GET /api/drive/health`
- `GET /api/fireflies/debug-account/{account_name}`
- `POST /api/fireflies/refresh-cache`
- `GET /api/gmail/account-activity/{account_name}`
- `GET /api/gmail/health`
- `GET /api/calendar/account-activity/{account_name}`
- `GET /api/calendar/health`
- `GET /api/calendar/config`

**7. `routes/slack_routes.py`** — Slack integration
- `GET /api/slack/channel-messages/{channel_name}`
- `GET /api/slack/pipeline-updates`
- `GET /api/slack/health`
- `GET /api/slack/account-activity/{account_name}`

**8. `routes/ai.py`** — AI/automation
- `POST /api/ai/pipeline-analysis`
- `POST /api/automation-review/ingest-pipeline`

#### Approach for each:
1. Find the endpoint in simple_server.py (search for the route decorator)
2. Extract the handler function
3. Replace `get_salesforce()` calls with the service from `get_mcp_client()`
4. Replace `sf.query(...)` with `await salesforce.query(...)` (async)
5. Replace `sf.query_all(...)` with `await salesforce.query_all(...)`
6. Add `require_auth` or `check_permission` to each endpoint
7. Register the router in main.py with `app.include_router()`
8. Keep exact same request/response shapes so frontend works unchanged

### Phase 3: Documentation (COMPLETE)
- `docs/architecture-server-migration.md` — Why we migrated
- `docs/mcp-architecture-vision.md` — MCP's role for Pebble
- Updated `DEV_SETUP_GUIDE.md` — References `python main.py`
- Updated `start_server.sh` — References `python3 main.py`
- Updated `docs/architecture-decisions.md` section 6A — Marked as complete

### Phase 4: Deprecate simple_server.py (COMPLETE)
- Added deprecation notice at top of `simple_server.py`
- Updated Dockerfile CMD: `simple_server:app` → `main:app`
- Updated scripts: `pebble/README.md`, `test_prospect_import.sh`, `RUN_POC.sh`
- Updated `product/reference/` docs: setup-guide, slack-setup, automatic-payment-sync, sage-master-data
- `simple_server.py` kept in repo indefinitely for reference

### Phase 5: Hardening (COMPLETE)
- **Auth gap fixed:** `GET /api/cashflow/summary` in `routes/finance.py` was missing `require_auth` — added
- **Missing endpoints ported:**
  - `GET /api/matching/search-opportunities` — ported from simple_server.py with SOQL injection fix (`escape_soql_string`)
  - `POST /api/cache/clear` — ported with auth added (security improvement over simple_server)
- **Test suite:** Fixed 7 pre-existing test failures (mocked `query` instead of `query_all`). 434 passing, 22 skipped, 1 pre-existing failure (env-dependent MCP credentials test)
- **New tests added:** 8 tests for auth enforcement on new endpoints + endpoint behavior
- **Auth audit:** 80+ route endpoints + 25+ main.py endpoints verified — all protected or intentionally public

## Key Architecture Notes

- **main.py** is the production server. It uses `UnifiedMCPClient` as a service registry (NOT as an MCP protocol client).
- **MCP transport is NOT used.** All services connect via direct API calls. The "MCP" naming is historical.
- **Services live in `mcp_client/services/`** — despite the directory name, these are direct API wrappers (simple_salesforce, slack_sdk, etc.)
- **simple_server.py** uses `get_salesforce()` which returns a `simple_salesforce.Salesforce` instance. main.py uses `client.salesforce` which is a `SalesforceMCPService` wrapping the same library.
- **The key difference in porting:** simple_server.py's `sf.query()` is synchronous. main.py's `salesforce.query()` is async (runs sync calls in thread pool executor).
- **Credentials** are in `.env` (gitignored). The service reads them via `os.getenv("SALESFORCE_USERNAME")` etc.
- **The SalesforceLogin fallback** (no OAuth, no security token) is what actually works for the Pursuit org. OAuth client_credentials fails, then SalesforceLogin succeeds.

## File Locations

| File | Purpose |
|------|---------|
| `main.py` | Production server entry point |
| `simple_server.py` | Legacy server (to be deprecated) |
| `routes/permissions.py` | Permission profiles, user management, locks |
| `routes/projects.py` | Project CRUD + SF task bridge |
| `routes/sf_dependencies.py` | Task dependency CRUD |
| `routes/auth.py` | Google OAuth, Salesforce OAuth, session management |
| `routes/opportunities_extra.py` | Bulk ops, stage management, stage history |
| `routes/payment_schedules.py` | Payment schedule CRUD |
| `routes/finance.py` | Invoicing, payment sync, cashflow |
| `routes/sage.py` | Sage Intacct master data endpoints |
| `routes/prospects.py` | Prospect import pipeline |
| `routes/activity_intelligence.py` | Activity feeds, integration health checks |
| `routes/slack_routes.py` | Slack channel messages, pipeline updates |
| `routes/ai.py` | AI pipeline analysis, automation review |
| `dependencies.py` | Shared FastAPI dependency functions (get_mcp_client) |
| `services/cache.py` | Thread-safe TTL cache |
| `services/crm_parser.py` | CRM message parsing for automation review |
| `mcp_client/services/salesforce.py` | Salesforce API wrapper |
| `mcp_client/services/` | All service wrappers (Slack, Sage, Google, etc.) |
| `config.py` | Legacy config (hardcoded creds — being replaced by .env) |
| `.env` | Credentials (gitignored) |
| `db/init.sql` | PostgreSQL schema |
| `tests/` | 434+ tests across 16 test files |
