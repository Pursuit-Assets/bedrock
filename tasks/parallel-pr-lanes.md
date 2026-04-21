# Parallel PR lanes — MVP final sprint

**Created:** 2026-04-21 after 2-pass verification against `origin/dev` HEAD `4a9407a` (post-Jac #151).
**Source of scope:** `tasks/objects-production-readiness-plan.md` (superseded numbering — see below).
**Principle:** PRs may run concurrently across lanes only when they touch **zero overlapping files**. Within a lane, PRs are sequential.

## Numbering shift

Plan's original `#147-#169` is now `#147-#152` done (Jac's #151 QA polish pack + rollups), remaining shifted +4.

| Original plan # | Actual # | Status |
|---|---|---|
| #147 (plan doc) | #147 | ✅ merged 2026-04-20 |
| #148 (page rename) | #148 | ✅ merged 2026-04-20 |
| — (Jac's QA pack) | #151 | ✅ merged 2026-04-21 |
| — (rollups) | #149, #150, #152 | ✅ release branches |
| — (NEW, blocks all) | **#153** | 🚧 next |
| #149 (pagination) | #154 | queued |
| #150 (RowCountCaption core) | #155 | queued |
| ... | +4 from here | — |

## Blocking prerequisite

**PR #153 `pr-singleton-race-fix` must merge before either lane starts.** See `tasks/pr153-singleton-race-fix-plan.md`. Touches `dependencies.py` foundational to every SF-reading endpoint; parallel work would risk merging on top of broken semantics.

---

## Lane A — Backend & cross-cutting cleanups (11 PRs)

Priority: backend correctness first, then cross-cutting UI cleanups that touch isolated files.

| Order | # | Slug | Touches | Depends on |
|---|---|---|---|---|
| A1 | #154 | `pr-contacts-accounts-pagination` | `main.py` (get_accounts 470, get_contacts 559, get_my_tasks 851, get_opportunity_tasks 924), `tests/test_api_endpoints.py`, `tests/conftest.py` (add `query_all` mock) | #153 |
| A2 | #165 | `pr-activities-sync-tests` | `tests/test_activity_sync.py` NEW (or extension of `test_activities.py`) | #153 |
| A3 | #176 | `pr-progress-tracking-orphan-cleanup` | `main.py:44, 120` (unregister router), DELETE `routes/progress_tracking.py`, DELETE `tests/test_progress_tracking.py`, `db/migrations/2026-04-21-drop-progress-tracked-override.sql` NEW (rollback), 3 FE stale comments (`Settings.tsx:680`, `Progress.tsx:~111-115`, `api.ts:~327`) | #153 |
| A4 | #158 | `pr-opp-type-deprecation` | `main.py` (lines 310, 322, 333, 352-353, 1591, 1619), `types/salesforce.ts:129`, `Opportunities.tsx:45,117,289-290,466-472`, `Opportunities/columns.tsx:36,83-85,157`, `PipelineFilterBar.tsx` (filter UI), DELETE `hooks/useOpportunityTypePicklist.ts`, DELETE `components/inline-edit/cells/TypeCell.tsx`, `conftest.py::make_sf_opportunity`, `test_api_endpoints.py` Type assertion | #153. See `tasks/opp-type-full-delete-decision.md` for full inventory. |
| A5 | #174 | `pr-b8-progress-full-pipeline` | `pages/Progress.tsx` or `components/PipelineFunnel.tsx` — include Lost/Withdrawn/Did Not Fulfill | #153 |
| A6 | #155 | `pr-rowcount-caption-details-tabs` | NEW `components/RowCountCaption.tsx` + test, migrate caption in `pages/Opportunities.tsx`, `pages/Accounts.tsx`, `pages/Contacts.tsx`, `pages/Tasks.tsx`. **Depends on A1 #154 for accurate totals** (query_all). | A1 |
| A7 | #156 | `pr-rowcount-caption-other-surfaces` | `pages/Priorities.tsx`, `pages/Progress.tsx`, `pages/WeeklyPriorities.tsx`, `pages/Accounts.tsx` (nested grid), 6 finance pages (`UnpaidBills`, `ReceivedPayments`, `PendingInvoices`, `PaymentProcessing`, `GivingCapacity`, `FinanceDashboard`) | A6 |
| A8 | #173 | `pr-b7-dropdown-position` | `components/inline-edit/cells/*Cell.tsx` (MUI Autocomplete/Select PopperProps anchor) | #153 |
| A9 | #172 | `pr-b5-inline-edit-softening` | `components/inline-edit/InlineEditable.tsx`, `utils/fieldSensitivity.ts` — soften gate on Amount + Probability, keep Stage | #153 |
| A10 | #175 | `pr-b9-inline-edit-affordance` | `components/inline-edit/InlineEditable.tsx` — blue-highlight field when in edit mode | A9 (same file) |
| A11 | #166 | `pr-activities-detail-tabs` | `components/AccountEditDialog.tsx` — add Activities tab wired to ActivityTimeline | B3 (#161) done (both touch AccountEditDialog.tsx) |

---

## Lane B — Frontend dialogs + TaskPanel stream (14 PRs)

Priority: dialog audits first (foundation), then TaskPanel stream (WhoId then picklists then bug fixes), then closing items.

| Order | # | Slug | Touches | Depends on |
|---|---|---|---|---|
| B1 | #159 | `pr-use-schema-picklist` | NEW `hooks/useSchemaPicklist.ts` + small test | #153 |
| B2 | #160 | `pr-dialog-audit-opportunity` | `components/OpportunityEditDialog.tsx` only — convert `OPPORTUNITY_STAGES` → `useSchemaPicklist('Opportunity', 'StageName')`, convert `RenewalRepeat__c` picklist, add editable `Earliest_Scheduled_Payment__c` | B1 |
| B3 | #161 | `pr-dialog-audit-account` | `components/AccountEditDialog.tsx` only — convert `FALLBACK_TYPES`, `FALLBACK_TIERS`, all remaining hardcoded picklists → `useSchemaPicklist`; convert `npsp__Matching_Gift_Request_Deadline__c` text → date picker | B1 |
| B4 | #162 | `pr-dialog-audit-contact` | `components/ContactEditDialog.tsx` only — convert `FALLBACK_SALUTATIONS` → schema, add editable `npe01__AlternateEmail__c` | B1 |
| B5 | #157 | `pr-tasks-whoid` | `main.py:900-918` (`TaskCreateRequest`, `TaskUpdateRequest` add `WhoId`), `main.py` task create/update handlers, `components/TaskPanel.tsx` (Contact autocomplete), `tests/test_api_endpoints.py` (WhoId round-trip) | #153 |
| B6 | #163 | `pr-dialog-audit-taskpanel` | `components/TaskPanel.tsx` — convert hardcoded Status + Priority MenuItems → `useSchemaPicklist('Task', 'Status')` + `useSchemaPicklist('Task', 'Priority')` | B1 + B5 |
| B7 | #167 | `pr-b4a-task-title-true` | `components/TaskPanel.tsx` — trace + fix title-coerces-to-"True" on save | B6 (same file) |
| B8 | #168 | `pr-b4b-task-description-400` | `components/TaskPanel.tsx` + `main.py::update_task` (if backend body mismatch) | B7 |
| B9 | #169 | `pr-b4c-task-title-not-persisting` | `components/TaskPanel.tsx` — fix title-on-create | B8 |
| B10 | #170 | `pr-b4d-task-wrong-opportunity` | `components/TaskPanel.tsx` — fix WhatId binding on create | B9 |
| B11 | #171 | `pr-b4e-task-delete-no-refresh` | `components/TaskPanel.tsx` + react-query cache-key invalidation | B10 |
| B12 | #164 | `pr-activities-list-page` | NEW `pages/Activities.tsx`, `pages/Details.tsx` (drop Leads tab + TAB_MAP, add Activities tab), `components/Layout.tsx:86-90` subtitle | #153 |
| B13 | #177 | `pr-drivelink-stub-fix` | `components/TaskPanel.tsx` — decision point inside PR: strip DriveLink UI, OR wire through to SF custom field (ask JP first) | B11 (same file) |
| B14 | #166 (crossed) | `pr-activities-detail-tabs` | ALREADY IN LANE A — listed here for reference (depends on B3) | — |

---

## Cross-lane collision gate

Before merging a PR in one lane, check if the concurrent PR in the other lane touches any of the same files. If yes, **serialize** (hold the later PR until the earlier merges + rebase).

### Round-by-round concurrent pairings (verified disjoint files):

| Round | Lane A | Lane B | Shared files? |
|---|---|---|---|
| 1 | A1 #154 pagination | B1 #159 useSchemaPicklist | ❌ none (main.py list endpoints vs new hook file) |
| 2 | A2 #165 sync tests | B2 #160 Opp dialog audit | ❌ none |
| 3 | A3 #176 orphan cleanup | B3 #161 Account dialog | ❌ none (#176 touches `Progress.tsx` comment only — not AccountEditDialog) |
| 4 | A4 #158 Opp.Type delete | B4 #162 Contact dialog | ❌ none (A4 touches Opp-related + PipelineFilterBar; B4 is ContactEditDialog only) |
| 5 | A5 #174 Progress full pipeline | B5 #157 Tasks WhoId | ❌ none (A5 touches `Progress.tsx`/`PipelineFunnel.tsx`; B5 touches `main.py:900-918` + `TaskPanel.tsx`) |
| 6 | A6 #155 RowCountCaption core | B6 #163 TaskPanel picklists | ❌ none (A6 touches `Tasks.tsx` grid; B6 touches `TaskPanel.tsx` drawer — **different files**) |
| 7 | A7 #156 RowCountCaption elsewhere | B7 #167 B4a task title | ❌ none (A7 touches pages; B7 touches TaskPanel.tsx) |
| 8 | A8 #173 dropdown position | B8 #168 task description 400 | ❌ none (A8 touches inline-edit cells; B8 touches TaskPanel.tsx + `main.py::update_task` — different main.py region from A1) |
| 9 | A9 #172 inline-edit softening | B9 #169 task title persist | ❌ none |
| 10 | A10 #175 inline-edit affordance | B10 #170 task wrong opp | ❌ none |
| 11 | A11 #166 Activities on Account | B11 #171 task delete refresh | ❌ none (A11 touches AccountEditDialog AFTER B3 merged; B11 touches TaskPanel.tsx) |
| 12 | Lane A idle | B12 #164 Activities list page | n/a |
| 13 | Lane A idle | B13 #177 DriveLink fix | n/a |

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
