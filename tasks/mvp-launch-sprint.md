# MVP launch sprint — 2026-04-19 onward

**Target:** ship Bedrock MVP to production, production-ready for daily team use.
**Source of scope:** JP + Jac review session 2026-04-17 (full transcript at `tasks/notes-2026-04-17-jac-review.md`).
**Upstream context:** PR #139 merged dev → main 2026-04-19T14:03:01Z. This sprint ships on top of that baseline.

> **⚠️ Scope and pacing expanded 2026-04-20.** JP widened scope from "ship B1-B9 bug list" to "get all 5 core SF objects (Opportunities, Accounts, Contacts, Tasks, Activities) production-ready with real SF schemas and no shortcuts." Original Wed 2026-04-22 target deferred — pacing is now per-PR production-readiness, not calendar. See `tasks/objects-production-readiness-plan.md` for the master 22-PR sequence (#147-#168). Per-bug absorption is annotated inline below. B1 and B2 shipped before the expansion; B3-B9 all absorbed.

---

## Launch-day schedule (agreed in session)

- **Monday 2026-04-20:** JP works solo through end-of-day. Sends Jac a state-of-the-world update Monday night listing what's shipped and what's still open.
- **Tuesday 2026-04-21:** joint pair-build day.
  - 11:30 (brief check-in)
  - 2:30–3:30 (main working block — Jac blocked the jobs PRD time; Damon couldn't join anyway)
  - 4:00–5:00 (final go/no-go working session after Jac's Nick meeting)
- **Wednesday 2026-04-22:** launch.
- **After:** Jac is out the second half of the week; any post-launch hotfix lands on JP. Factor that into risk when deciding what to ship vs. defer.

---

## Bugs from the 2026-04-17 session — prioritized

### P0 — launch blockers

#### B1. Targets don't save to the real database

- **Symptom (Jac's testing session):** Jac could only see targets for Devica and Guillermo on the Progress page. JP's other targets set via Settings → Targets never landed in the shared DB. JP's local session saw them; Jac's didn't.
- **Jac's working theory:** targets are saving to a local/wrong location; the shared DB never gets the write. Or the table doesn't exist in the shared DB.
- **JP in session:** "I think maybe I didn't create the table out of respect for your database." Jac: "I think I did that. So check."
- **Where to look:**
  - `financial_forecasting/routes/owner_goals.py` (or wherever `Settings → Targets` POST lands)
  - `financial_forecasting/db/init.sql` — confirm the targets / owner_goals table exists in the schema
  - Verify the backend's `DATABASE_URL` env var during the test matches the shared segundo DB, not a local Postgres
  - Check whether there's a write that succeeds locally but silently fails against the shared DB (permissions, schema mismatch, missing table)
- **Acceptance criteria:**
  - Set a target via Settings → Targets in Bedrock
  - Sign out, sign back in from a different browser / incognito session
  - Target persists and shows up on the Progress page's Individual Goals & Pipelines table
  - Confirm row exists in the shared DB via direct SQL query

#### B2. Opportunity `Type` field not pulling in on the opportunity view

- **Symptom:** Mercy Corps for Data is a PBC contract with `Type = 'Other Fee for Service'` in Salesforce. On Bedrock's opportunity detail view, the Type field shows nothing.
- **What's known:** `main.py:330-338` `get_opportunities` SOQL SELECT already includes `Type`. So the query is correct. Bug is either in (a) the data transformer between SOQL response and frontend, (b) the frontend rendering, or (c) column visibility defaults hiding it.
- **Where to look:**
  - Frontend: `frontend/src/pages/Opportunities.tsx`, `pages/Opportunities/columns.ts`, `Opportunities/useOpportunityData.ts` — grep for `Type` field rendering
  - Check `types/salesforce.ts:SalesforceOpportunity` — `Type: string | null` is declared (line 129), so the type definition is fine
  - Backend response: hit `/api/salesforce/opportunities` directly in a test; verify `Type` is present in the response payload
- **Acceptance criteria:** Mercy Corps for Data (and any other PBC-type opp) shows its Type in the opp list and detail views. Filtering by Type works.

### P1 — high-value / high-visibility fixes

#### B3. Reports / Opportunities table only loads 500 records

> **📘 Absorbed 2026-04-20 into PRs #148-#150** of `tasks/objects-production-readiness-plan.md`. Root cause clarified: Opportunities backend was already correct (Jac's symptom was perceptual — pageSize=500 + stage filter); Contacts is the real backend cap. Fix propagates to all 4 SF list endpoints (Contacts, Accounts, opp-tasks, my-tasks) and adds a shared `<RowCountCaption>` to every list surface. Original acceptance criterion preserved below.

- **Symptom:** Jac sorted by Amount descending and the highest-amount real opportunity wasn't in the table. Table is capped at 500 rows regardless of how many opportunities exist.
- **JP in session:** "I had put that in the last one" — thought this was already fixed in PR #131 or earlier frontend test hygiene work. Apparently didn't actually land.
- **Suspected root causes (investigate in order):**
  1. Frontend DataGrid `pageSize` or `initialState.pagination` hard-coded to 500
  2. `useOpportunityData.ts` or `Opportunities.tsx` slicing the list client-side
  3. Backend `limit` param being sent with `500` somewhere (unlikely given default is 2000; but worth grep)
  4. `salesforce.query_all` pagination not iterating (would cap around SF's 2000 per-page limit, not 500 — so probably not this)
- **Jac also flagged:** "It's for contacts too. So just make sure that they're working the same as this one." Verify Contacts page has the same behavior and fix in the same PR.
- **Acceptance criteria:** Reports and Contacts pages show all rows matching the current filter (not 500, not 2000 — all). Verify by sorting by the heaviest column and confirming the extreme values are present.

#### B4. Task creation is broken in multiple places

> **📘 Absorbed 2026-04-20 into PRs #160-#164** of `tasks/objects-production-readiness-plan.md`. Each sub-bug (B4a-B4e) gets its own PR for review-sized diffs. Detail preserved below.

Treat as one bundled bug with multiple sub-failures, since they all share the create-task code path.

- **B4a. Title renamed to "True" on save.** Jac created a task named "test"; after save it appeared as "True" in the list. Suspect a boolean/truthy coercion in the save payload or in the grid's `processRowUpdate`.
- **B4b. Description save returns 400.** Opening a task to add a description triggers `Request failed with a 400 error when editing description`. Likely the backend expects a field shape the frontend isn't sending (e.g., wrapping the update, missing a required key).
- **B4c. Title doesn't persist on create.** Separately from B4a, the title entered on create doesn't always land in the DB at all.
- **B4d. Task lands on wrong opportunity.** Jac created a task while on a specific opportunity; the task got assigned elsewhere. Likely the `WhatId` / opportunity-context binding is wrong at create time.
- **B4e. Delete doesn't refresh priorities page.** Tasks marked deleted still show up on Priorities. No fast-refresh or cache invalidation.
- **Where to look:**
  - Backend: `financial_forecasting/routes/` — find the task POST / PATCH endpoint (likely `activities.py` or `tasks`-specific route)
  - Frontend: `pages/Priorities.tsx`, `components/TaskPanel.tsx`, wherever the task-create and task-edit flows live
  - React-query cache invalidation for `'tasks'` key or equivalent after delete
- **Acceptance criteria:** Full task CRUD works end-to-end — create with a title and description from the Priorities page on a specific opportunity, verify it lands on the right opp with the right fields, edit it, delete it, and confirm the delete reflects immediately on the Priorities UI.

#### B5. Inline-edit lock is too strict on Amount and Probability

> **📘 Absorbed 2026-04-20 into PR #165** of `tasks/objects-production-readiness-plan.md`.

- **Symptom:** Jac clicked on Amount and Probability cells in the Opportunities grid; couldn't edit without hitting an unlock step first.
- **Current design:** these fields are gated by the sensitivity table introduced in PR #112 (inline-edit foundation) and refined in PR #124 (Probability column sensitivity gate).
- **Jac's recommendation:** soften the UX. Either (a) remove the lock for these specific fields (they're not that sensitive relative to Stage); (b) keep the lock but make click-to-edit much faster and clearer so users don't feel they need a lock; (c) move to a "confirm on save" model instead of "lock before edit".
- **JP's lean in session:** agree to soften. Add clearer visual affordance — blue highlight on click, faster loading state, better save confirmation. Lean toward option (b) + option (c) combined.
- **Scope check:** Stage column still needs its confirmation dialog (critical field). Don't remove that. Amount + Probability are the targets here.
- **Acceptance criteria:** Click Amount → field goes blue, editable immediately, no extra unlock step. Save triggers the existing green-check confirmation. Same for Probability.

#### B6. Contacts page inline-edit migration — may not have shipped

> **📘 Absorbed 2026-04-20 into PRs #148-#149** of `tasks/objects-production-readiness-plan.md`. Verification revealed Contacts.tsx already uses `buildSchemaColumns()` with inline edit (the migration DID ship). The remaining work is the backend row-cap fix (PR #148) + row-count caption (PR #149) — both covered.

- **JP in session:** "I may just not have gotten to shipping that one yet. I have to check like my Sprint list."
- **What to verify:**
  - `pages/Contacts.tsx` — does it use the inline-edit primitive from `components/inline-edit/` (PR #112)? Or is it still on the old edit-dialog-only flow?
  - If not migrated: decide in-scope vs. defer for MVP. Jac explicitly asked "make sure they're working the same as this one" for the 500-limit bug in B3, implying contacts should be at feature parity with Opportunities.
- **Recommended action:** check, then ship the migration if it wasn't in the rolled-up PRs. If it's a bigger lift than a few hours, flag to Jac and defer with a known-issues note.

### P2 — UX polish worth doing before launch

#### B7. Dropdown picker appears at wrong screen position

> **📘 Absorbed 2026-04-20 into PR #166** of `tasks/objects-production-readiness-plan.md`.

- **Symptom:** Click a dropdown for Account or Owner in an inline-edit cell. The dropdown list appears at the top of the screen instead of anchored to the cell.
- **Jac confirmed:** "I've actually seen this in browser too" — not a cursor IDE rendering artifact, it's a real UI bug.
- **Where to look:** MUI `Autocomplete` or `Select` component's anchor/popper configuration. Probably missing a `PopperProps` or `MenuProps` anchor.
- **Acceptance criteria:** dropdown appears directly under the cell being edited. Works in desktop Chrome, Safari, Firefox.

#### B8. Progress page should show full pipeline (including Lost + Withdrawn)

> **📘 Absorbed 2026-04-20 into PR #167** of `tasks/objects-production-readiness-plan.md`.

- **Jac's argument:** "A really important part of managing a pipeline is to surface losses and withdraws... we actually want to encourage people to mark something as a loss when it's a loss."
- **JP's response in session:** "Why don't we just show the full pipeline? All the active stages for philanthropy pipeline can be here."
- **Scope:** on the Progress page's PipelineFunnel / stage-breakdown view, add Lost and Withdrawn as visible stages (probably at the bottom or in a separate "Closed — unsuccessful" section).
- **Where to look:** `frontend/src/pages/Overview.tsx` (which renders the Progress component), `frontend/src/components/PipelineFunnel.tsx`.
- **Acceptance criteria:** Progress page shows all active philanthropy stages plus Lost / Withdrawn / Did Not Fulfill. RMs can see their loss rate at a glance.

#### B9. Inline-edit "I'm actively editing" affordance is too subtle

> **📘 Absorbed 2026-04-20 into PR #168** of `tasks/objects-production-readiness-plan.md`.

- **Current:** thin blue border when clicked.
- **Jac + JP agreed:** fully blue-highlight the field when in edit mode. Keep the green-check save indicator (that one already works well).
- **Where to look:** `frontend/src/components/inline-edit/` — the shared primitive shipped in PR #112. Probably just a CSS / sx prop update.
- **Acceptance criteria:** clicking into any inline-editable field shows an obvious highlighted-active state. Save produces the existing green check.

### P3 — explicitly deferred (do NOT attempt this sprint)

- **Drawer vs modal vs tab UX debate for related-object editing.** JP defended stackable modals; Jac has concerns. Agreed in session: "This is not those edit things. Those edit things are going to be fine. We can change that later." Defer until post-launch.
- **Progress-page "Wins" → "Closed" rename.** JP floated it, Jac pushed back on the semantic overload. Not worth doing this sprint.
- **Pebble integration into Bedrock.** Strategic priority (Nick + Dave aligned), but explicitly after Bedrock launches. JP: "I need, like, another week because we gotta roll out bedrock."

---

## Known gaps vs MVP quality bar (call out to Jac in Monday update)

- 32 pre-existing test failures in `tests/test_projects_endpoints.py` + `tests/test_sf_dependencies.py` + `tests/test_mcp_services.py`. Plan filed at `tasks/remaining-32-test-failures-plan.md`. Not shipping as part of MVP; ship as a follow-up PR.
- Frontend stage-list drift (9 sites). Plan filed at `tasks/stage-list-drift-plan.md`. Substring-match patterns in Overview.tsx / Accounts.tsx / PaymentProcessing.tsx have latent ISA contamination, but not user-facing for philanthropy-only MVP. Blocked in part on Donorbox goal-inclusion product decision.
- RecordType audit across all frontend `getOpportunities()` callers. Parked post-MVP v1. Spec at `tasks/recordtype-audit-post-mvp.md`.
- Accounts endpoint uses `salesforce.query()` not `query_all()`, silently truncates past cap. Follow-up at `tasks/accounts-endpoint-pagination-followup.md`. Low risk for MVP philanthropy scope.

---

## Process notes from Jac (adopt going forward)

- **Every PR should be "I tested this and it's good," not "I built this, help me test it."** Doc-only PRs are the exception Jac granted. Feature PRs require JP to have visually verified the feature before opening.
- **Consider adding Playwright for automated click-through tests.** Jac does this at the factory. Out of scope for this sprint but file for after MVP.
- **Slow down on building-fast, speed up on verifying-well.** Jac: "put yourself in the CEO shoes... like, no, let's work on this tiny thing. Let's work on this tiny thing." JP agreed but wants to hit the Wednesday target first, then adopt this rhythm.

---

## Strategic context (for reference — not action items)

- **Pebble to replace Nick's external tools.** Nick (at Hudson Ferris call 2026-04-16) wants to buy research tools. Dave opposes. JP + Jac aligned: Pebble is a better version of what Nick wants to buy. JP will pitch Pebble after Bedrock MVP launches. JP does NOT want a hackathon-style shortcut — wants to present the work he's already done.
- **Ownership:** JP keeps Pebble as primary author for now. Jac welcome to contribute but JP has the deepest context.
- **Timeline rough target:** Bedrock MVP Wed 2026-04-22, then 1–2 weeks to Pebble pitch-ready.

---

## References

- `tasks/notes-2026-04-17-jac-review.md` — full raw transcript (1h15m)
- `tasks/stage-schema-drift.md`, `tasks/f1-stage-buckets-plan.md` — the stage-buckets work shipped in PR #134–#136
- `tasks/lessons.md` — cross-session lessons, latest 2026-04-16 entries
- PR #139 (merged 2026-04-19) — dev → main rollup containing PRs #104–#138
