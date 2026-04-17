# Follow-up — `GET /api/salesforce/accounts` pagination mismatch

**Status:** Surfaced 2026-04-17 while fixing `test_accounts_limit_capped_at_1000` in PR #137. Not fixed in that PR — logged here for a proper future fix.

## The problem

`main.py:470-523` (`get_accounts`) uses `salesforce.query(query)` at line 516. `salesforce.query()` returns a single page of SOQL results and does NOT auto-paginate. Combined with the `limit` query param capped at 2000 (post-PR #137; was 5000 before), this means:

- If Pursuit's real Account row count ever exceeds the cap (currently 2000), results are **silently truncated**. No error, no pagination header, no warning in the response.
- The frontend just sees "here are 2000 accounts" and has no way to know 2001+ exists.

Contrast with `main.py:304-375` (`get_opportunities`), which uses `salesforce.query_all(query)` at line 364. `query_all()` iterates SOQL's `nextRecordsUrl` automatically, so opportunities are never truncated regardless of count.

## Why it wasn't fixed in PR #137

PR #137 was scoped to unblocking 13 test_api_endpoints.py failures. Tightening the cap from `le=5000` to `le=2000` matched a stricter security posture and fit inside that scope. Rewriting the endpoint to `query_all` is a separate concern: it changes response size, latency, and memory profile. Deserves its own PR + deploy cycle.

## How to fix properly (future PR)

1. **Measure first.** Run `SELECT COUNT() FROM Account` against Pursuit's live SF org to know the real Account count. If it's < 2000, this is a latent bug that hasn't bitten yet. If ≥ 2000, the `Accounts` page in the UI is already hiding data.
2. **Rewrite to `query_all`.** Change `main.py:516` from `salesforce.query(query)` to `salesforce.query_all(query)`. Mirror the `get_opportunities` pattern exactly.
3. **Remove the `limit` param** (or keep it only as an upper bound for defensive caps — i.e., `if limit: query += f" LIMIT {limit}"`, default to no LIMIT clause).
4. **Frontend doesn't change.** All 10 callers I inventoried in PR #138's audit doc (`tasks/recordtype-audit-post-mvp.md`) pass no limit or a lower explicit limit, so they continue to work.
5. **Cache key update.** If limit becomes optional, the cache key at `main.py:480` (`f"accounts:{limit}"`) should become `f"accounts:{limit or 'all'}"` or similar.
6. **Tests.** Extend `test_get_accounts_returns_list` to seed a `records` list of ≥ 2000 fake accounts and verify all are returned.

## Related discoveries

- `get_contacts` at `main.py:551-603` uses `salesforce.query()` too (line ~595) — check whether it has the same issue.
- `get_payments`, `get_tasks`, and other single-page endpoints deserve a similar audit.

## Priority

Medium. Only bites if/when any single-object table grows past its cap. For MVP v1 (philanthropy-only, ~1000 accounts estimated), unlikely to trigger. Should be fixed before Pursuit scales past that.
