# Bedrock Changes — April 14–15, 2026

Summary of all changes since `CHANGELOG-2026-04-13.md` (`d0902f0`) for JP's review.

**Scope:** 22 merged PRs (#104–#128) + PR #129 open for review. All on `dev`, not yet promoted to `main`.

---

## Themes

1. **Reports / Pipeline / Accounts polish** (#104–111) — small fixes rolled up
2. **Inline-edit foundation + migrations** (#112–115, #118) — new editing primitive replaces per-page edit implementations
3. **Adversarial-review follow-up** (#116) — 16 findings from the review pass
4. **Dashboard → Progress page rebrand + rework** (#119–128) — Wall-of-Progress replaces the old metrics-card dashboard
5. **Pipeline Flow rework** (#129, in review) — Selected Users default + Lookback picker + exact-range AI Analyze

---

## 1. Small fixes

### #104 — Opp tab counts read from full cache
`src/pages/Opportunities/OpportunitiesPage.tsx`. Tab counts (All/Open/Closed) were reading from the stage-filtered subset, so filtering "Open" dropped the "Closed" count to 0. Now derived from the unfiltered cache.

### #105 — Classify `Closed / Completed` as a win on the funnel
`components/pipelineFunnelTransitions.ts`. Transitions to `Closed / Completed` were being bucketed as setbacks because the terminal stage wasn't in the `WON_STAGES` constant. (`Closed Won` remains misclassified — tracked as F1 in `tasks/stage-schema-drift.md`, needs fundraising glossary.)

### #106 — Convert Account/Contact edit to right-side drawer
`components/AccountEditDialog.tsx`, `ContactEditDialog.tsx`. Matches the Opportunity + Task pattern (680px default, 480–900px resize).

### #107 — Calendar expands for events past 8 PM
`components/WeeklyCalendar.tsx`. Hourly grid was hard-capped at 7am–8pm; now extends when events exist outside that range.

### #108 — Meaningful Accounts sort + dash for zero aggregates
`pages/Accounts.tsx`. 0-valued aggregations now render `—` (matches Opportunities). Sort order respects alphabetical fallback when amounts tie.

### #110 — Priorities Alerts column as icon row
`components/PriorityTable.tsx`. Stacked Chips replaced with compact icon row; hover tooltips carry detail. Column width dropped from ~160px to ~30%.

### #111 — Clickable Opportunities topline cards filter the table
`pages/Opportunities/OpportunitiesPage.tsx`. Click on Total / Open / Won cards applies the corresponding filter.

---

## 2. Nav + rename (#109)

`components/Layout.tsx`. "Pipeline" nav item renamed to "Reports" (more accurate — it's the pivot/table view, not the funnel). Nav subtitles added under each primary item. Broken "Intelligence" nav item removed.

---

## 3. Inline-edit foundation + migrations

### #112 — `useInlineEdit` hook + sensitivity-gated primitive
`src/hooks/useInlineEdit.ts`, `components/InlineEditCell.tsx`, plus a per-field `fieldSensitivity` registry. Provides consistent focus-ring, save-on-blur, Enter-to-commit, Escape-to-cancel, optimistic write with rollback, and permission gating.

Introduced **sensitivity tiers** that gate edits behind role checks — low (read/write for any authed user), medium (requires `edit_own_opportunities`), high (admin only). See `src/config/fieldSensitivity.ts`.

### #113 — Reports Opportunities migrate to primitive
`pages/Opportunities/EditCells.tsx`. Stage, Amount, Close Date, Probability columns refactored to `InlineEditCell`. Drops ~150 lines of per-field logic.

### #114 — Projects ListView migrate to primitive
`pages/Projects/ListView.tsx`. Milestone status dropdown + phase pills now use `InlineEditCell`.

### #115 — Priorities migrate to primitive
`components/PriorityTable.tsx`. Stage, Amount, Close Date, Probability columns. (Probability added read-only under `sensitivity=high` while the gate is debated.)

### #118 — Inline-edit affordance polish
`components/InlineEditCell.tsx`. Blue ring on click + hover hint text. Addresses "users didn't realize these cells were editable" feedback from adversarial review.

---

## 4. Adversarial review follow-up (#116)

16 fixes rolled into one PR from the Mar 2026 adversarial-review pass. Highlights:

- **C2, C3, C4** — Sensitivity-gate enforcement corrected on 3 field paths (Amount, Stage, Probability)
- **H1–H7** — seven smaller hardening items (permission propagation, cache key parity, rename cleanup)
- **M1 partial** — `WON_STAGES` / `LOST_STAGES` lifted from `pipelineFunnelTransitions.ts` into `types/salesforce.ts` (prep for F1, values unchanged)
- **M2, M3, M5** — misc cleanup

See commit message for the full findings list. Remaining open findings (B1, B2, B3, F1, F2, F3) are documented in `tasks/stage-schema-drift.md` and are gated on the fundraising-team glossary conversation.

### #124 — C1 Probability sensitivity gate (last open adversarial finding)
`components/PriorityTable.tsx`, `pages/Opportunities/EditCells.tsx`. Probability is now read-only for non-admins; admins can edit inline (which overrides SF's stage-derived default).

---

## 5. Dashboard → Progress page rebrand + rework

Major rebrand. Old "Dashboard" (metric cards + cashflow charts + quarterly projections) was replaced by "Progress" — a Wall-of-Progress view centered on revenue targets and per-owner pipeline health.

### #119 — Nav rename Dashboard → Progress + tighter header
`components/Layout.tsx`, `pages/Overview.tsx`. `Overview.tsx` was renamed in export (`Progress: React.FC`) while keeping the file name for import stability. Route stays `/dashboard` (alias kept to avoid breaking bookmarks).

### #120 — Individual Progress defaults to all active users
`pages/Overview.tsx`. Pre-#120, the list only showed users with goals set. Now shows all `activeUsers`, with a "Target not set" placeholder for those missing goals.

### #121 — Progress Visibility Settings override
`pages/Settings.tsx` → "Progress Visibility" tab. Admin-only toggle (one row per SF user) that controls whether a user appears on the Progress page. Backed by `bedrock.progress_tracked_override` table (`db/migrations/2026-04-15-add-progress-tracked-override.sql` — **NOT YET APPLIED ON PROD**). Untoggled users default to tracked (visible). Bedrock-managed so bots / ex-employees can be hidden without SF changes.

### #122, #123 — Subheader naming
Pipeline → Current FY Progress Overview → "Current FY Overview" + "Individual Goals & Pipelines". Shorter and clearer.

### #125 — Progress page polish
`pages/Overview.tsx`. De-emphasize untargeted rows (opacity 0.55), tighter timestamp formatting, team-total row at the top of the Individual Goals table.

### #127 — Individual Goals & Pipelines filter to targeted users with opps
`pages/Overview.tsx`. Replaced `{ownerGoals}`-keyed list with the `ownerProgress` memo. Filter: `activeUsers ∩ ownerIdsWithOpps ∩ goalHoldersWithAmount` ("active + has-opps + has-target"). Added `missingTargetCount` caption under the section header so admins see the gap.

### #128 — Individual Goals filter edge cases (bypass + $0-goal)
`pages/Overview.tsx`. Two bugs: (a) a user with `goal_amount = 0` saved from the Targets dialog was rendering a ghost row (admitted by filter, blank in display); (b) the filter bypassed when `hasTarget` was `undefined` during the first render. Normalized through a single `goalHoldersWithAmount` memo.

---

## 6. Pipeline Flow rework (PR #129, open)

Three tightly-coupled changes to the Pipeline Flow card on the Progress page.

### LookbackRangeSelector (new component)
`components/LookbackRangeSelector.tsx`. Sibling to `DateRangeSelector`. Backward-looking presets (Last 7/30/60/90 days + custom range). UTC-consistent range resolution — matches SF's `LAST_N_DAYS:n` semantic so client-side filtering agrees with server fetch across timezones. Exports `lookbackToDays`, `resolveLookbackRange`, `formatLookbackLabel`.

### Pipeline Flow swap (`PipelineFunnel.tsx`)
7d/30d/90d ToggleButtonGroup replaced by `<LookbackRangeSelector>`. Added `parseISO`-based client-side CreatedDate filter for custom ranges (handles SF's `+0000` vs `Z` suffix mismatch). Copy updated from `${days}d` to rangeLabel (`"in the last 30 days"` / `"between Oct 1 and Nov 1, 2025"`).

### Selected Users default + OwnerSelector row (`Overview.tsx`)
`selectedOwnerIds` now seeds from `ownerProgress.sfIds ∩ availableOpenOwners` on first load (localStorage-persisted selection takes precedence on subsequent loads). Rendered `<OwnerSelector>` as a dedicated row above the funnel card — full-width Autocomplete with chips, matches the pre-`bdb030d` UX. Empty-state banner explains "showing everyone with open pipeline — set targets above to filter" when `ownerProgress` is empty. Init waits for all three upstream queries (opps, progress-users, goals) before seeding to avoid false-empty race.

### Exact-range AI Analyze (`routes/ai.py` + `services/api.ts`)
`POST /api/ai/pipeline-analysis` now accepts optional `start`/`end` (YYYY-MM-DD, mutually exclusive with `days`, bounded to last 365 days). Strict regex + `strptime` validation; SOQL uses `CreatedDate >= startT00:00:00Z AND <= endT23:59:59Z` with no escaping needed (regex rejects all SOQL-breaking chars). Response adds nullable `start`/`end`; `days`-only callers unchanged. 11 new backend tests cover SOQL shape, mutual exclusion, bounds, parametrized injection attempts, backward compat. AI now sees **exactly** the window + owner subset on screen — no superset compromise.

Plan: `~/.claude/plans/foamy-sprouting-lovelace.md`.

---

## Deferred / Open

- **F1 / F2 / F3 (stage schema drift)** — documented in `tasks/stage-schema-drift.md`. Gated on fundraising-team glossary conversation. Primary risks: B2 (Intacct auto-invoice skips 77% of won opps) is real-but-tolerable until glossary lands; B1 fixed partially in #105 for `Closed / Completed`, still wrong for the 575 `Closed Won` legacy records and the ~30 PBC success variants.
- **Prod migration for `progress_tracked_override`** (#121) — applied on local dev only, not yet on prod. Apply before dev → main promotion.
- **dev → main promotion** — not yet. PR #126 (dev → main) was opened 2026-04-14, closed intentionally. 28 commits accumulated on dev, deliberate batching for one larger promotion PR.
- **11 pre-existing frontend test failures** — 4 buckets (timezone assertions, impl drift, removed auth fallback, timeout). All reproduce on unmodified dev; not caused by any of the above work. Cleanup tracked separately.

---

## Commits

### Merged to dev (#104–#128)

| Hash | Message |
|------|---------|
| `1f809ef` | fix: Individual Goals filter — bypass + $0-goal edge cases (#128) |
| `8428035` | fix: Individual Goals & Pipelines — filter to targeted users with opps (#127) |
| `e4bc3bd` | fix: Progress page polish — de-emphasize untargeted rows (#125) |
| `19576f5` | fix: C1 — Probability column sensitivity gate (#124) |
| `3f958f5` | fix: simpler subheaders on Progress page (#123) |
| `7078092` | fix: rename Progress page subheader (#122) |
| `deee4f7` | feat: Progress page visibility override (#121) |
| `30e1415` | feat: Progress page — Individual Progress defaults to all active users (#120) |
| `60d18a3` | feat: rename Dashboard → Progress in nav (#119) |
| `149fa8c` | fix: clearer inline-edit affordance (#118) |
| `feeb4f5` | fix: adversarial review followups (#116) |
| `f24ad7d` | feat: Priorities migration — inline-edit (#115) |
| `7a84cb3` | feat: Projects ListView inline-edit adoption (#114) |
| `163fb2c` | feat: Reports Opportunities inline-edit migration (#113) |
| `c4b5339` | feat: inline-edit foundation (#112) |
| `6bf0674` | fix: clickable Opportunities topline cards (#111) |
| `36b2f54` | feat: rename Pipeline→Reports + nav subtitles (#109) |
| `c3f6dd6` | fix: Priorities Alerts column icon row (#110) |
| `e0a7340` | fix: meaningful Accounts sort (#108) |
| `23ff584` | fix: calendar expands dynamically (#107) |
| `e146a90` | fix: Account/Contact edit right-side drawer (#106) |
| `801597d` | fix: classify Closed / Completed as a win (#105) |
| `eb9fbf1` | fix: opp tab counts read from full cache (#104) |

### Open for review (PR #129)

| Hash | Message |
|------|---------|
| `3f148d2` | feat: Progress — Pipeline Flow default to Individual Goals users, add OwnerSelector |
| `002dd2b` | feat: Pipeline Flow — Lookback picker + exact-range Analyze wiring |
| `cecf8aa` | feat: /api/ai/pipeline-analysis — accept optional start/end date range |
| `acf81ae` | feat: LookbackRangeSelector — backward-range date picker for Progress page |
