# MVP launch — running hand-off notes (for Jac)

**Launch target:** Wed 2026-04-22
**Last updated:** 2026-04-19 (B2 shipped)
**Canonical bug spec:** `tasks/mvp-launch-sprint.md`
**Session source:** `tasks/notes-2026-04-17-jac-review.md`

This is a live status page. Updated with every bug-fix PR (same PR diff — no separate docs-update churn). Newest entries at the top of the progress log; status table updates in place.

## Status at a glance

| Bug | Priority | Status | PR | Pending Jac action? |
|-----|----------|--------|----|---------------------|
| **B1** targets not saving to shared DB | P0 | ✅ Code shipped, merged to dev | [#142](https://github.com/Pursuit-Assets/bedrock/pull/142) | ⏳ Run migration + confirm deployed `DATABASE_URL` (see below) |
| **B2** opp `Type` field missing on view | P0 | ✅ Code shipped | PR pending — target `fix/b2-opp-type-field` | — |
| **B3** Reports + Contacts 500-row cap | P1 | ⏳ Queued | — | — |
| **B4** task create/edit/delete bugs | P1 | ⏳ Queued | — | — |
| **B5** inline-edit lock too strict on Amount + Probability | P1 | ⏳ Queued | — | — |
| **B6** Contacts inline-edit migration status | P1 | ⏳ Queued | — | — |
| **B7** dropdown picker positioned wrong | P2 | ⏳ Queued | — | — |
| **B8** Progress page full pipeline (include Lost/Withdrawn) | P2 | ⏳ Queued | — | — |
| **B9** inline-edit "actively editing" affordance | P2 | ⏳ Queued | — | — |

## Pending actions on your side (Jac)

1. **Run the B1 migration against the shared segundo-db.** Idempotent — safe to re-run.
   ```bash
   psql "$DATABASE_URL" -f financial_forecasting/db/migrations/2026-04-19-add-manage-owner-goals-permission.sql
   ```
   Verify:
   ```sql
   SELECT name, permissions->>'manage_owner_goals' FROM bedrock.permission_profile ORDER BY name;
   ```
   Expected: `Admin=true, Executive=true, Relationship Manager=null, Project Manager=null`. Without this migration, `Executive` users still 403 on target edits even though PR #142 is merged — the `init.sql` seeds use `ON CONFLICT DO NOTHING`, so existing rows aren't auto-updated.

2. **Confirm `DATABASE_URL` is set in the deployed backend's `.env`.** PR #142 removed the `postgresql://bedrock@localhost:5432/bedrock` fallback. If `DATABASE_URL` is unset or empty, the backend refuses to start — `init_db` logs a clear error, pool stays `None`, every DB route returns 503. Intentional, but means the production deploy must have the env var explicitly set.

## Progress log (newest first)

### 2026-04-19 — B2 shipped (this PR)

- **Problem.** From the 2026-04-17 session (~9:21–9:55): you looked up Mercy Corps for Data in Bedrock and expected to see its `Type` value. Salesforce has `Type = 'Other fee for service'` (you confirmed in the SF UI). Bedrock showed nothing. JP flagged: "type is not pulling in correctly."
- **Root cause.** The backend correctly queried and returned Type — verified at `main.py:333` (SELECT includes Type), `main.py:365–371` (records returned raw), `services/crm_parser.py:23–27` (cache stores raw). Frontend type definitions included Type at `types/salesforce.ts:129` and `pages/Opportunities/helpers.ts:69`. The bug was purely display-side: **no grid exposed a Type column**, and no filter targeted it. Users could only see/edit Type by opening the full-edit drawer per-record. Also caught: the test factory (`conftest.py:make_sf_opportunity`) had no Type default, so no test ever round-tripped Type — the regression was invisible to CI.
- **Fix.** JP's chosen scope: "everything + inline-edit column like Stage." Single PR:
  1. New hook `useOpportunityTypePicklist.ts` — react-query fetch of `/api/salesforce/schema/Opportunity` picklist, 30-min cache, graceful empty-on-error fallback.
  2. New `TypeCell.tsx` — mirrors `StageCell` pattern. Renders a neutral-pill inline-edit select. Falls back to read-only plain text when the picklist fetch fails.
  3. `buildPipelineColumns` — new Type column between Stage and Amount, using TypeCell.
  4. `buildPaymentColumns` — new Type column (read-only) between Account and Close Date; Finance view is scan-oriented so no inline-edit.
  5. `PipelineFilterBar.tsx` — new `types` field on `PipelineFilters`, new Autocomplete in the expanded drawer, active-filter chip when set.
  6. `OpportunityEditDialog.tsx:498` — free-text TextField upgraded to select-variant TextField populated from the shared picklist hook. Falls back to free-text if the picklist is empty. Inactive-but-current-value is shown as disabled "(inactive)" so users don't silently lose a value.
  7. `Accounts.tsx:627+` opportunity-detail columns — new read-only Type column between Stage and Amount.
  8. `conftest.py:make_sf_opportunity` — Type now defaults to `"Other fee for service"` so all factory-derived tests exercise Type by default.
  9. `test_api_endpoints.py:test_get_opportunities_returns_records` — new assertion `data[0]["Type"] == "Other fee for service"` guards the API contract.
- **Verification.** Frontend typecheck clean. Full test suite no new failures. Visual check against shared DB: Type column renders, picklist dropdown populates, filter works, edit dialog select replaces the free-text field.
- **Pending for you.** None. Pure frontend PR; no migration, no env change.

### 2026-04-19 — B1 shipped (PR #142)

- **Problem.** From the 2026-04-17 session (~44:01–47:27): your shared-DB query showed only the two targets you'd set yourself — JP's never arrived, despite his session displaying them as saved.
- **Root causes, all verified against source:**
  1. `db.py:37` silently fell back to local Postgres on missing `DATABASE_URL`. JP's local backend wrote to localhost while teammates read from the shared segundo-db.
  2. Permission-key mismatch: backend `owner_goals.py:106` gated on `manage_owner_goals`; frontend used `manage_targets` at 5 sites — a permission key that is not in `PERMISSION_KEYS` and therefore never resolves to `true`. Admin bypassed this via the `isAdmin` check.
  3. Admin + Executive profile seeds in `init.sql:392–425, 469–508` omitted `manage_owner_goals`. Worked for Admin via runtime `setdefault` auto-grant; Execs had no fallback and silently 403'd.
  4. `test_owner_goals.py` mock used the stale query pattern `"FROM bedrock.app_user"` (refactored to `public.org_users`) and omitted `profile_id` from mocked rows — every permission-gated test silently 403'd.
- **Fix.** Single PR, 9 files, +211 / −15. Fail-fast on `DATABASE_URL`; rename frontend `manage_targets` → `manage_owner_goals` (5 sites); add the key explicitly to Admin + Executive seeds; new migration to apply the grant to already-seeded shared-DB rows; fix stale mock; new `tests/test_db_init.py` (3 tests) covering the fail-fast guard.
- **Verification results.**
  - `pytest tests/test_db_init.py tests/test_owner_goals.py` → 17/17 pass (3 new + 14 previously silently-403'ing).
  - Full suite: baseline 32 failed, 634 passed → after 20 failed, 649 passed. Net +15: 3 new tests + 12 test_owner_goals.py tests now actually exercising their intended flow.
  - Fail-fast smoke (`env -u DATABASE_URL python3 -c "..."`): clear error, status `disconnected`, no `asyncpg` call.
  - Frontend `npx tsc --noEmit` clean.
- **Caveats.**
  - Pre-existing babel parse error at `frontend/src/utils/fieldSensitivity.test.ts:114` — confirmed on baseline via `git stash`, not introduced here. Out of scope for this fix; should be a separate PR.
  - 20 remaining test failures are all in `test_projects_endpoints.py` + `test_sf_dependencies.py`, tracked at `tasks/remaining-32-test-failures-plan.md`.

## Tuesday 2026-04-21 pair-build plan

From the 2026-04-17 session (57:04–57:43):
- **11:30** check-in (brief)
- **2:30–3:30** main working block (you moved the jobs PRD; Damon couldn't join)
- **4:00–5:00** final go/no-go after your Nick meeting

Monday night handoff: JP sends a state-of-the-world summary — what's shipped, what's in-flight, what's still open. You can pick up any item off the sprint plan from there.

## Pre-launch checklist

- [x] PR #139 dev → main rollup merged (2026-04-19)
- [x] B1 code shipped (PR #142)
- [ ] B1 migration applied to shared segundo-db (pending Jac action above)
- [ ] Deployed `DATABASE_URL` confirmed set (pending Jac action above)
- [ ] B2 (opp Type field) shipped
- [ ] Remaining P1 bugs shipped or explicitly deferred with a known-issues note
- [ ] End-to-end workflow smoke test (from the meeting: "create an opportunity, create a contact, create a task, create an account, progress it all, change it all")
- [ ] Wall of Progress E2E: JP sets a target, Jac queries DB, target is present, target appears on Jac's Progress page after refresh

## What's explicitly parked / deferred (agreed in session)

- **Drawer vs modal vs tab** for related-object editing — you: "This is not those edit things. Those edit things are going to be fine. We can change that later."
- **Progress-page "Wins" → "Closed" rename** — the semantic overload ("Closed Won" already means something specific) doesn't survive scrutiny. Dropped.
- **Pebble integration into Bedrock** — JP: "I need another week because we gotta roll out bedrock." Post-MVP.
- **Hackathon-style shortcut replacement for Nick's external tools** — JP: "let me, like, ship something. I've been working for weeks on this and I don't want to, like, hackathon it." Pebble proper ships after MVP.
- **RecordType filtering audit** across all frontend `getOpportunities()` callers — parked post-MVP v1 because MVP is philanthropy-only fundraisers. Full spec preserved at `tasks/recordtype-audit-post-mvp.md`.
- **Stage-list drift consolidation** (9 drift sites in Overview/Accounts/PaymentProcessing/Opportunities) — parked. Plan at `tasks/stage-list-drift-plan.md`. Partially dissolves into the RecordType audit once that ships.
- **`get_accounts` endpoint single-page → `query_all()`** — latent truncation bug if account count exceeds the cap. Tracked at `tasks/accounts-endpoint-pagination-followup.md`.
- **Remaining 32 test failures** in `test_projects_endpoints.py` + `test_sf_dependencies.py` + `test_mcp_services.py`. Plan at `tasks/remaining-32-test-failures-plan.md` (uses the closed PR #102's diagnostics as reference).

## Process notes from your side (adopting going forward)

- **PR = "I tested this and it's good,"** not "I built this, help me test it." JP is adopting this. Doc-only PRs are the exception you granted.
- **Consider Playwright for automated click-through tests** post-MVP. You already use this pattern at the factory.
- **"Put yourself in the CEO shoes"** — iterate tiny polish, page-by-page, before shipping. JP agreed to adopt after MVP goes out; pre-launch mode is build-fast to hit Wednesday.

## How this doc is maintained

- Updated **in the same PR diff** as each bug-fix that changes its status. No separate docs-churn PRs. This keeps the running log synchronized with the actual code state.
- Exception: this initial creation is its own small PR so it's visible right away.
- Newest entries at the top of the Progress log.
- Status table updates in-place as each bug moves across Queued → In Progress → Shipped.
