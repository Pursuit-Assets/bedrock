# Parallel PR lanes — MVP final sprint

**Created:** 2026-04-21 after 2-pass verification against `origin/dev` HEAD `4a9407a` (post-Jac #151).
**Source of scope:** `tasks/objects-production-readiness-plan.md` (superseded numbering — see below).
**Principle:** PRs may run concurrently across lanes only when they touch **zero overlapping files**. Within a lane, PRs are sequential.

## Numbering shift

Plan's original `#147-#169` maps to actual numbers via the table below. Lane-interleaved execution means a single shift number no longer applies cleanly; each PR locks its actual number at `gh pr create` time and updates this table.

| Original plan # | Actual # | Status |
|---|---|---|
| #147 (plan doc) | #147 | ✅ merged 2026-04-20 |
| #148 (page rename) | #148 | ✅ merged 2026-04-20 |
| — (Jac's QA pack) | #151 | ✅ merged 2026-04-21 |
| — (rollups) | #149, #150, #152 | ✅ release branches |
| — (singleton race fix) | #153 | ✅ merged 2026-04-21 |
| — (parking-lot docs) | #154 | ✅ merged 2026-04-21 |
| #149 (pagination — A1) | #155 | ✅ merged 2026-04-21 |
| #153 (B1 schema-picklist hook) | **#156** | ✅ merged 2026-04-21 |
| — (A2 activities-sync tests) | **#157** | ✅ merged 2026-04-21 |
| A3 (progress-tracking orphan cleanup, est. #177) | **#158** | ✅ merged 2026-04-21 |
| B2 (`pr-dialog-audit-opportunity`, est. #161 — scope-expanded to bundle Payment navigation) | **#159** | ✅ merged 2026-04-21 |
| A4 (opp-type deprecation, est. #159) | **#160** | 👀 this PR (2026-04-21) |
| ... | later targets locked at PR-open time — lane-interleaved | — |

## Blocking prerequisite

**PR #153 `pr-singleton-race-fix` must merge before either lane starts.** See `tasks/pr153-singleton-race-fix-plan.md`. Touches `dependencies.py` foundational to every SF-reading endpoint; parallel work would risk merging on top of broken semantics.

---

## Lane A — Backend & cross-cutting cleanups (11 PRs)

Priority: backend correctness first, then cross-cutting UI cleanups that touch isolated files.

> **Numbering note (2026-04-21):** After the parking-lot docs PR landed as `#154`, the queue bumped +1. The `# (target)` column below is an *estimate* — the actual number comes from GitHub at PR-open time. Before opening a branch, run `gh pr list --state all --limit 1 --json number --jq '.[0].number'`, add 1 = your target. If the number drifts again, update this file's rows + the collision-gate table as part of your PR's doc bundle.

| Order | # (target) | Slug | Touches | Depends on |
|---|---|---|---|---|
| A1 👀 | #155 | `pr-contacts-accounts-pagination` | `main.py` (get_accounts 470, get_contacts 559, get_my_tasks 851, get_opportunity_tasks 924), `tests/test_api_endpoints.py`, `tests/conftest.py` (add `query_all` mock), plus comment trim in `OpportunityEditDialog.tsx` + `AccountCell.tsx` | #153 |
| A2 ✅ | #157 | `pr-activities-sync-tests` | `tests/test_activity_sync.py` NEW — 54 round-trip tests for `sync_activities()` + mappers + `_parse_sf_datetime` + `_upsert_activity` | #153 |
| A3 ✅ | #158 | `pr-progress-tracking-orphan-cleanup` | `main.py:44, 120` (unregister router), DELETE `routes/progress_tracking.py`, DELETE `tests/test_progress_tracking.py`, `db/migrations/2026-04-21-drop-progress-tracked-override.sql` NEW (rollback), 5 FE stale BUG-UI-19 comments: delete `api.ts:~326-330`, `Settings.tsx:~223-226`, `Settings.tsx:~680-681`, trim `Progress.tsx:~450` parenthetical; `Progress.tsx:~114-118` intentionally left as-is per JP (architectural WHY-not above live useQuery) | #153 |
| A4 👀 | #160 | `pr-opp-type-deprecation` | `main.py` (6 edits + RenewalRepeat__c SOQL-inclusion fix found via adversarial audit), `types/salesforce.ts:129`, `Opportunities.tsx` (9 edits incl. dead `pbcOnly` cascade + filter predicate), `Opportunities/columns.tsx` (4 edits: interface + stale comments), `Opportunities/helpers.ts` (drop orphaned local `Type?` field), `Opportunities/useOpportunityData.ts` (remove `pbcOnly` param + `params.opp_type='PBC'` dead branch), `PipelineFilterBar.tsx` (remove `types` filter + Autocomplete + active-filter chip), `services/api.ts:143` (remove `opp_type?`), `Progress.tsx` (local `Opportunity` interface: Type → RenewalRepeat__c; `isRenewal` rewrite to match canonical `priorityScoring.ts:110` pattern), `Priorities.tsx:816` + `utils/priorityScoring.ts:14` (drop dead `Type` mapping + interface field), `useOpportunityRecordTypes.ts` (stale-hook-reference comment cleanup), DELETE `hooks/useOpportunityTypePicklist.ts` (86 LOC), DELETE `components/inline-edit/cells/TypeCell.tsx` (79 LOC), `conftest.py::make_sf_opportunity` (Type → RecordTypeId + RecordType.Name swap + `RenewalRepeat__c` default), `test_api_endpoints.py` (Type → RecordType.Name round-trip assertion swap + SOQL-content guard for `RenewalRepeat__c`) | #153. See `tasks/opp-type-full-delete-decision.md` for full inventory + the 4 additional consumers surfaced during A4 verification + the RenewalRepeat__c SOQL fix from adversarial 3-pass verification + JP-approved scope expansion. |
| A5 | #175 | `pr-b8-progress-full-pipeline` | `pages/Progress.tsx` or `components/PipelineFunnel.tsx` — include Lost/Withdrawn/Did Not Fulfill | #153 |
| A6 | #156 | `pr-rowcount-caption-details-tabs` | NEW `components/RowCountCaption.tsx` + test, migrate caption in `pages/Opportunities.tsx`, `pages/Accounts.tsx`, `pages/Contacts.tsx`, `pages/Tasks.tsx`. **Depends on A1 #155 for accurate totals** (query_all). | A1 |
| A7 | #157 | `pr-rowcount-caption-other-surfaces` | `pages/Priorities.tsx`, `pages/Progress.tsx`, `pages/WeeklyPriorities.tsx`, `pages/Accounts.tsx` (nested grid), 6 finance pages (`UnpaidBills`, `ReceivedPayments`, `PendingInvoices`, `PaymentProcessing`, `GivingCapacity`, `FinanceDashboard`) | A6 |
| A8 | #174 | `pr-b7-dropdown-position` | `components/inline-edit/cells/*Cell.tsx` (MUI Autocomplete/Select PopperProps anchor) | #153 |
| A9 | #173 | `pr-b5-inline-edit-softening` | `components/inline-edit/InlineEditable.tsx`, `utils/fieldSensitivity.ts` — soften gate on Amount + Probability, keep Stage | #153 |
| A10 | #176 | `pr-b9-inline-edit-affordance` | `components/inline-edit/InlineEditable.tsx` — blue-highlight field when in edit mode | A9 (same file) |
| A11 | #167 | `pr-activities-detail-tabs` | `components/AccountEditDialog.tsx` — add Activities tab wired to ActivityTimeline | B3 done (both touch AccountEditDialog.tsx) |

---

## Lane B — Frontend dialogs + TaskPanel stream (14 PRs)

Priority: dialog audits first (foundation), then TaskPanel stream (WhoId then picklists then bug fixes), then closing items.

> **Numbering note (2026-04-21, updated after B2 opened at #159):** A1 at #155, B1 at #156, A2 at #157, A3 at #158, and B2 at #159 — the original `#160-#178` Lane B estimates continue to shift down as lanes interleave. The `# (target)` column below is an *estimate*; the actual number comes from GitHub at PR-open time. Same procedure as Lane A: before cutting a branch, run `gh pr list --state all --limit 1 --json number --jq '.[0].number'`, add 1 = your target, update this file's row + the collision-gate numbering if it drifts further.

| Order | # (target) | Slug | Touches | Depends on |
|---|---|---|---|---|
| B1 ✅ | **#156** | `pr-use-schema-picklist` | NEW `hooks/useSchemaPicklist.ts` + `useSchemaPicklist.test.tsx` + bundled doc updates (this file + `jac-running-notes.md` + `objects-production-readiness-plan.md` PR #153 scope tweak) | #153 |
| B2 ✅ | **#159** | `pr-dialog-audit-opportunity` (scope expanded 2026-04-21, post-smoke iteration same-day) | `components/OpportunityEditDialog.tsx` — three picklist/date conversions + **inline Payment Schedule accordion** (replaces an early nav-link iteration that dead-ended users); `components/PaymentEditDialog.tsx` — refactor orphan's hardcoded `FALLBACK_PAYMENT_METHODS` + Department + GL Account picklists → `useSchemaPicklist` (no-demo-versions); `pages/PaymentSchedule.tsx` — Edit Details clickthrough opens (now-wired) PaymentEditDialog; NEW `OpportunityEditDialog.test.tsx` (13 tests), `PaymentEditDialog.test.tsx` (6 tests), `PaymentSchedule.test.tsx` (3 tests) | B1 |
| B2-extra 👀 | **#161** | `pr-opp-payment-create` (post-merge follow-up on #159) | `main.py` — NEW `POST /api/salesforce/payments` single-record create + `PaymentCreateRequest` model; `frontend/src/services/api.ts` — NEW `createSfPayment`; `components/OpportunityEditDialog.tsx` — accordion moved OUT of `PAYMENT_SUMMARY_STAGES` conditional (always-visible) + "+ Add Payment" IconButton; NEW `components/PaymentCreateDialog.tsx` + test; `tests/test_api_endpoints.py` — NEW `TestSalesforcePaymentCreate` (4 tests) + `edit_payments: True` in `mock_db` fixture; extended `OpportunityEditDialog.test.tsx` (+2 tests, 15 total) | #159 |
| B3 | #162 | `pr-dialog-audit-account` | `components/AccountEditDialog.tsx` only — convert `FALLBACK_TYPES`, `FALLBACK_TIERS`, all remaining hardcoded picklists → `useSchemaPicklist`; convert `npsp__Matching_Gift_Request_Deadline__c` text → date picker | B1 |
| B4 | #163 | `pr-dialog-audit-contact` | `components/ContactEditDialog.tsx` only — convert `FALLBACK_SALUTATIONS` → schema, add editable `npe01__AlternateEmail__c` | B1 |
| B5 | #158 | `pr-tasks-whoid` | `main.py:900-918` (`TaskCreateRequest`, `TaskUpdateRequest` add `WhoId`), `main.py` task create/update handlers, `components/TaskPanel.tsx` (Contact autocomplete), `tests/test_api_endpoints.py` (WhoId round-trip) | #153 |
| B6 | #164 | `pr-dialog-audit-taskpanel` | `components/TaskPanel.tsx` — convert hardcoded Status + Priority MenuItems → `useSchemaPicklist('Task', 'Status')` + `useSchemaPicklist('Task', 'Priority')` | B1 + B5 |
| B7 | #168 | `pr-b4a-task-title-true` | `components/TaskPanel.tsx` — trace + fix title-coerces-to-"True" on save | B6 (same file) |
| B8 | #169 | `pr-b4b-task-description-400` | `components/TaskPanel.tsx` + `main.py::update_task` (if backend body mismatch) | B7 |
| B9 | #170 | `pr-b4c-task-title-not-persisting` | `components/TaskPanel.tsx` — fix title-on-create | B8 |
| B10 | #171 | `pr-b4d-task-wrong-opportunity` | `components/TaskPanel.tsx` — fix WhatId binding on create | B9 |
| B11 | #172 | `pr-b4e-task-delete-no-refresh` | `components/TaskPanel.tsx` + react-query cache-key invalidation | B10 |
| B12 | #165 | `pr-activities-list-page` | NEW `pages/Activities.tsx`, `pages/Details.tsx` (drop Leads tab + TAB_MAP, add Activities tab), `components/Layout.tsx:86-90` subtitle | #153 |
| B13 | #178 | `pr-drivelink-stub-fix` | `components/TaskPanel.tsx` — decision point inside PR: strip DriveLink UI, OR wire through to SF custom field (ask JP first) | B11 (same file) |

---

## Cross-lane collision gate

Before merging a PR in one lane, check if the concurrent PR in the other lane touches any of the same files. If yes, **serialize** (hold the later PR until the earlier merges + rebase).

### Round-by-round concurrent pairings (verified disjoint files):

| Round | Lane A | Lane B | Shared files? |
|---|---|---|---|
| 1 | A1 pagination | B1 useSchemaPicklist | ❌ none (main.py list endpoints vs new hook file) |
| 2 | A2 sync tests | B2 Opp dialog audit | ❌ none |
| 3 | A3 orphan cleanup | B3 Account dialog | ❌ none (A3 touches `Progress.tsx` comment only — not AccountEditDialog) |
| 4 | A4 Opp.Type delete (#160) | B2 Opp dialog audit (#159) | ❌ none — B2 touches `OpportunityEditDialog.tsx` only (verified zero `formData.Type` bindings there; line 130 is a stale comment only). A4 does not touch `OpportunityEditDialog.tsx`. Interleaved in actual PR order. |
| 4b | A4 Opp.Type delete | B4 Contact dialog | ❌ none (A4 touches Opp-related + PipelineFilterBar; B4 is ContactEditDialog only) |
| 5 | A5 Progress full pipeline | B5 Tasks WhoId | ❌ none (A5 touches `Progress.tsx`/`PipelineFunnel.tsx`; B5 touches `main.py:900-918` + `TaskPanel.tsx`) |
| 6 | A6 RowCountCaption core | B6 TaskPanel picklists | ❌ none (A6 touches `Tasks.tsx` grid; B6 touches `TaskPanel.tsx` drawer — **different files**) |
| 7 | A7 RowCountCaption elsewhere | B7 B4a task title | ❌ none (A7 touches pages; B7 touches TaskPanel.tsx) |
| 8 | A8 dropdown position | B8 task description 400 | ❌ none (A8 touches inline-edit cells; B8 touches TaskPanel.tsx + `main.py::update_task` — different main.py region from A1) |
| 9 | A9 inline-edit softening | B9 task title persist | ❌ none |
| 10 | A10 inline-edit affordance | B10 task wrong opp | ❌ none |
| 11 | A11 Activities on Account | B11 task delete refresh | ❌ none (A11 touches AccountEditDialog AFTER B3 merged; B11 touches TaskPanel.tsx) |
| 12 | Lane A idle | B12 Activities list page | n/a |
| 13 | Lane A idle | B13 DriveLink fix | n/a |

**Collision red flags to watch for during actual execution** (if a PR's scope grows beyond this table):

- Any new PR touching `main.py` — check against A1, A3, A4, B5, B8 regions.
- Any new PR touching `TaskPanel.tsx` — serialize into Lane B stream (B5 → B6 → B7 → B8 → B9 → B10 → B11 → B13).
- Any new PR touching `components/inline-edit/InlineEditable.tsx` — serialize into A9 → A10.
- Any new PR touching `AccountEditDialog.tsx` — serialize with B3, A11.

---

## Workflow per PR (in either lane)

1. **Check `git log --oneline -3 origin/dev`** — confirm the other lane's most recent merge didn't land in files you're about to touch. If it did, rebase locally before branching.
2. **Cut branch:** `git checkout origin/dev && git checkout -b <type>/pr<NNN>-<slug>`.
3. **Execute the PR's scope** exactly as specified in `tasks/objects-production-readiness-plan.md` (or this file's per-PR notes).
4. **Enter plan mode first** for anything non-trivial — per `feedback_production_discipline`. Verify claims against source. 4+ passes if scope is ambiguous.
5. **Bundle doc updates in the same PR diff:**
   - Update the lane's row in this file (status → 👀 in review).
   - Add a progress-log entry to `tasks/jac-running-notes.md`.
   - Flip the PR-sequence table status in `tasks/objects-production-readiness-plan.md`.
6. **PR = "I tested this and it's good"** — tsc clean, pytest passing (no new failures vs. 20-failure baseline), manual smoke on the feature. Per Jac's process rule.
7. **Squash-merge on JP approval.** Per `feedback_prefer_prs`.

## When to stop a lane

- **Merge conflict you can't cleanly rebase through** → freeze the lane, resolve in the blocking PR first.
- **A PR's actual size exceeds its size estimate** (S ≤200, M 200-500, L 500-1000 LOC diff) → split before review; update this file's row accordingly.
- **Discovered a scope expansion while coding** → pause, surface to JP, re-plan; don't keep pushing.

## Lane A finishes first; then what?

Lane B is 3 PRs longer (14 vs 11). Once Lane A completes, the Lane A operator can:
- Pick up bug reports from QA during Lane B's closing PRs
- Tackle the production-hardening parking lot (typed request models for `Dict[str, Any]` create/update endpoints — 6 handlers)
- Or idle and watch review queue

## Reference

- Plan source: `tasks/objects-production-readiness-plan.md` (pre-shift numbering — cross-reference to actual numbers via the shift table at top of this file)
- Jac's QA tracker: `tasks/pr-139-qa-bugs.md`
- Handoff: `tasks/handoff-prompt.md`
- Running status: `tasks/jac-running-notes.md`
- Blocking PR: `tasks/pr153-singleton-race-fix-plan.md`
- Opp.Type decision: `tasks/opp-type-full-delete-decision.md`
