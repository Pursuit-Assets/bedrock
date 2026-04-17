# RecordType filtering audit — post-MVP v1 spec

**Status:** DEFERRED. To be executed **after MVP v1 launches** to philanthropic fundraisers. JP direction 2026-04-17.

**Source:** `tasks/stage-schema-drift.md` § "Known pre-existing defects" item 2. This doc is the full spec produced during a four-pass verification session on 2026-04-17 — it preserves the research so a future session can pick it up cold without re-doing the inventory.

---

## 1. Why deferred

MVP v1 = philanthropic fundraisers only. ISA + PBC record-type contamination is not user-facing in that launch scope: philanthropy RMs view philanthropy data, and the incidental leakage on a few surfaces (totals in Progress, "won" buckets in Accounts) doesn't block MVP functionality. Revisit post-launch when other user profiles (Executives, PMs per memory file `project_team_rollout`) come online and cross-type data discipline matters.

## 2. Backend support — already in place (nothing to add)

`financial_forecasting/main.py:305-351` — the `GET /api/salesforce/opportunities` endpoint accepts `record_type: Optional[str]` and interpolates a `RecordType.Name = '{escape_soql_string(record_type)}'` WHERE clause. `financial_forecasting/frontend/src/services/api.ts:87` already declares the param shape. No backend or API-surface work needed.

## 3. 14-caller inventory

All frontend callsites of `apiService.getOpportunities()`, as of 2026-04-17:

| # | File                                                      | Line | Passes `record_type`? |
|---|-----------------------------------------------------------|------|----------------------|
| 1 | `components/Layout.tsx`                                   | 154  | No (prefetch for all users on app mount) |
| 2 | `hooks/useNotifications.ts`                               | 107  | No |
| 3 | `pages/Opportunities/useOpportunityData.ts`               | 63   | **Only** caller that conditionally passes `record_type='Philanthropy'` — only when user toggles `philanthropyOnly` |
| 4 | `pages/Overview.tsx` (Progress / Wall of Progress)         | 95   | No |
| 5 | `pages/PaymentProcessing.tsx`                             | 77   | No |
| 6 | `pages/Accounts.tsx`                                      | 207  | No |
| 7 | `pages/MyDashboard.tsx`                                   | 608  | No |
| 8 | `pages/WeeklyPriorities.tsx`                              | 110  | No |
| 9 | `pages/Leads.tsx`                                         | 72   | No |
| 10 | `pages/Leads.tsx`                                         | 181  | No (duplicate query in same file) |
| 11 | `pages/AutomationReview.tsx`                              | 84   | No |
| 12 | `pages/NetworkMap.tsx`                                    | 85   | No |
| 13 | `pages/DataTools.tsx`                                     | 134  | No |
| 14 | `components/projects/LinkedOpportunities.tsx`             | 34   | No |

## 4. The shared-cache trap

All 13 non-hook callers use the react-query cache key `'opportunities'` (bare string, no params). `Layout.tsx:154` hits it first as a prefetch on every logged-in session, so whichever caller populates first wins. The prefetch is always unfiltered → the shared cache entry is always unfiltered → every downstream consumer sees all Philanthropy + PBC + ISA records, regardless of what that page's fetcher asked for.

**Simply adding `record_type` params without updating cache keys will cause inter-page collisions.** Example: if `Overview.tsx` asks for `record_type='Philanthropy'` while `DataTools.tsx` wants unfiltered, they'd both read/write the same `'opportunities'` cache entry and clobber each other based on mount order.

**Fix pattern:** generalize the `oppQueryKey(philanthropyOnly, pbcOnly)` pattern from `useOpportunityData.ts:24-27` to every caller. Cache key becomes a tuple that includes `record_type` (and any other filter). Callers with different filters land in different cache entries.

## 5. ISA contamination fixed for free

Today, several frontend surfaces use substring-based "is won" matching that silently catches ISA legacy records because `'Collecting'` is a substring of both `'Collecting / In Effect'` (philanthropy, 47 records) and `'In Collection'` (ISA RecordType, 650 records, 2019–2020 Pursuit Bond legacy):

- `Overview.tsx:76` — `CLOSED_WON_STAGES` defensive substring list, includes `'In Collection'` and `'Collecting'`
- `Accounts.tsx:350` and `:623` — `isWon` checks include `.includes('In Collection')`
- `Opportunities.tsx:305` — `.includes('Collecting')` in the `collecting` view filter

Filtering at the API layer via `record_type='Philanthropy'` prevents ISA records from entering the frontend dataset at all. All four substring-ambiguity bugs disappear without touching the substring logic.

## 6. Implementation options

| Option | Approach                                                                                               | Effort | Pros | Cons |
|--------|--------------------------------------------------------------------------------------------------------|--------|------|------|
| **A**  | Per-caller `record_type` param + keyed cache. Each caller opts in; `oppQueryKey()` generalized.         | 4–8 h  | Explicit, preserves cross-type pages.                                                | Needs per-page product call.                            |
| **B**  | Backend default-to-Philanthropy when no `record_type` passed.                                           | ~15 min | One line.                                                                              | Silent semantic shift; breaks DataTools and any future API client.                |
| **C**  | Shared `useOpportunities({recordType})` hook replaces all 14 callsites.                                 | ~2 days | Cleanest long-term; single abstraction.                                                | Biggest diff; harder to review. |

**Recommendation:** start with A. If the refactor surfaces enough per-caller duplication, escalate to C in a follow-up.

## 7. Per-page scope classification — needs product input

Provisional tagging from the 2026-04-17 session. Confirm before execution:

**Philanthropy-only (safe to hard-code `record_type='Philanthropy'`):**
- Overview / Progress (Wall of Progress — Pursuit fundraising surface)
- MyDashboard (RM personal dashboard)
- PaymentProcessing (philanthropy invoice flow)
- WeeklyPriorities (RM weekly review)
- Leads
- AutomationReview (RM review of AI suggestions)
- Layout.tsx prefetch (?? — see Q2 below)

**Cross-type or ambiguous — product call required:**
- Accounts (funders cross all business lines — Philanthropy + PBC + ISA? or just Philanthropy for MVP?)
- NetworkMap (network of contacts/accounts across all business types, likely)
- DataTools (power-user export — needs to see everything for CSV downloads)
- LinkedOpportunities (Projects span business types per `project_sprint9_activities_extension` memory)

## 8. Clarifying questions for the kickoff

Preserved from the 2026-04-17 session for whoever picks this up next:

1. **Page-scope confirmation.** Does the philanthropy-only list in §7 match your current thinking, or has the team profile mix shifted since 2026-04-17?
2. **Layout.tsx prefetch scope.** The prefetch runs for every logged-in user. Scope it to `record_type='Philanthropy'`? Or leave it unfiltered and force each page to do its own filtered refetch?
3. **Accounts page scope.** Funders cross all business lines in the underlying SF data. Is the Accounts UI intended to show all funders, or philanthropy-only?
4. **DataTools export.** Should the CSV/export path include all RecordTypes, or default to philanthropy with an opt-in for other types?
5. **Donorbox goal-inclusion.** Still deferred — whether Donorbox donations count toward `GOAL_STAGES` in Progress (`Overview.tsx:476`) and `GoalTracker.tsx:6` is a separate product call. Not blocking this audit.

## 9. Cross-references

- `tasks/stage-schema-drift.md` — origin of the finding, item 2 in "Known pre-existing defects"
- `tasks/f1-stage-buckets-plan.md` — F1 bucket sets (shipped as PR #134) established the `WON_STAGES` / `LOST_STAGES` / `PAYMENT_RECEIVED_STAGES` vocabulary
- `tasks/accounts-endpoint-pagination-followup.md` — related architectural concern on the accounts endpoint (separate fix)
- Memory file `project_stage_schema_drift` — running status tracker for stage-drift work, will be updated to note this audit is parked post-MVP
