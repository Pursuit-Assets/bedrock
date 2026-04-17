# Plan — unblock the remaining ~32 test failures across test_projects_endpoints.py, test_sf_dependencies.py, test_mcp_services.py

**Status:** DEFERRED. Filed 2026-04-17 as a follow-up to PR #137 (test_api_endpoints.py fixture fixes). PR #137 took the full test suite from `45 failed, 621 passed` → `32 failed, 634 passed`. This plan handles the remaining 32.

**Relationship to other work:**
- Supersedes the closed PR #102 (`fix/test-suite-cleanup`, authored 2026-04-13). That PR had diagnostic analysis I'm preserving here before its branch goes cold.
- PR #102's `test_api_endpoints.py` and `conftest.py` work was superseded by PR #137 (today's session, merged to dev as `66a21d6`). The remaining value of PR #102 is the unique fixes it had for the three files below.
- Reference docs: `tasks/lessons.md` § 2026-04-16 item 2 (the `MagicMock` property trap), PR #137's commit message.

---

## 1. Baseline to verify before starting

```
cd financial_forecasting && python3 -m pytest tests/ -p no:warnings --tb=no 2>&1 | tail -3
# Expected (as of 2026-04-17): 32 failed, 634 passed, 22 skipped
```

All 32 failures are in three files:
- `tests/test_projects_endpoints.py`
- `tests/test_sf_dependencies.py`
- `tests/test_mcp_services.py`

**If the baseline has moved by the time this is picked up** (e.g., someone else has landed fixes): rediscover the current state before applying any of the fixes below. The failure categories are stable but specific test names may change.

## 2. Root-cause categories (from PR #102's diagnostic analysis)

PR #102 identified five root-cause categories. Two were resolved by PR #137; three remain:

| Category | Affected file(s) | Tests affected | Status |
|----------|------------------|----------------|--------|
| Missing `connected_services` public alias on MagicMock | `conftest.py` + several | ~14 | ✅ Fixed via `conftest.py:326-333` + PR #137's local-fixture fixes |
| Stale endpoint cache between tests | `test_api_endpoints.py` | ~6 | ✅ Fixed via PR #137's autouse `reset_cache` fixture |
| **Missing `email` in TEST_USER + unpatched `get_user_permissions`** | `test_sf_dependencies.py` (mostly) | ~17 | ❌ OPEN — see §3 |
| **Env var leak into credential validation test** | `test_mcp_services.py` | 1 | ❌ OPEN — see §4 |
| **Missing MockDBRow fields after code refactors** | `test_projects_endpoints.py` | ~6 | ❌ OPEN — see §5 |

That totals 24 OPEN, but PR #102 claimed 34 total fixes and 20 of those overlap with PR #137. 24 OPEN ≠ 32 failures — the delta is either (a) additional failures that accumulated on dev between 2026-04-13 and 2026-04-17, or (b) categorization gaps in PR #102's diagnosis. Expect to encounter 1–2 additional minor fixes on top of the categorized ones below.

## 3. Category: `get_user_permissions` not patched in test fixtures

**Files:** primarily `tests/test_sf_dependencies.py`; possibly also stragglers in `tests/test_projects_endpoints.py`.

**Root cause:** `routes/permissions.py:check_permission` (the dependency used by most mutating endpoints) calls `get_user_permissions(email, db)` internally. This function:
- Reads `email` from the authenticated user dict
- Queries the db for a user row
- Parses the row's `permissions` JSON column
- Returns a dict the endpoint uses for per-permission gating

In tests, `TEST_USER` may not have an `email` key, and/or `get_user_permissions` isn't bypassed or mocked. The endpoint then either:
- Can't find an email to query by → blows up early
- Queries the mock db with a key the mock doesn't know → returns `None` → permission check fails → 403

**Fix pattern from PR #102:**

```python
# In TEST_USER dict, ensure email is set:
TEST_USER = {"user_id": "test_user", "email": "test@test.org", "name": "Test User", "role": "admin"}

# In the authed_client fixture, patch get_user_permissions directly to return
# a dict with all permissions true. This bypasses the db round-trip entirely:
from unittest.mock import patch

@pytest.fixture
def authed_client(...):
    # ... existing overrides ...
    # Build a permissions dict that includes EVERY permission key the codebase uses
    PERMISSION_KEYS = [
        "view_opportunities", "edit_own_opportunities", "edit_all_opportunities",
        "create_opportunities", "bulk_update_opportunities", "lock_own_opportunities",
        "reassign_opportunities",
        "edit_accounts", "create_accounts",
        "edit_contacts", "create_contacts",
        "view_tasks", "edit_own_tasks", "edit_all_tasks", "create_tasks",
        "view_revenue_dashboard", "view_cashflow_forecasts",
        "view_sage_invoices_payments", "create_sage_invoices",
        "match_invoices", "manage_payment_schedules", "generate_financial_reports",
        "trigger_data_sync", "manage_users_roles",
    ]
    admin_perms = {k: True for k in PERMISSION_KEYS}
    with patch("routes.permissions.get_user_permissions",
               new=AsyncMock(return_value={"permissions": admin_perms,
                                             "sf_user_id": "005TESTOWNER00001",
                                             "is_active": True})):
        yield client
```

**Why this is different from what PR #137 did:** PR #137 fixed the `test_api_endpoints.py`-local `mock_db` and added the `require_auth_or_internal` override. That works for `check_permission_or_internal` endpoints via the `mock_db.fetchrow` side effect. But several endpoints route through `check_permission` which calls `get_user_permissions` as a nested helper — that helper's internals (email lookup + JSON parse) have their own surface area. Patching the helper itself is the cleanest bypass for files that heavily use `check_permission`.

**Recommended ordering:**
1. Read `routes/permissions.py` to confirm the current `get_user_permissions` signature before patching.
2. Check whether `test_sf_dependencies.py` already has some form of the pattern — PR #102's diff had it partially applied.
3. Define `PERMISSION_KEYS` in a shared location (probably `tests/conftest.py`) so all three test files can reuse it.

## 4. Category: env var leak in `test_mcp_services.py`

**File:** `tests/test_mcp_services.py` (1 test).

**Root cause:** `SalesforceMCPService.__init__` (or similar) reads credentials from env vars as a fallback when no explicit config is passed. A test that constructs the service expecting credential-absence may fail because dev env vars (from a real `.env`) are still set in the test process.

**Fix pattern from PR #102:** decorate the specific test with `@patch.dict(os.environ, {}, clear=True)` to null out the environment for that test's scope.

```python
from unittest.mock import patch

@patch.dict(os.environ, {}, clear=True)
def test_validates_credentials_missing(self):
    service = SalesforceMCPService()
    assert service.is_authenticated is False
```

**Watch-out:** `clear=True` nukes PATH and everything else. If the test imports something lazily that needs env, it'll break in a non-obvious way. Prefer `@patch.dict(os.environ, {}, clear=True)` at the method level (not module level) and only for the specific test that needs it.

## 5. Category: `MockDBRow` missing fields after code refactors

**File:** `tests/test_projects_endpoints.py` (~6 tests).

**Root cause:** Between the time these tests were written and now, the Projects domain code has added fields to the db row shape that the mock fixtures return. Tests that unpack those rows (via attribute access or dict keys) hit `AttributeError` / `KeyError`.

**Specific areas called out in PR #102:**
- **Ownership gate** — `ProjectMember.role` or similar; test_projects_endpoints checks whether a user can edit their own project. If the mock row for a ProjectMember doesn't include the role field, the gate fails.
- **Trash list** — `tests/test_projects_endpoints.py::TestTrashList::test_list_deleted_projects` (confirmed failing on 2026-04-17). Likely needs a `deleted_at` or similar field.
- **Purge retention check** — `TestPurgeProject::test_purge_hard_deletes`. Probably a `deleted_at` / retention-window field.
- **PM role** — `TestProjectPermissions::test_pm_can_create_project`. Likely needs a PM-profile-specific permissions row.
- **Create endpoint** — some field added to the returned row after INSERT that tests don't include in their mock `RETURNING` result.

**Recommended ordering:**
1. Run these 6 specific tests in isolation first to see the exact error messages. Fix by adding the missing fields to the MockDBRow construction in each test's setup.
2. Cross-reference against `financial_forecasting/routes/projects.py` (or wherever Projects routes live) to find the current source-of-truth field list.
3. If the same field additions apply to multiple tests, consolidate into a shared fixture helper.

**Watch-out:** PR #102 made these additions against 2026-04-13 code. Projects has moved since — some fields PR #102 added may now be wrong, and new fields have certainly been added. Expect to discover 1–2 fields beyond PR #102's list.

## 6. Suggested PR structure

Three options, listed in order of increasing ambition:

**Option X — one PR per file.** Three small PRs, each fixing one file's failures. Cleanest blame/git-history. ~1 hour per PR for implementation + verification.

**Option Y — one bundled PR, three sections.** Single PR titled `fix(tests): unblock remaining 32 test failures (test_projects_endpoints + test_sf_dependencies + test_mcp_services)`. Commit message organized by category. ~3 hours total. Easier to review as a single coherent "finish the job" PR.

**Option Z — refactor into shared fixtures.** Deeper pass: extract `PERMISSION_KEYS`, the `get_user_permissions` patch, and common mock row builders into `tests/conftest.py` as shared fixtures. Then migrate all three files + refactor `test_api_endpoints.py` to consume the same shared patterns. ~1 day. Highest long-term value but larger diff.

**Recommended:** Option Y. Strikes the right balance — one coherent PR, clear scope, reviewable as a unit. Save Option Z as a separate future refactor if test maintenance pain justifies it.

## 7. Verification steps (once fixes are applied)

1. `python3 -m pytest tests/test_projects_endpoints.py -q` → expect 0 failed
2. `python3 -m pytest tests/test_sf_dependencies.py -q` → expect 0 failed
3. `python3 -m pytest tests/test_mcp_services.py -q` → expect 0 failed
4. `python3 -m pytest tests/ --tb=no -p no:warnings` → expect **0 failed, ~666 passed, 22 skipped**
5. Spot-check: re-run `tests/test_api_endpoints.py` (70 passing) to confirm no regression from the shared fixture changes.

## 8. Open questions (likely minimal)

- Whether the PR #102 `PERMISSION_KEYS` list is complete vs current `routes/permissions.py`. If new permissions have been added since 2026-04-13, test fixtures need them too.
- Whether any of the 32 failures are actually PRODUCTION BUGS the test is catching vs test-only fixture issues. Baseline assumption from PR #102's analysis: all 34 were test-fixture issues, no production bugs. Worth spot-checking 2–3 before assuming it still holds 4 days later.

## 9. Session trail

- PR #102 opened 2026-04-13 by `jpb33333` (JP), attempted broader cleanup, stalled.
- PR #137 merged 2026-04-17 took a narrower cut (test_api_endpoints.py only).
- PR #102 closed 2026-04-17 with a comment pointing here.
- This plan is the durable home for the remaining work.
