# Objects production-readiness — MVP launch plan

**Created:** 2026-04-20
**Status:** PR #147 (this planning doc) open for review; PRs #148-#168 queued below. See live per-PR status in the "PR sequence" table.
**Scope:** The five core Salesforce-backed objects used in daily workflows — **Opportunities, Accounts, Contacts, Tasks, Activities** — brought to production-ready quality for MVP launch.

This plan supersedes B3 (row caps) and B6 (Contacts inline-edit) in `mvp-launch-sprint.md`. Those symptoms roll into PRs #148-#150 below and expand to cover all five objects.

## How to pick this up in a fresh session

1. Read this file top-to-bottom (≈10 min).
2. Find the next queued PR — the lowest-numbered row in the "PR sequence" table whose status column in `jac-running-notes.md` still says `⏳ Queued`.
3. Cut a branch from latest `origin/dev` named `<type>/pr<NNN>-<slug>` (e.g. `fix/pr148-contacts-accounts-pagination`).
4. Execute that PR's scope exactly as specified below. Bundle the `jac-running-notes.md` status-flip + progress-log entry into the same PR diff.
5. Squash-merge on JP approval per standing directive (see `feedback_prefer_prs` memory).

### Numbering note

Predicted PR numbers below assume no unrelated PRs land between ours. If a hotfix or other unrelated PR takes a number from this sequence (e.g. Jac ships #150 as a hotfix), the remaining predicted numbers in this doc shift by one. When that happens, the next planning-bundle PR updates the numbers in this file; the short slug (e.g. `pr-contacts-accounts-pagination`) stays stable so cross-references don't drift.

## Why this plan exists

Two inputs forced the scope expansion from B3:

**2026-04-17 Jac review.** Jac flagged Reports → Opportunities looked row-capped at 500 (perceptual — pageSize + stage filter masking), and Contacts was capped (real — backend uses single-page `query()`). The single-bug frame wasn't sufficient.

**2026-04-20 JP direction.** "We need all the key objects listed here, Opportunities, Accounts, Contacts, Tasks, and Activities (ignore Leads as an object for Reports for MVP). We need edit dialogs to work throughout the site, not just fix the caps on Report page. … We have time to do this correctly, so ignore time constraints. … we need Opportunities, Accounts, Contacts, Tasks, Activities to all work using real SF schemas, not your guesses. This all has to map perfectly to salesforce in order to work. DO NOT DO ANY SHORTCUTS!"

The MVP-daily-use bar: a team member can find, edit, and organize any of the five objects using the real SF schema, from every place those objects surface in the UI.

## Current state — verified directly in source

### Backend list endpoints

| Object | File:line | SF method | Default `limit` | Silent cap |
|---|---|---|---|---|
| Opportunities | `financial_forecasting/main.py:304-375` | `query_all()` | `None` | none ✓ |
| Accounts | `financial_forecasting/main.py:470-531` | `query()` | `2000` (`le=2000`) | 2000 ✗ |
| Contacts | `financial_forecasting/main.py:559-611` | `query()` | `2000` (`le=5000`) | 2000 ✗ |
| Tasks — my-tasks | `financial_forecasting/main.py:851-894` | `query()` | `200` (`le=500`) | 200/500 ✗ (scope-bounded by date) |
| Tasks — opp-tasks | `financial_forecasting/main.py:924-970` | `query()` | no SOQL LIMIT | 2000 (SF single-page) ✗ |
| Activities | `financial_forecasting/routes/activities.py:463-538` | Postgres SELECT | `50` (`le=200`) | 200 ✗ |

Opportunities was fixed in commit `4280909` (2026-03-25, PR #68). The same `query() → query_all()` + `limit: Optional[int] = Query(None)` + conditional `LIMIT` clause pattern is what PR #148 propagates to every other SF endpoint.

### Backend write endpoints

| Object | Create | Update | Delete | Request-model field whitelist? |
|---|---|---|---|---|
| Opportunities | `main.py:379-399` | `main.py:402-467` | — | no — pass-through `Dict[str, Any]` |
| Accounts | `main.py:534-557` | `main.py:739-761` | — | no — pass-through |
| Contacts | `main.py:614-636` | `main.py:764-786` | — | no — pass-through |
| Tasks | `main.py:973-1002` (per-opp) | `main.py:1004-1041` | `main.py:1044-1066` | **yes** — `TaskCreateRequest`, `TaskUpdateRequest` are typed |
| Activities | `routes/activities.py:545-592` | `routes/activities.py:624-659` | `routes/activities.py:666-684` (soft) | **yes** — `ActivityCreate`, `ActivityUpdate` |

### Frontend list pages

| Page | Object | `pageSize` default | Row-count caption | Columns | Inline edit |
|---|---|---|---|---|---|
| `frontend/src/pages/Opportunities.tsx` | Opportunities | 100 | ✓ hand-rolled line ~529 | mixed `buildPipelineColumns()` + domain cells (Stage/Owner/Account/Amount/Type/Probability/Date) | Stage, Owner, Account, Amount, Type, Probability, Date, Name, CloseDate |
| `frontend/src/pages/Accounts.tsx` | Accounts | 100 | ✗ | `buildSchemaColumns()` + computed metric cols | any `editable: true` field |
| `frontend/src/pages/Contacts.tsx` | Contacts | 100 | ✗ | `buildSchemaColumns()` | schema-driven |
| `frontend/src/pages/Tasks.tsx` | Tasks (current user only) | 100 | ✗ | `buildSchemaColumns()` | schema-driven |
| `frontend/src/pages/Leads.tsx` | Leads (DB-backed, not SF) | 100 | ✗ | schema-driven | — |
| `frontend/src/pages/Activities.tsx` | — | — | — | **does not exist** | — |

Reports.tsx is a tab container that embeds Opportunities, Accounts, Contacts, Leads, Tasks. Per JP's 2026-04-20 direction: Leads drops from Reports for MVP; Activities takes its place.

### Other list surfaces that need the row-count caption

- `pages/Priorities.tsx` / `pages/WeeklyPriorities.tsx` — opportunity + task lists
- `pages/MyDashboard.tsx` — opportunities via custom `PriorityTable`
- `pages/Overview.tsx` (Progress page) — per-owner opportunity cards
- `pages/Accounts.tsx` detail dialog — nested Opportunities grid
- Finance pages (`UnpaidBills`, `ReceivedPayments`, `PendingInvoices`, `PaymentProcessing`, `GivingCapacity`, `FinanceDashboard`) — non-SF but user-facing lists

### Edit-dialog inventory and critical gaps

| Dialog | File | Editable fields | Schema-driven picklists? | Critical gap |
|---|---|---|---|---|
| OpportunityEditDialog | `frontend/src/components/OpportunityEditDialog.tsx` | 16 | partial (Type only, via `useOpportunityTypePicklist`) | minor: `Earliest_Scheduled_Payment__c` if workflow requires it |
| AccountEditDialog | `frontend/src/components/AccountEditDialog.tsx` | 24 | partial (7 picklists from schema) | minor: `npsp__Matching_Gift_Request_Deadline__c` uses text input, should be date picker |
| ContactEditDialog | `frontend/src/components/ContactEditDialog.tsx` | 26 | partial (5 picklists from schema) | minor: `npe01__AlternateEmail__c` not exposed |
| TaskPanel | `frontend/src/components/TaskPanel.tsx` | 6 | none — all hardcoded | **high: `WhoId` (Contact link) — staff can't link a task to a contact from within Bedrock** |
| ActivityEditDialog | — | — | — | **does not exist — by design per Sprint 9: Activities are mirrored from SF Task/Event; edits flow through the Task/Event CRUD path** |

### Schema infrastructure that already exists

- `utils/schemaColumns.tsx` → `buildSchemaColumns()` — auto-generates MUI DataGrid columns from SF describe output
- `apiService.getSchemaDescribe(sobject)` → `GET /api/salesforce/schema/{sobject}` → live SF describe (audit mode via `?compare=true`)
- `hooks/useOpportunityTypePicklist.ts` — single-field picklist hook (precedent for generalization)

Not yet built, but needed by PRs #152-#156:
- `useSchemaPicklist(sobject, fieldName)` — generalized hook
- Schema-driven dialog builder (post-MVP stretch; dialogs can continue to use hardcoded field lists backed by `useSchemaPicklist` for picklist values)

## PR sequence

This table is the source of truth for per-PR status. Each PR that ships updates its own row here (status → ✅) as part of the PR diff; `tasks/jac-running-notes.md` links to this table and tracks only high-level rollup.

| # | Slug | Ships what | Size | Status |
|---|---|---|---|---|
| [#147](https://github.com/Pursuit-Assets/bedrock/pull/147) | `pr-planning` | This plan doc + doc updates across existing task files | docs-only | 👀 in review |
| #148 | `pr-contacts-accounts-pagination` | Backend: Contacts + Accounts + opp-tasks + my-tasks → `query_all()` pattern | S-M | ⏳ Queued |
| #149 | `pr-rowcount-caption-reports-tabs` | `<RowCountCaption>` component + apply to Opportunities (migrate) / Accounts / Contacts / Tasks | M | ⏳ Queued |
| #150 | `pr-rowcount-caption-other-surfaces` | Apply caption to Priorities / WeeklyPriorities / MyDashboard / Overview / Accounts-detail / Finance pages | S | ⏳ Queued |
| #151 | `pr-tasks-whoid` | Add `WhoId` (Contact lookup) to TaskPanel + TaskCreateRequest + TaskUpdateRequest | S | ⏳ Queued |
| #152 | `pr-use-schema-picklist` | Generalize `useOpportunityTypePicklist` → `useSchemaPicklist(sobject, fieldName)` | S | ⏳ Queued |
| #153 | `pr-dialog-audit-opportunity` | Opportunity dialog: add `Earliest_Scheduled_Payment__c`, convert hardcoded picklists to `useSchemaPicklist` | S-M | ⏳ Queued |
| #154 | `pr-dialog-audit-account` | Account dialog: convert `npsp__Matching_Gift_Request_Deadline__c` to date, convert all picklists | S-M | ⏳ Queued |
| #155 | `pr-dialog-audit-contact` | Contact dialog: add `npe01__AlternateEmail__c`, convert picklists | S-M | ⏳ Queued |
| #156 | `pr-dialog-audit-taskpanel` | TaskPanel: convert Status + Priority picklists | S | ⏳ Queued |
| #157 | `pr-activities-list-page` | New `pages/Activities.tsx` + Reports tab (replaces Leads tab) | M | ⏳ Queued |
| #158 | `pr-activities-sync` | `data_sync.sync_activities()` round-trip tests + manual verification (Sprint 9A; impl already landed) | S-M | ⏳ Queued |
| #159 | `pr-activities-detail-tabs` | `ActivityTimeline` component + Activities tabs on Opportunity / Account / Contact detail dialogs | M | ⏳ Queued |
| #160 | `pr-b4a-task-title-true` | Fix: task title coerces to "True" on save | S | ⏳ Queued |
| #161 | `pr-b4b-task-description-400` | Fix: description save returns 400 | S | ⏳ Queued |
| #162 | `pr-b4c-task-title-not-persisting` | Fix: title doesn't persist on create | S | ⏳ Queued |
| #163 | `pr-b4d-task-wrong-opportunity` | Fix: `WhatId` lands task on wrong opportunity | S | ⏳ Queued |
| #164 | `pr-b4e-task-delete-no-refresh` | Fix: delete doesn't refresh Priorities page | S | ⏳ Queued |
| #165 | `pr-b5-inline-edit-softening` | Soften sensitivity gate on Amount + Probability (keep Stage confirmation) | S | ⏳ Queued |
| #166 | `pr-b7-dropdown-position` | Fix MUI Autocomplete/Select popper positioning on inline-edit cells | S | ⏳ Queued |
| #167 | `pr-b8-progress-full-pipeline` | Progress page: include Lost + Withdrawn + Did Not Fulfill | S | ⏳ Queued |
| #168 | `pr-b9-inline-edit-affordance` | Blue-highlight field when in edit mode | S | ⏳ Queued |

Sizes: S = ≤200 LOC diff; M = 200-500; L = 500-1000. Any PR that exceeds its predicted size should split before review.
Status legend: ⏳ Queued · 🚧 in flight · 👀 in review · ✅ merged · ❌ abandoned.

## PR scope detail

---

### PR #147 — `pr-planning` (this PR)

**Ships:** this file, plus supersession + cross-reference updates on `tasks/jac-running-notes.md`, `tasks/handoff-prompt.md`, `tasks/mvp-launch-sprint.md`, `tasks/accounts-endpoint-pagination-followup.md`, `tasks/sprint9-activities-extension-plan.md`.

**No code.** Unblocks PR #148 onward.

---

### PR #148 — `pr-contacts-accounts-pagination`

**Backend changes — all mirror the Opportunities pattern at `main.py:304-375`:**
- `get_contacts` (`main.py:559-611`): `limit: Optional[int] = Query(None, le=5000)`; conditional `LIMIT`; `salesforce.query_all()`; cache key `f"contacts:{account_id}:{limit or 'all'}"`.
- `get_accounts` (`main.py:470-531`): `limit: Optional[int] = Query(None, le=2000)`; conditional `LIMIT`; `salesforce.query_all()`; cache key `f"accounts:{limit or 'all'}"`.
- `get_opportunity_tasks` (`main.py:924-970`): add `limit: Optional[int] = Query(None, le=2000)`; conditional `LIMIT`; `salesforce.query_all()`. (Currently has no `limit` param and no LIMIT clause — relies on SF's single-page cap.)
- `get_my_tasks` (`main.py:851-894`): default bump 200 → 2000, `le=2000`. **Keep `salesforce.query()`** — this endpoint is scope-bounded by date + `IsClosed = false`, rarely crosses the SF single-page cap, and `query_all` would cost more than it returns.

**Tests:**
- Update 3 existing `test_get_contacts_*` tests in `tests/test_api_endpoints.py` to mock `query_all` instead of `query`.
- Add `test_get_contacts_paginates_beyond_2000`: mock `query_all` returning 2500 records (list comprehension on `make_sf_contact`), assert response length == 2500, assert SOQL has no `LIMIT` clause.
- Update Accounts + opp-tasks tests similarly.
- Update `tests/conftest.py:mock_salesforce_service` fixture — add `service.query_all = AsyncMock(return_value={"records": []})` so child AsyncMock stubbing doesn't break.

**Verification:** `pytest tests/test_api_endpoints.py -v` no regressions; `npx tsc --noEmit` clean (no FE changes but confirm nothing else broke).

---

### PR #149 — `pr-rowcount-caption-reports-tabs`

**Frontend:**
- New `frontend/src/components/RowCountCaption.tsx` — props `{ visible: number; total: number; label: string; sx?: SxProps }`. Renders e.g. *"Showing 100 of 1,834 opportunities"*. Handles `visible === total` (drops "of Y"); handles `total === undefined` (shows just `visible {label}`).
- Opportunities (`pages/Opportunities.tsx`): migrate the hand-rolled caption at ~line 529 to `<RowCountCaption visible={visibleOpps.length} total={rawOpportunities.length} label="opportunities" />`. Keep the existing summary-stats box next to it.
- Accounts, Contacts, Tasks: add `<RowCountCaption>` above each DataGrid.
- **Skip Leads** — it's being dropped from Reports in PR #157 and has no standalone route (verified: no `/leads` route in `App.tsx`; no `navigate('/leads')` anywhere; the `Leads` component is only mounted via Reports tab 3). Applying a caption there would be wasted work.
- Tests: `RowCountCaption.test.tsx` — render assertions for the three shape variants (equal, different, unknown total).

**Verification:** manual against segundo-db, open each Reports tab, confirm caption matches expected totals.

---

### PR #150 — `pr-rowcount-caption-other-surfaces`

**Frontend:** apply `<RowCountCaption>` (from PR #149) to the remaining list surfaces:
- `pages/Priorities.tsx` / `pages/WeeklyPriorities.tsx`
- `pages/MyDashboard.tsx` (custom `PriorityTable` — may need a small adapter)
- `pages/Overview.tsx` (Progress page) — per-owner card headers
- `pages/Accounts.tsx` detail dialog — nested Opportunities grid (~line 916)
- Finance pages: `UnpaidBills`, `ReceivedPayments`, `PendingInvoices`, `PaymentProcessing`, `GivingCapacity`, `FinanceDashboard`

**Verification:** walk each page in the browser, confirm caption renders correctly.

---

### PR #151 — `pr-tasks-whoid`

**Problem:** TaskPanel hardcodes 6 editable fields. Critical gap: no Contact link — staff have to open Salesforce to link a task to a contact.

**Backend:**
- `TaskCreateRequest` (`main.py:901-908`): add `WhoId: Optional[str] = None`.
- `TaskUpdateRequest` (`main.py:910-917`): add `WhoId: Optional[str] = None`. (Already has `WhatId`.)
- Create/update handlers: pass through `WhoId` when present; `validate_salesforce_id(WhoId, "WhoId")` on set.
- Tests: round-trip WhoId.

**Frontend:**
- `TaskPanel.tsx`: add Contact autocomplete labelled "Contact (Who)". Default options to `apiService.getContacts({ account_id: opportunity.AccountId })`; fall back to unscoped on empty account or typeahead query.
- Display existing `WhoName` in edit mode.
- Tests: component render assertion.

**Intentionally standalone from B4 task-CRUD bug triage (PRs #160-164).** Adding a data-model field shouldn't block orthogonal bug fixes.

---

### PR #152 — `pr-use-schema-picklist`

**Foundation for PRs #153-#156. No user-visible change.**

- Generalize `frontend/src/hooks/useOpportunityTypePicklist.ts` → `frontend/src/hooks/useSchemaPicklist.ts`. Signature: `useSchemaPicklist(sobject: string, fieldName: string)`. React-query cache keyed on `['schema-picklist', sobject, fieldName]`, 30-min staleTime.
- Retire `useOpportunityTypePicklist` as a thin wrapper: `export const useOpportunityTypePicklist = () => useSchemaPicklist('Opportunity', 'Type');`. Callers unchanged.
- Tests: unit test with mocked `apiService.getSchemaDescribe`.

---

### PR #153 — `pr-dialog-audit-opportunity`

Uses `useSchemaPicklist` (PR #152).

- Add editable `Earliest_Scheduled_Payment__c` (date picker).
- Convert hardcoded `OPPORTUNITY_STAGES` array usage → `useSchemaPicklist('Opportunity', 'StageName')`. If schema fetch fails, render a disabled select with helper text — NOT a hardcoded legacy array.
- Convert `RenewalRepeat__c` similarly.
- Tests: form-render assertions for each converted field.

---

### PR #154 — `pr-dialog-audit-account`

- Convert `npsp__Matching_Gift_Request_Deadline__c` text input → date picker.
- Convert all remaining hardcoded picklist fallback arrays (Type, Account_Tier__c, Industry, AccountSource, Company_Size__c, npsp__Funding_Focus__c, Organization_Focus_Area_s__c) → `useSchemaPicklist` with disabled-select fallback.
- Tests: form-render assertions.

---

### PR #155 — `pr-dialog-audit-contact`

- Add editable `npe01__AlternateEmail__c`.
- Convert hardcoded Salutation fallback + any remaining hardcoded picklists → `useSchemaPicklist`.
- Tests: form-render assertions.

---

### PR #156 — `pr-dialog-audit-taskpanel`

- Convert hardcoded Status array → `useSchemaPicklist('Task', 'Status')`.
- Convert hardcoded Priority array → `useSchemaPicklist('Task', 'Priority')`.
- Tests.

(Does not include adding `WhoId` — that's PR #151, intentionally separate.)

---

### PR #157 — `pr-activities-list-page`

**Frontend:**
- New `frontend/src/pages/Activities.tsx` — DataGrid list of `bedrock.activity` rows.
  - Uses existing `apiService.getActivities(params)` (already defined at `services/api.ts:595`, returns `ApiResponse<Activity[]>`) with `paginationMode="server"` (the backend endpoint supports `offset`/`limit` natively).
  - Columns hand-built from the `Activity` model (`models.py:169-201`) and `types/activity.ts` — not SF-describe, since Activities are a local bedrock-db object.
  - Filter bar: type (enum), source (enum), activity_date range, entity scope (opportunity/account/contact) — maps to `ActivityFilterParams` already defined.
  - Row click → if `sf_id` set, open related SF Task/Event dialog (edits flow through SF, per Sprint 9 design).
- `pages/Reports.tsx`: drop Leads tab (JP directive), add Activities tab. Update `TAB_MAP`.
- **Leads consequence (verified):** the `Leads` component at `pages/Leads.tsx` has no standalone route in `App.tsx` and no inbound `navigate('/leads')` anywhere in the codebase — it's only reachable via the Reports "Leads" tab. Dropping the tab makes `Leads.tsx` + `contexts/LeadsContext.tsx` dead code. PR #157 leaves the files in place (the LeadsProvider still wraps the tree in `App.tsx:112-338`, so removing it is a larger ripple). Actual deletion is an optional post-MVP cleanup PR.
- Apply `<RowCountCaption>` (from PR #149) — totals come from the server via `meta.total` in `ApiResponse`, not client-side array length.

**Note.** The backend CRUD + apiService methods (`getActivities`, `getActivity`, `createActivity`, `updateActivity`, `deleteActivity`, `searchActivities`) are already implemented (`routes/activities.py` + `services/api.ts:595-615`). PR #157 is frontend list page + Reports tab wiring only.

**Tests:** render + filter interaction.

---

### PR #158 — `pr-activities-sync` (Sprint 9A verification + tests)

**Scope corrected after verification pass 2** (2026-04-20): `data_sync.py::sync_activities()` is substantially **already implemented** at lines 55-162:
- Reads watermark via `MAX(sf_last_modified) FROM bedrock.activity WHERE source = 'salesforce'` (so the watermark lives in the activity table itself — no separate `bedrock.sync_watermark` table needed).
- Fetches Tasks + Events via `salesforce.query_all` with `LastModifiedDate > {watermark}` WHERE clauses.
- Maps to `bedrock.activity` columns via `_map_sf_task` (data_sync.py:199-250) and `_map_sf_event` (data_sync.py:252-281).
- Upserts via `_upsert_activity` (data_sync.py:283-332) with `WHERE bedrock.activity.deleted_at IS NULL` guard — soft-deleted rows are skipped.
- Wired into `sync_all_data()` at line 340. `/api/activities/sync/trigger` (`routes/activities.py:87-106`) acquires a lock and calls this method in a BackgroundTask.

**What's actually missing:**
- **Round-trip test coverage.** `tests/test_activities.py` has endpoint-level tests (sync_count, sync_trigger, sync_status) but nothing that feeds 3 mock Tasks + 2 mock Events through `sync_activities()` and asserts 5 `bedrock.activity` rows with correctly mapped columns + soft-delete preservation.
- **End-to-end verification against Pursuit's real SF org** — does the sync complete? How long does it take? Are there unexpected record types that fail mapping?
- Any edge-case fixes surfaced by the above.

**Scope for PR #158:**
1. Add `tests/test_activity_sync.py` (or extend `test_activities.py`) — mock SF query_all returning Tasks + Events, run `sync_activities()`, assert bedrock.activity rows. Include cases for: Task with email TaskSubtype → "email" type; Task with CallType → "call"; Event IsAllDayEvent → "calendar-event" vs "meeting"; WhatId → opportunity_id vs account_id routing; soft-deleted row not resurrected.
2. Manual run against segundo-db — trigger sync, check row counts + sync_history.
3. Any edge-case fixes from (1) or (2).

Size bumps from original estimate: if round-trip tests surface real bugs, the fix bundle grows. Split if needed.

---

### PR #159 — `pr-activities-detail-tabs`

**Frontend:**
- New `frontend/src/components/ActivityTimeline.tsx` — reusable timeline, takes `{ opportunityId?; accountId?; contactId? }`, queries `GET /api/activities/` filtered.
- Wire into Opportunity detail dialog (Activities tab).
- Wire into Account detail dialog — verify the existing Activities tab area around `Accounts.tsx:916`; migrate to shared component.
- Wire into Contact detail dialog (add Activities tab).

Split further if `ActivityTimeline` itself proves non-trivial.

---

### PR #160 — `pr-b4a-task-title-true`

Fix: task title saved as literal `"True"` instead of entered value. Suspected boolean coercion in `Tasks.tsx`'s `processRowUpdate` or in the TaskPanel save payload. Trace Tasks.tsx → TaskPanel → `updateTask` → backend. Regression test.

---

### PR #161 — `pr-b4b-task-description-400`

Fix: description save returns 400 from backend. Likely request-body shape mismatch against `TaskUpdateRequest`. Trace request payload vs. model. Regression test.

---

### PR #162 — `pr-b4c-task-title-not-persisting`

Fix: title entered on create doesn't land in DB. Separate from B4a (which is a post-save coercion). Trace create flow + TaskCreateRequest handling. Regression test.

---

### PR #163 — `pr-b4d-task-wrong-opportunity`

Fix: task created on one opportunity lands on another. `WhatId` binding at create time is wrong. Trace TaskPanel → `createOpportunityTask` → backend. Regression test.

---

### PR #164 — `pr-b4e-task-delete-no-refresh`

Fix: deleted task still shows on Priorities page. React-query invalidation for the `['my-tasks']` key not firing post-delete. Regression test covering cache invalidation.

---

### PR #165 — `pr-b5-inline-edit-softening`

From `mvp-launch-sprint.md` B5. Soften the sensitivity gate on Amount + Probability so users don't hit an unlock step. Keep Stage's confirmation dialog. Tests.

---

### PR #166 — `pr-b7-dropdown-position`

From `mvp-launch-sprint.md` B7. Fix MUI Autocomplete/Select popper positioning on inline-edit cells — anchor to the cell, not screen top. Confirm in Chrome, Safari, Firefox.

---

### PR #167 — `pr-b8-progress-full-pipeline`

From `mvp-launch-sprint.md` B8. Jac's argument: managing a pipeline means surfacing losses and withdraws. Add Lost + Withdrawn + Did Not Fulfill to the `PipelineFunnel` / stage-breakdown view.

---

### PR #168 — `pr-b9-inline-edit-affordance`

From `mvp-launch-sprint.md` B9. Fully blue-highlight the field when in edit mode (currently only a thin border). Keep the green-check save indicator.

---

## Stretch / post-MVP parking lot

- **Schema-driven dialog generator** — `buildSchemaDialog()` analog to `buildSchemaColumns()`. Replaces every hardcoded field list. Large refactor. Defer until MVP is running in production.
- **`useSchemaFields(sobject)` hook** — deferred until a consumer actually needs it (YAGNI).
- **Accounts endpoint performance audit** — if `query_all()` on Accounts introduces latency spikes, move to `paginationMode="server"` at the DataGrid layer.
- **Chrome extension** (Sprint 9B-D per `tasks/sprint9-activities-extension-plan.md`).
- **Playwright click-through tests** (Jac suggestion, 2026-04-17).
- **Post-MVP dialog-stack rework** — JP's modal-stack vs drawer vs tab debate is parked per `mvp-launch-sprint.md:123`.

## File reference

| Concern | File |
|---|---|
| Backend list endpoints | `financial_forecasting/main.py`, `financial_forecasting/routes/activities.py` |
| SF client (query / query_all) | `financial_forecasting/mcp_client/services/salesforce.py` |
| Backend update request models | `financial_forecasting/models.py` (Activity*, OpportunityUpdateRequest), `financial_forecasting/main.py` (Task*, Account*, Contact*) |
| Backend tests | `financial_forecasting/tests/test_api_endpoints.py`, `financial_forecasting/tests/test_activities.py`, `financial_forecasting/tests/conftest.py` |
| Activities table DDL | `financial_forecasting/db/init.sql:578-671` |
| List pages | `financial_forecasting/frontend/src/pages/Opportunities.tsx`, `Accounts.tsx`, `Contacts.tsx`, `Tasks.tsx`, `Leads.tsx` |
| Edit dialogs | `financial_forecasting/frontend/src/components/OpportunityEditDialog.tsx`, `AccountEditDialog.tsx`, `ContactEditDialog.tsx`, `TaskPanel.tsx` |
| Schema utilities | `financial_forecasting/frontend/src/utils/schemaColumns.tsx`, `financial_forecasting/frontend/src/hooks/useOpportunityTypePicklist.ts` |
| SF schema describe endpoint | `financial_forecasting/routes/salesforce_schema.py:143-184` |

## Cross-references

- `tasks/mvp-launch-sprint.md` — original B1-B9 scope. B3 and B6 now absorbed into PRs #148-#150; B4 splits into PRs #160-#164; B5, B7-B9 become PRs #165-#168.
- `tasks/jac-running-notes.md` — live status page for Jac. Updates bundled with each PR.
- `tasks/handoff-prompt.md` — fresh-session prompt. Updated in this PR to point here.
- `tasks/accounts-endpoint-pagination-followup.md` — folded into PR #148.
- `tasks/sprint9-activities-extension-plan.md` — remains authoritative for Activities internals; PRs #157-#159 reference it.
- `tasks/remaining-32-test-failures-plan.md` — pre-existing test failures, parallel track, not blocked on this plan.
- `tasks/stage-list-drift-plan.md`, `tasks/recordtype-audit-post-mvp.md` — post-MVP v1 tracks, not blocked on this plan.
