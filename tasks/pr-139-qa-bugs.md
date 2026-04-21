# PR #139 — QA Bug Reports

Testing local build of `bedrock/dev` at commit `54ab8c2` (PR #139 head). Captured
during Jacqueline's hands-on QA session.

---

## URGENT — Auth bugs found during setup (backend)

### BUG-AUTH-1: Salesforce token refresh doesn't persist to cookie
**Severity:** P0 — prod-facing. Users hit this ~2 hours after connecting.
**Location:** `financial_forecasting/routes/auth.py` → `salesforce_status` (lines 406–451)
**Symptom:** UI shows "Connected ✓" but every `/api/salesforce/*` call returns 500.
**Root cause:** `/auth/salesforce/status` calls `_refresh_sf_token(refresh_token)` when the
current access token is expired, but only returns the fresh tokens to the frontend — it
never writes them back to the `sf_tokens` cookie. So the cookie keeps serving the dead
access token to every other endpoint.
**Fix:** On refresh, re-encrypt and `response.set_cookie("sf_tokens", ...)` with the new
tokens before returning.

### BUG-AUTH-2: Backend caches broken Salesforce client in memory
**Severity:** P0 — users can't recover without a backend restart.
**Location:** `financial_forecasting/dependencies.py` → `get_mcp_client` (lines 26–74)
**Symptom:** Once the SF access token expires mid-session, every subsequent request 500s
and never recovers, even after the user disconnects + reconnects Salesforce in the UI.
**Root cause:** The per-user OAuth fallback path attaches the SF service to the shared
`UnifiedMCPClient` singleton and appends `"salesforce"` to `_connected_services`. On the
next request, the guard `if "salesforce" in client.connected_services: return client`
short-circuits and returns the stale broken service. The per-user cookie path never runs
again.
**Fix options:**
- Don't mutate the shared singleton; build a per-request SF service wrapper.
- Validate `svc._authenticated` + session liveness before returning the cached client.
- On session-expired error, remove the stale service from the singleton so the next
  request re-runs the cookie flow.

---

## PR #139 QA — new bugs

### BUG-UI-1: Progress page "Wins" rows don't link to the opportunity
**Severity:** P1 — blocks the core workflow of reviewing someone's wins.
**Location:** Progress page → owner row expansion → "Wins (N) — $X" list.
**Repro:**
1. Go to Progress page.
2. Expand any owner (e.g. "Devika Gopal Agge").
3. Click any opp row in the Wins list (e.g. "FY26 — Palo Alto Networks Philanthro…").
**Expected:** Opens the Opportunity edit drawer on the right, same as clicking an opp
from the Opportunities/Reports tables.
**Actual:** Rows are not clickable — pure text display.
**Evidence:** Screenshot (Wins expansion showing 8 opps).
**Fix:** Wrap each row in the same click handler used by Opportunities/Reports tables.
Apply to setbacks list too.

### BUG-UI-2: "Type" field not populating on Edit Opportunity drawer
**Severity:** P1 — required SF field can't be edited.
**Location:** Edit Opportunity drawer → Details tab → Type dropdown.
**Repro:**
1. Open any opportunity (e.g. FY26 — Mercor — Cash for Data — $60k).
2. Look at the Type field.
**Expected:** Current value from Salesforce prefilled; dropdown shows SF Type picklist
values when opened.
**Actual:** Field is blank; unclear whether dropdown has options.
**Evidence:** Screenshot (Edit Opportunity drawer — Mercor).
**Investigation needed:** Is the backend returning `Type` on the opportunity payload?
Is the dropdown bound to SF picklist metadata? Could be a fetch bug or a render bug.

### BUG-UI-3: Stage dropdown missing "Closed Lost" / "Withdrawn"
**Severity:** P1 — can't mark deals as lost/withdrawn from Bedrock.
**Location:** Edit Opportunity drawer → Stage dropdown.
**Expected:** All active SF Opportunity stages surfaced, including negative closures
(Closed Lost, Withdrawn, Closed No Sale — whatever the SF picklist actually contains).
**Actual:** Negative-closure stages not in the dropdown (needs confirmation by scrolling
the full list).
**Fix:** Audit `OPPORTUNITY_STAGES` in `frontend/src/types/salesforce.ts` against the
live SF Opportunity StageName picklist. #139 already widened this for Closed Won /
Closed Completed — this is the same pattern on the negative side.

### BUG-UI-4: Reports inline edit popup opens in top-left corner, not near the cell
**Severity:** P1 — inline edit is unusable even when it works.
**Location:** Reports page → any tab → click a cell.
**Repro:**
1. Open Reports.
2. Click a cell (e.g. Funder/Account on any opp row).
**Expected:** Edit popup/autocomplete anchored directly below the clicked cell.
**Actual:** Popup renders in the top-left corner of the viewport, far from the cell.
**Evidence:** Screenshot (Reports page — clicking Funder/Account on Ascendium
Philanthropy opp, popup floating in top-left near the "Reports" title).
**Root cause likely:** Missing or wrong anchor ref in the inline-edit primitive;
probably defaulting to (0,0) when portal positioning fails.
**Fix:** Pass the cell's DOM ref as the popup anchor, or use floating-ui to position
relative to the click target.

### BUG-UI-5: Inline "Add Task" — no description field + fails to save to Salesforce
**Severity:** P1 — task creation is broken.
**Location:** Anywhere that offers inline task creation (likely Reports/Opportunities
row → "Tasks" link).
**Repro:**
1. Click "Tasks" on an opportunity row.
2. Try to create a new task inline.
**Expected:** Title + Description + due date, saves to Salesforce Task object.
**Actual:** No description field in the inline form; save fails silently (no SF Task
created).
**Investigation needed:** Tail backend logs during save — is the POST to
`/api/salesforce/tasks` returning 4xx/5xx? Missing required field? Wrong endpoint?
**Fix:** Add description textarea; confirm payload maps to SF Task fields correctly.

### BUG-UI-11: Activities tab — sync & AI Insights not aligned with other fields
**Severity:** P2 — UX polish, visual inconsistency.
**Location:** Edit Opportunity drawer → Activities tab.
**Symptom:** Sync row and AI Insights row break out of the column grid used by
the other fields, so they feel like they belong to a different layout.
**Fix:** Wrap them in the same `<Box>` / grid used by the fields tab so they
share the same horizontal alignment and spacing.

### BUG-UI-10: Priority Opportunities column headers don't align with data cells
**Severity:** P2 — visual polish; chips/numbers are slightly off from their
column headers (Stage, Amount, Close, Prob, Alerts, Tasks).
**Location:** Priorities page → GET PRIORITIZED → Priority Opportunities table.
**Investigation needed:** Check whether the table is using DataGrid or a
hand-rolled grid; header spec may use different padding from the row template.
**Fix:** Unify header + row cell widths/padding in a single schema; likely
either centre-align numeric columns or left-align all of them to match.

### BUG-UI-9: Type dropdown in Edit Opportunity drawer bound to wrong SF field
**Severity:** P1 — data-integrity / RM workflow bug. Looks correct but edits
the wrong picklist.
**Location:** `financial_forecasting/frontend/src/components/OpportunityEditDialog.tsx`
(lines 107–109, 507–534) + `frontend/src/hooks/useOpportunityTypePicklist.ts`
**Symptom:** The "Type" dropdown shows SF `Opportunity.Type` values
(`None / New / Renewal or Repeat Business`) but our team's mental model of
"Type" is **RecordType** (`Philanthropy / Enterprise / AIJI / …`) — which is
already shown read-only at the bottom of the drawer as
"Record Type: Philanthropy".
**Fix:**
1. Rename the dropdown to source from `Opportunity.RecordTypeId` / 
   `RecordType.Name` instead of `Opportunity.Type`.
2. Load record-type options via SF describe + `recordTypeInfos` (filter to
   `available=true, defaultRecordTypeMapping=false`).
3. Remove the redundant "Record Type: …" line at the bottom of the drawer.
4. If `Opportunity.Type` still has product value (Renewal vs New, for
   forecasting/capacity), keep it but move it to Details with a clearer
   label like "Renewal Status."
**Not on JP's plan.**

### BUG-UI-7: Revenue Snapshot uses $2M placeholder instead of user's actual target
**Severity:** P1 — top-of-page revenue target is wrong for every view where
the owner doesn't have a goal configured.
**Location:** `financial_forecasting/frontend/src/pages/Priorities.tsx:1383`
(Revenue Snapshot section → `<GoalTracker goalAmount=... />`)
**Root cause:** Current binding is
`ownerGoals[resolvedFilterId]?.goal_amount ?? DEFAULT_GOAL`
where `DEFAULT_GOAL = 2_000_000` (`frontend/src/config/goals.ts:6`). The
fallback fires any time the owner has no row in `bedrock.owner_goal` for the
current fiscal year — and always fires for the "All Pipeline" (team) view
since `ownerGoals['all']` is never set.
**Expected behavior** (per Jacqueline, 2026-04-20):
- Use the user's target from **Settings → Targets** (which writes to
  `bedrock.owner_goal`).
- **If they have no target, the entire Revenue Snapshot section should not
  appear.** No placeholder, no $2M, no "Set goal" CTA — just hidden.
- For "All Pipeline" team view: also hide the section (there is no
  aggregated team target — see future work).
**Fix:**
1. Remove `DEFAULT_GOAL` fallback at `Priorities.tsx:1383`.
2. Wrap the entire `<Section id="revenue">` block in a conditional:
   `if (resolvedFilterId === 'all' || !ownerGoals[resolvedFilterId]) return null;`
3. Consider deleting `DEFAULT_GOAL` and `config/goals.ts` once all callers
   are updated (grep first — other pages may use it).
**Not on JP's plan** (objects-production-readiness-plan.md).

### BUG-UI-6: Side panel "Add Task" doesn't save the title to Salesforce
**Severity:** P1 — task creation is broken from the drawer too.
**Location:** Opportunity/Account/Contact right-side drawer → Activities tab → Add Task.
**Repro:**
1. Open an opportunity in the drawer.
2. Click Activities → Add Task.
3. Fill in title, save.
**Expected:** Task appears in SF Task object with the given Subject.
**Actual:** Task creates but Subject/title is blank in Salesforce.
**Investigation needed:** Check the POST payload — is the `subject` field being sent
under the wrong key? Frontend form field name not matching the API field?
**Fix:** Audit the add-task payload mapping between form state and API/SF field.

---

## New bugs filed 2026-04-20 (post BUG-UI-10)

- **BUG-UI-12 — Notifications panel has horizontal scroll** ✅ FIXED (2026-04-20)
  Three-layer fix in `NotificationDropdown.tsx`:
  (1) Added `overflowX: 'hidden'` to the Popover paper so nothing can force the fixed 380px panel wider.
  (2) Capped the two expanded-state Chips (`close-date-warning`, `permission-request`) with `maxWidth: '100%'` + an inner `.MuiChip-label` ellipsis override so a long label no longer pushes its row out.
  (3) Changed the collapsed-row subtitle `Typography variant="caption"` from its default inline `<span>` to `component="div"` so `noWrap` has a block width to constrain — without this, subtitles clipped at the panel edge without showing "...". Titles and subtitles now truncate with a visible ellipsis.

- **BUG-UI-13 — Notifications panel has no intuitive way to mark items as read** ✅ FIXED (2026-04-20)
  Added a persistent "Mark as read" `IconButton` (`CheckCircleIcon`, size 16) to the collapsed row's right-side cluster — rendered for unread items only (`n.isNew`). Uses `stopPropagation` so it marks just that single notification as read without toggling the row's expand state or firing the row's `handleToggle` click. Tooltip + hover colour-shift to `primary.main` for affordance. The existing "Mark as read" inside the expanded state is kept as-is for users who discover it there.

- **BUG-UI-14 — Global search bar placeholder is cryptic** ✅ FIXED (2026-04-20)
  `placeholder="Search / Quick loads cache / Pulls all"` → `placeholder="Search Salesforce"` in `GlobalSearch.tsx`. The former leaked internal caching semantics (local-cache vs SOQL fallback) into the placeholder. User-facing copy now describes what the feature does, not how it's implemented. Internal code comments about the two-tier cache-first architecture are preserved.

- **BUG-UI-15 — Remove "10 active SF users lack a target" banner** ✅ FIXED (2026-04-20)
  Removed the caption block under the "Individual Goals & Pipelines" heading in `Progress.tsx`, plus the `missingTargetCount` `useMemo` that fed it (now dead code) and the stale reference to it in the `ownerIdsWithOpps` preamble comment. Users missing a target are simply omitted from the targets table — no banner pointing at an unshipped Bulk Edit page.

- **BUG-UI-16 — Close column on Priorities table should show year** ✅ FIXED (2026-04-20)
  `displayFormat="MMM d"` → `displayFormat="MMM d, ''yy"` in `PriorityTable.tsx` so rows spanning FY boundaries (e.g. Dec 31 could be current or next FY) are unambiguous. 2-digit year with apostrophe (`Jun 30, '25`) keeps the column compact; no width change needed.

- **BUG-UI-17 — Rank pip uses undocumented semantic colors** ✅ FIXED (2026-04-20)
  The rank circle in the Priorities table was encoding urgency with four different colors and no legend: `#e65100` (overdue tasks), `#2e7d32` (closing in / renewal / upsell), `#1565c0` (any other urgency reason), `grey.200` (none). That information is already surfaced explicitly in the Alerts column, so the rank pip was redundant at best and cryptic at worst. Unified to a single `primary.main` fill — it's now a neutral ordinal marker only.

- **BUG-NOTIF-1 — Mark-as-read state doesn't survive page refresh** ✅ FIXED (2026-04-20)
  Root cause: `useNotifications.ts` had a "prune stale readIds" step that ran on every `notifications` memo recompute. On first render, React Query's `opportunities` + `ownership-history` queries were still in-flight, so `currentIds` was an empty `Set`. The prune filtered `readIds` against the empty set → `pruned = []`, and because `pruned.length !== readIds.length`, a `queueMicrotask` fired `setNotifState({ readIds: [] })` + `writeState(...)`, wiping localStorage before queries finished. When data finally arrived, every notification was `isNew: true` again.
  Fix: gated the prune behind `oppsData && ownershipData` so it only runs once data is actually loaded.
  Verified: marked KKR notification as read, badge went 5→4, did a hard refresh, badge stayed at 4 and KKR still renders without its Mark-as-read button.

- **BUG-NOTIF-2 — Duplicate notifications in the panel** ✅ FIXED (2026-04-20)
  Root cause: Salesforce's `OpportunityFieldHistory` query returned multiple rows for the same opp when a bulk reassignment produced multiple history entries with identical `CreatedDate`s. The frontend id scheme `ownership-{dir}:{oppId}:{createdDate}` collided and React's duplicate-key warnings fired; the panel rendered each row twice.
  Fix: dedupe by computed id in the frontend before sort/slice (keep first occurrence). Backend SOQL left alone since legitimate multi-change sequences may want distinct entries later.
  Verified: panel previously showed 12 entries (6 pairs); now shows 6 unique entries.

- **BUG-SEARCH-1 — Recent-searches popover reopens over the Edit drawer after selecting a result** ✅ FIXED (2026-04-20)
  Root cause: `handleResultClick` in `GlobalSearch.tsx` called `handleClear()` + `handleClose()` + `onOpenOpportunity(...)`. The drawer opens, MUI's Modal focus-trap briefly pops focus back to the document, focus lands on the still-focused search input, `onFocus={(e) => handleOpen(...)}` fires, popover reopens. Since `handleClear` zeroed the query, `showHistory = popoverOpen && query.length === 0` was true → RECENT SEARCHES rendered floating over the drawer.
  Fix: `inputRef.current?.blur()` inside both `handleResultClick` and `handleViewInPipeline` before the downstream open handler fires, matching the Escape path.
  Verified: searched "yield", clicked the Yield Giving opp result, drawer opened cleanly with no RECENT SEARCHES popover overlaying it.

- **BUG-UI-18 — Progress bar percentage text unreadable mid-range** ✅ FIXED (2026-04-20)
  Devika's 47% row rendered white text on a bar that only filled to 47% — the label (centered at `left: 50%`) sat past the fill edge on the light-grey unfilled track, making it invisible. Root cause: the text color threshold was `pct > 0.35`, which flipped to white as soon as the bar reached 35% even though the label center lives at the 50% mark. Raised threshold to `0.55` on both the Team total row and per-owner rows in `Progress.tsx` so white only kicks in once the fill clearly passes the label position. Light-grey unfilled tracks continue to render dark text, which stays readable.

- **BUG-UI-20 — "Stale Deals" card count doesn't match the filtered table count** ✅ FIXED 2026-04-21
  Unified all three "stale" predicates on the card's definition (`LastModifiedDate > 30d`). Removed the `isPastDue` OR leg and `CloseDate required` AND leg from the click-through filter; removed the `CreatedDate` fallback from both the click-through and the filter-bar `staleOnly` toggle. Card count = click-through count = filter-bar count, all three.
  Location: Opportunities page → topline cards → "Stale Deals" (388) → click card → table filters to 473 rows.
  Root cause: three different definitions of "stale" on the same page.
  1. Card count (`SummaryCards.tsx:67-69`): `opps.filter(o => o.LastModifiedDate && differenceInDays(today, parseISO(o.LastModifiedDate)) > 30)`
  2. Click-through filter (`Opportunities.tsx:390-397`, `initialFilter === 'stale'`): `opp.CloseDate && (isPastDue OR differenceInDays(now, LastMod ?? CreatedDate) > 30)` — adds `isPastDue` (past-due-by-CloseDate) as an OR leg, falls back to CreatedDate, and requires CloseDate exist.
  3. Filter bar `staleOnly` toggle (`Opportunities.tsx:366-373`): `differenceInDays(now, LastMod ?? CreatedDate) > 30` — no past-due leg.
  The card label *"No activity 30+ days"* describes only definition 1, so the card is right; the filter is wrong to include `isPastDue`.
  Fix: unify all three on the card's predicate (`LastModifiedDate > 30d`). If "overdue" (past CloseDate) is a concept we want to surface, give it its own card/chip — don't fold it into stale.
  Not on JP's plan. Filed by Jac 2026-04-21.

- **BUG-UI-19 — Remove Progress Page Visibility concept entirely** ✅ FRONTEND DONE 2026-04-21 (backend orphaned)
  Removed the Settings → Progress Visibility tab, removed all frontend reads of the `is_tracked` flag (Progress.tsx now uses `apiService.getUsers()` directly and filters on `IsActive` only), and removed the two `apiService` methods (`getProgressTrackedUsers`, `setProgressTrackedOverride`). Backend routes (`/api/progress-tracking/*`) and the `bedrock.progress_tracked_override` table are left orphaned — to be pruned in a follow-up once we confirm no external caller depends on them.
  Location: Settings → "Progress Page Visibility" panel (currently toggles per-SF-user visibility on the Progress page individual table).
  Why remove: redundant gating layer. Whether a user is shown on Progress is already determined by (1) active status in Salesforce and (2) whether they have a target set in Settings → Targets. Service accounts (Slackbot, Integration User, Data.com Clean, Chatter Expert, Automated Process, etc.) naturally filter out via target configuration. The per-user Visible toggle adds a third hidden source of truth users have to maintain.
  Scope: this is a full-feature delete, not a UI hide. Needs:
  - Frontend: remove the "Progress Page Visibility" card from Settings, remove any `progress_visible` / `progress_hidden` flag reads from Progress.tsx filtering logic.
  - Backend: remove the storage (likely a `bedrock.progress_visibility` or similar table) and its endpoints.
  - Migration: drop the table/column if used.
  Filed by Jac 2026-04-20.

- **BUG-DATA-1 — Accounts not rendering in Opportunities grid / Reports tables / Edit drawer** ✅ FIXED (2026-04-20)
  Root cause: the frontend had two different rendering paths for the same opp.Account data. `PriorityTable` reads `opp.Account?.Name` directly from the SOQL join (always accurate). `AccountCell` (used by the Opportunities grid, Reports tables) and the Edit drawer's `<Autocomplete>` both ignored the joined name and instead looked up `AccountId` in the bulk `/api/salesforce/accounts` list — which is capped at 2000 rows with `ORDER BY Name ASC`, so any opp whose account sorts after the 2000th rendered as "No Account" or an empty dropdown.
  Fix: threaded the opp's joined `Account.Name` as an authoritative display label. In `AccountCell`, added a `displayName` prop that takes priority over the accounts-list lookup. In `OpportunityEditDialog`, synthesized `selectedAccount` from `originalOpp.Account.Name` when the id isn't in the loaded list, and injected that synthesized option into the Autocomplete's `options` array so MUI doesn't warn and the item renders in the listbox.
  **This decouples display from JP's PR #149** — even when JP lands the `query_all()` pagination fix for the accounts list, this change keeps display correct regardless of how many accounts Pursuit accumulates. (PR #149 still matters for the edit picklist — if the user wants to _reassign_ to an account that sorts after the 2000th, it won't appear in the options until #149 ships.)

## Still-unfixed feedback from PR #126 (re-confirm)

Copying from prior PR #126 QA comment — worth re-verifying under #139:

- [ ] Accounts sort Z→A still only sorts first 500 (not full list) — **covered by JP's PR #149 `pr-contacts-accounts-pagination` (⏳ Queued as of 2026-04-20). Backend still uses `query()` + `le=2000` cap; the fix is switching to `query_all()`. Not shipped yet.**
- [ ] Reports → unlock dialog appears but inline edit still fails after unlock
- [ ] Opportunities topline cards show 577, table shows 568 (count mismatch)
- [ ] Settings → Progress Visibility panel still present (tracked as **BUG-UI-19** above — full feature delete, not just UI hide)
- [ ] Duplicate second header on every page (app-wide)
- [ ] "Reports" page title — is this the right name?
- [ ] Account/Contact drawer styling still doesn't match other side panels

---

## Test plan progress

- [x] Environment set up (migration applied, backend + frontend running)
- [x] Initial smoke test — Progress page + Edit Opp drawer + Reports inline edit
- [ ] Funnel → Closed Won / Closed Completed counted as Win (P0 of #139)
- [ ] Overview forecast numbers populate correctly
- [ ] Pipeline Flow rework visual check
- [ ] Individual Goals & Pipelines filters to targeted users only (#127 claim)
- [ ] Calendar past-8pm rendering (was PASS in #126, regression check)
- [ ] Manual sync trigger runs without error
