# MVP launch — running hand-off notes (for Jac)

**Launch target:** (moved — see "Launch pacing" below)
**Last updated:** 2026-04-20 (objects plan PR #147; live per-PR status in the table below)
**Canonical bug spec:** `tasks/mvp-launch-sprint.md` (B1-B9)
**Master plan (2026-04-20 expansion):** `tasks/objects-production-readiness-plan.md` (PR sequence #147-#168)
**Session source:** `tasks/notes-2026-04-17-jac-review.md`

This is a live status page. Updated with every PR diff — no separate docs-update churn. Newest entries at the top of the progress log; status table updates in place.

## Scope expansion 2026-04-20

JP expanded scope on 2026-04-20 from "ship B3 and move on" to "get all 5 core SF objects (Opportunities, Accounts, Contacts, Tasks, Activities) production-ready using real SF schemas — no shortcuts." See `tasks/objects-production-readiness-plan.md` for the full verified inventory + 23-PR sequence (#147-#169, including a page-rename cleanup at #148). B3 and B6 absorbed into PRs #149-#151; B4 splits into PRs #161-#165; B5, B7-B9 become PRs #166-#169.

## Launch pacing

Original target Wed 2026-04-22 is deferred. JP: *"We have time to do this correctly, so ignore time constraints. … production-ready for MVP sprint."* New cadence: each PR in the plan sequence ships production-ready before the next starts. Per-PR status tracked in the plan doc's "PR sequence" table.

## Status at a glance

| Bug / Item | Priority | Status | Ref | Pending Jac action? |
|---|---|---|---|---|
| **Objects production-readiness plan** | P0 | 👀 in review ([PR #147](https://github.com/Pursuit-Assets/bedrock/pull/147)) | [plan](objects-production-readiness-plan.md) | Review plan + approve PR #147 |
| **B1** targets not saving to shared DB | P0 | ✅ Merged to dev | [#142](https://github.com/Pursuit-Assets/bedrock/pull/142) | ⏳ Run migration + confirm deployed `DATABASE_URL` (see below) |
| **B2** opp `Type` field missing on view | P0 | ✅ Merged to dev | [#144](https://github.com/Pursuit-Assets/bedrock/pull/144) | — |
| **B3** Reports + Contacts 500-row cap | P1 | 📘 Absorbed — PRs #149-#151 | [plan](objects-production-readiness-plan.md) | — |
| **B4** task create/edit/delete bugs | P1 | 📘 Absorbed — PRs #161-#165 | [plan](objects-production-readiness-plan.md) | — |
| **B5** inline-edit lock too strict on Amount + Probability | P1 | 📘 Absorbed — PR #166 | [plan](objects-production-readiness-plan.md) | — |
| **B6** Contacts inline-edit migration status | P1 | 📘 Absorbed — PRs #149-#150 | [plan](objects-production-readiness-plan.md) | — |
| **B7** dropdown picker positioned wrong | P2 | 📘 Absorbed — PR #167 | [plan](objects-production-readiness-plan.md) | — |
| **B8** Progress page full pipeline (include Lost/Withdrawn) | P2 | 📘 Absorbed — PR #168 | [plan](objects-production-readiness-plan.md) | — |
| **B9** inline-edit "actively editing" affordance | P2 | 📘 Absorbed — PR #169 | [plan](objects-production-readiness-plan.md) | — |

Status legend: ⏳ Queued · 🚧 in flight · 👀 in review · ✅ merged · 📘 absorbed into master plan.

For per-PR status of the 23 PRs in the plan, see the "PR sequence" table in `tasks/objects-production-readiness-plan.md`.

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

### 2026-04-20 — Scope expanded; master plan opened as PR #147

- **Context.** From B3 investigation (see below): Reports-page "500-row cap" turned out to be a mix of real (Contacts backend uses `query()` not `query_all()`) and perceptual (Opportunities backend already correct since 2026-03-25; the user-visible symptom was pageSize=500 + stage-filter masking). Fixing only Contacts wasn't enough.
- **JP direction (2026-04-20).** "We need all the key objects listed here, Opportunities, Accounts, Contacts, Tasks, and Activities (ignore Leads as an object for Reports for MVP). We need edit dialogs to work throughout the site, not just fix the caps on Report page. … We have time to do this correctly, so ignore time constraints. … real SF schemas, not your guesses. … DO NOT DO ANY SHORTCUTS!"
- **Inventory.** Three parallel Explore agents ran a full audit: backend list + write endpoints per object, frontend list pages + row-count captions, edit dialogs + gap analysis. Verified directly against `origin/dev` HEAD `17732d3`.
- **Master plan.** `tasks/objects-production-readiness-plan.md` — 23-PR sequence (#147 through #169, with a page-rename cleanup at #148) organized by risk and dependency. Each PR production-ready on its own. Leads drops from Reports for MVP; Activities takes its place.
- **This PR (#147)** ships docs only: the plan itself, plus supersession banners across `tasks/mvp-launch-sprint.md`, `tasks/accounts-endpoint-pagination-followup.md`, `tasks/sprint9-activities-extension-plan.md`, this file, and `tasks/handoff-prompt.md`.
- **Pending for you.** Review the plan (~10 min read). Approve PR #147. Then PR #148 (`pr-page-rename-cleanup`) is the next concrete code PR — a small file/component rename to align `pages/MyDashboard.tsx` → `pages/Priorities.tsx` and `pages/Overview.tsx` → `pages/Progress.tsx` with their sidebar labels, before any larger code work touches those files.

### 2026-04-19 — B2 shipped (PR #144)

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
- [x] B2 (opp Type field) shipped (PR #144, merged 2026-04-20)
- [ ] PR #147 planning PR merged
- [ ] PRs #148-#169 shipped per `tasks/objects-production-readiness-plan.md` sequence
- [ ] End-to-end workflow smoke test (from the meeting: "create an opportunity, create a contact, create a task, create an account, progress it all, change it all")
- [ ] Wall of Progress E2E: JP sets a target, Jac queries DB, target is present, target appears on Jac's Progress page after refresh
- [ ] All 5 core objects (Opportunities, Accounts, Contacts, Tasks, Activities) support: find (list returns all rows), edit (dialog covers workflow fields via real SF schema), organize (sort/filter/search)

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
