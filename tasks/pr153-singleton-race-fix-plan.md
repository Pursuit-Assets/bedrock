# PR #153 — `pr-singleton-race-fix`

**Branch:** `fix/pr153-singleton-race-fix` (cut from latest `origin/dev` = `4a9407a`)
**Size:** S-M (estimate 150-250 LOC diff including tests)
**Blocks:** every other MVP-remaining PR — merge this first, alone.
**Verified against:** `origin/dev` at HEAD `4a9407a` (post-#151).

## Problem

Jac's PR #151 fixed BUG-AUTH-2 by having `dependencies.py::get_mcp_client` rebuild the Salesforce service from the request's `sf_tokens` cookie on every request. But the implementation **mutates the process-wide singleton** `client.services["salesforce"]` and `client._connected_services` in place. Combined with the lambda capture pattern in `SalesforceMCPService.query()` (and 7 other CRUD methods):

```python
# mcp_client/services/salesforce.py:237-250
async def query(self, soql: str):
    async def _do():
        if self.sf_client:
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None, lambda: self.sf_client.query(soql)
            )
```

The lambda captures `self` (the singleton), not `self.sf_client` by value. When the ThreadPool picks it up, it re-reads `self.sf_client`. In the window between lambda creation and execution, a concurrent request from a different user can rebind `self.sf_client` via `dependencies.py:58 existing.sf_client = sf`. Result: User A's SOQL can execute against User B's session.

Jac's own QA tracker (`tasks/pr-139-qa-bugs.md`) named the right fix verbatim: *"Don't mutate the shared singleton; build a per-request SF service wrapper."* This PR makes the implementation match that design.

## Current state — verified

### Consumers of `client.salesforce`, `client.services`, `client.connected_services`

**Request-context callers** (benefit from per-request SF):
| File | Count | Usage |
|---|---|---|
| `main.py` | 21 | `salesforce = client.salesforce` in list/CRUD handlers |
| `routes/payment_schedules.py` | 4 | same |
| `routes/salesforce_schema.py` | 1 | same |
| `routes/salesforce_search.py` | 4 | same |
| `routes/ai.py` | 2 | same |
| `routes/progress_tracking.py` | 1 | same (orphan, slated for delete in #176) |
| `routes/opportunities_extra.py` | 1 | checks `connected_services` |
| `routes/activity_intelligence.py` | 1 | `client.services.get("salesforce")` |

**Non-request-context callers** (keep using base singleton; don't affect or benefit from per-request):
| File | Count | Notes |
|---|---|---|
| `data_sync.py` | 10+ | `self.mcp_client.services["salesforce"]` — service account via startup wiring |
| `forecasting_engine.py` | 3 | `self.mcp_client.salesforce` — same |
| `background_sync_task` | — | async task started at `main.py:183`, uses `_services["data_sync_service"]` |

**Startup / shutdown:**
- `main.py:178` — gates `ForecastingEngine` + `DataSyncService` setup on `"salesforce" in client.connected_services`
- `mcp_client/unified_client.py:237, 242, 345` — shutdown + health_check iterate `_connected_services`

**Tests:** `tests/conftest.py:338` sets `client.salesforce = mock_salesforce_service` via MagicMock. All SF tests override `get_mcp_client` via `app.dependency_overrides`, so they bypass `dependencies.py` entirely.

### `UnifiedMCPClient` surface (already property-based — good)

`mcp_client/unified_client.py`:
- Line 249: `salesforce` is a `@property` returning `self.services.get("salesforce")`
- Line 302: `connected_services` is a `@property` returning `self._connected_services.copy()` (defensive copy)
- Line 18-19: `services: Dict[str, Any]`, `_connected_services: List[str]` — plain instance attrs, mutable

Because `.salesforce` and `.connected_services` go through properties, overriding the underlying storage in a subclass is sufficient to change their behavior — no custom `@property` needed.

## Design

Add a `_PerRequestMCPClient(UnifiedMCPClient)` subclass in `dependencies.py`:

```python
class _PerRequestMCPClient(UnifiedMCPClient):
    """Request-scoped wrapper that overrides the Salesforce slot with a
    per-request service. Inherits all UnifiedMCPClient accessors
    (`.salesforce`, `.connected_services`, `.services`, `.clients`, etc.)
    because they read from instance attributes we populate here.

    Intentionally does NOT call super().__init__() — that would reset
    services/clients dicts. Instead, we copy the base's state at wrap
    time so mutations to `self.services` never leak back to the base
    singleton (eliminating the BUG-AUTH-2 race).
    """
    def __init__(self, base: UnifiedMCPClient, sf_service: SalesforceMCPService):
        # Shared — these never mutate at request time.
        self.clients = base.clients
        # Copy — so overriding the SF slot doesn't mutate the base singleton.
        self.services = dict(base.services)
        self.services["salesforce"] = sf_service
        self._connected_services = list(base._connected_services)
        if "salesforce" not in self._connected_services:
            self._connected_services.append("salesforce")
```

Why subclass (not pure composition with `__getattr__`):
1. Type annotations on route handlers (`client: UnifiedMCPClient = Depends(get_mcp_client)`) stay accurate — `isinstance(wrapper, UnifiedMCPClient)` is True.
2. Inherited `@property` accessors (`salesforce`, `connected_services`) Just Work because we populate the underlying attrs.
3. Callers that access `client._connected_services` directly (via `getattr`) also Just Work.

Why copy (not share) the `services` dict: preserves the base singleton as read-only from a request's perspective. Any `services[x] = y` mutation in a request stays in the request's wrapper dict.

### `get_mcp_client` refactor

Replace the in-place mutation block at `dependencies.py:44-76` with:

```python
def get_mcp_client(request: Request = None) -> UnifiedMCPClient:
    base = _services.get("mcp_client")
    if not base:
        raise HTTPException(status_code=503, detail="MCP client not initialized")

    sf_cookie = request.cookies.get("sf_tokens") if request else None
    if not sf_cookie:
        return base  # service-account / no-auth path; unchanged

    try:
        from auth import decrypt_tokens
        from simple_salesforce import Salesforce
        from mcp_client.services.salesforce import SalesforceMCPService

        tokens = decrypt_tokens(sf_cookie)
        if not (tokens and tokens.get("access_token") and tokens.get("instance_url")):
            return base

        instance = tokens["instance_url"].replace("https://", "")
        sf_client = Salesforce(instance=instance, session_id=tokens["access_token"])

        sf_service = SalesforceMCPService.__new__(SalesforceMCPService)
        sf_service.client = None
        sf_service._config = {}
        sf_service._authenticated = True
        sf_service.sf_client = sf_client
        sf_service._reauth_lock = asyncio.Lock()
        sf_service.username = None
        sf_service.password = None
        sf_service.security_token = None
        sf_service.client_id = None
        sf_service.client_secret = None
        sf_service.domain = None

        return _PerRequestMCPClient(base, sf_service)
    except Exception as e:
        logger.debug(f"Could not build per-request SF client: {e}")
        return base
```

Key differences from current code:
- **No mutation of `base.services` or `base._connected_services`.** Base singleton is read-only from a request's perspective.
- **Each request gets its own `SalesforceMCPService` instance.** No shared `sf_client` attribute across requests. The lambda in `SalesforceMCPService.query()` still captures `self`, but now `self` is a request-scoped instance that dies when the request ends — no cross-request race possible.
- **Fallback preserves service-account path.** No cookie → return base unchanged → `forecasting_engine` / `data_sync` continue working with whatever startup wired.

## Scope — files changed

| File | Change |
|---|---|
| `financial_forecasting/dependencies.py` | Add `_PerRequestMCPClient` class. Refactor `get_mcp_client` body per design above. Net diff: ~40-50 lines (20 deletions for the mutation block, ~60-70 for the new wrapper + refactored function). |
| `financial_forecasting/tests/test_per_request_sf_client.py` | NEW. See test plan below. ~120-150 lines. |
| `tasks/jac-running-notes.md` | Progress log entry at the top. |
| `tasks/objects-production-readiness-plan.md` | PR-sequence table: flip #153 (new entry at top) from ⏳ Queued → 👀 in review. Note the +4 numbering shift from original plan (#149 → #153, etc.). |

**NOT changed:**
- `mcp_client/services/salesforce.py` — the race was about sharing, not internal logic. The lambda-capture pattern is fine when the service instance is request-scoped.
- `mcp_client/unified_client.py` — base class stays untouched; subclass inherits cleanly.
- Any route handler or test — they still do `client.salesforce` / `client.services` / `client.connected_services` and get the right value either way.
- `data_sync.py`, `forecasting_engine.py` — non-request-context callers, unchanged.

## Test plan

New file `financial_forecasting/tests/test_per_request_sf_client.py`:

```python
"""Tests for per-request Salesforce client wrapper (BUG-AUTH-2 + singleton race fix).

Covers:
- No cookie → returns base singleton unchanged
- Invalid / undecryptable cookie → returns base singleton, error logged but not raised
- Valid cookie → returns _PerRequestMCPClient with per-request SF service
- Base singleton services["salesforce"] is NEVER mutated by any request path
- Concurrent requests with distinct cookies don't share sf_client references
"""
```

Test cases (5 total):

1. **`test_no_cookie_returns_base_client`** — `request.cookies = {}` → `get_mcp_client(request)` returns the actual `_services["mcp_client"]` object (identity check via `is`).

2. **`test_invalid_cookie_falls_through_to_base`** — `request.cookies = {"sf_tokens": "garbage"}` → `decrypt_tokens` returns None → returns base. Verify no exception raised.

3. **`test_valid_cookie_builds_wrapper`** — mock `decrypt_tokens` to return valid tokens → assert result is `_PerRequestMCPClient` instance AND `result.salesforce` is a fresh `SalesforceMCPService` (not the base's). Assert `result.services["salesforce"]` is the fresh one. Assert `"salesforce" in result.connected_services`.

4. **`test_base_singleton_not_mutated`** — the critical invariant. Set up base with `services = {}` and `_connected_services = []`. Call `get_mcp_client` 3 times with 3 distinct cookies. After each call, assert `base.services.get("salesforce") is None` and `"salesforce" not in base._connected_services`. This is the test that would have FAILED before this PR and PASSES after.

5. **`test_concurrent_requests_dont_share_sf_client`** — run 2 cookie-bearing requests via `asyncio.gather`. Each produces a wrapper. Assert `wrapperA.salesforce is not wrapperB.salesforce` and each wrapper's `sf_client` attribute points at its own user's SF session (simulated by patching `Salesforce` constructor).

### Regression guard

Run full `pytest tests/ -v` and compare to baseline:
- Pre-PR baseline: 20 failed, 649 passed (from `tasks/jac-running-notes.md` 2026-04-19 entry)
- Post-PR target: same numbers (no regressions), plus +5 from new test file → **20 failed, 654 passed**

Any new failure should be investigated before merge. The 20 pre-existing failures (tracked at `tasks/remaining-32-test-failures-plan.md`) stay deferred.

### Manual smoke

1. Start backend + frontend locally. Connect Salesforce in the UI.
2. Open Reports (`/details` route) — verify opportunities/accounts/contacts/tasks tabs all load.
3. Open an Opportunity edit drawer — verify stage/owner/account render, Record Type picker populates.
4. Leave the browser idle 1 hour (or manually expire the access_token via dev tools). Refresh a page. Verify the session refresh kicks in and SF calls work without backend restart (this is Jac's original BUG-AUTH-1 fix continuing to work).
5. In a second browser / incognito session, sign in as a different user (if test org supports it). Issue overlapping requests via both browsers. Verify each browser sees its own data — no cross-contamination. (If only one user is available in the test org, skip this step and rely on the concurrent-request unit test.)

## Risk analysis

**What can go wrong:**

1. **Subclassing without `super().__init__()`** — if `UnifiedMCPClient.__init__` ever grows a required attribute, the subclass will miss it. Mitigation: add a comment in the subclass docstring explaining this constraint; future `UnifiedMCPClient` changes must update `_PerRequestMCPClient.__init__` too.

2. **`self.clients` shared, not copied** — if some route handler later mutates `client.clients`, the mutation leaks to the base singleton. Currently no handler does this (only startup connect code writes to `clients`). If a future PR adds mid-request `clients` mutation, it breaks the isolation guarantee. Mitigation: keep this in the subclass docstring; revisit if a caller needs to mutate `clients`.

3. **Shared `_reauth_lock` effect** — current code reuses the existing SF service's `_reauth_lock` when mutating. This PR creates a fresh `asyncio.Lock()` per request. That means per-request re-auth doesn't serialize across requests — if 10 concurrent requests all hit expired-session together, they'll each try to re-authenticate independently. For Pursuit's team-of-4 this is benign (low rate, OAuth endpoint rate-limited but not aggressively); but if it becomes a problem, the mitigation is to share the lock at the base client level. Flagged for future tuning, not this PR.

4. **`dependencies.py` import surface grows** — we now import `Salesforce`, `SalesforceMCPService`, `decrypt_tokens` at module top. These were previously imported lazily inside the `try` block. Eager imports are fine — they're already imported elsewhere at startup.

**What this PR does NOT fix:**

- **Same-user concurrent race** on a single `SalesforceMCPService` instance (e.g. if one browser tab fires two SF calls simultaneously — both use the same wrapper for that request-pair). Safe because both calls use the same `sf_client`, and `simple_salesforce` is thread-safe for read queries. Mutations serialize at SF's API layer.
- **Eventual session expiry** — if the request-scoped wrapper's cookie expires mid-request, the `_call_with_refresh` retry path still works (service re-auths with its `_reauth_lock`), but the refreshed token doesn't propagate back to the cookie (that's `salesforce_status`'s job on the next status check).

## Verification order

1. Read `dependencies.py` fully at `origin/dev` HEAD to confirm the diff target.
2. Write the subclass + refactor `get_mcp_client`.
3. Write the 5-test file.
4. Run `pytest tests/test_per_request_sf_client.py -v` — confirm 5/5 pass.
5. Run `pytest tests/ -v` — confirm 20 pre-existing failures, no new.
6. Manual smoke (above).
7. `git diff --stat` — confirm diff size matches estimate (~200 LOC).
8. Bundle doc updates, squash-merge.

## Post-merge

Both parallel lanes can start. See `tasks/parallel-pr-lanes.md` for the PR sequence across lanes A and B.
