# Bedrock UI Improvements

> Cleaned from JP's idea dump (3/17/2026). Strikethrough items removed (already shipped). Verified against current codebase state 2026-03-25.

---

## Small (1 PR each, no planning needed)

### S1. Stage colors in Pipeline page tables
Priorities page already has the correct stage color scheme. Pipeline page tables (Opportunities, Accounts, Contacts, Leads) render stage names as plain uncolored Chips. Apply the same `getStageHexColor` coloring from Priorities to Pipeline's table views. Do NOT change Priorities page colors.
- **Files**: Pipeline sub-page components

### S2. Stage selector: ordered + ROYGBIV progression
Stage filter currently shows stages in random order. Show them in pipeline order (Lead Gen -> New Lead -> Qualifying -> ... -> Collecting). Update colors to progress ROYGBIV: red for New Leads, through orange/yellow/green, to indigo/purple for Collecting and completed stages.
- **Files**: `PriorityTable.tsx`, stage color utility

### S3. Dashboard icon swap + Pipeline rename discussion
Change Dashboard nav icon to the current Pipeline icon (upward arrow — fits revenue/cashflow). Rethink Pipeline: this page shows all records in grid view with filtering. Consider renaming to "Reports" or keeping "Pipeline" with a new icon that suggests spreadsheet/grid view.
- **Files**: `Layout.tsx` (nav icons)
- **Decision**: Is Pipeline becoming Reports? What icon?

### S4. Dashboard dead space tightening
Tighten whitespace on Dashboard page. Quarterly view has the most wasted space. Move "View Details" to a small button on the right side of each row. Hero cards can stay larger but quarterly cards should be compact and fit on one row.
- **Files**: `MyDashboard.tsx`, related card components

### S5. Pebble output metadata
Add to every Pebble research output: cost, number of agents that ran, quick log of work done. Make scratchpad viewable via click-through on the detailed log. (Partially addressed in Sprint 13 UX polish — cost display + failed agents. This extends it with full agent log.)
- **Files**: `Pebble.tsx`, research result display components

### S6. Favicon PNG assets (deferred from PR 10)
PR 10 shipped the custom Bedrock mountain+city SVG in sidebar + `manifest.json` name update, but left favicon PNGs missing. Browser tab shows default Vite icon.
- **Files**: `financial_forecasting/frontend/public/favicon.ico` (16x16 + 32x32), `financial_forecasting/frontend/public/logo192.png`, `financial_forecasting/frontend/public/logo512.png` (optional)
- **Source**: `BedrockLogo.tsx` SVG — render at target sizes and export.

---

## Medium (own branch + PR, brief plan-mode pass)

### M1. Total vs Weighted toggle bug
Toggle exists and works, but ranking changes when switching between 5/10/25/50 page size. The weighting should consider ALL opportunities matching the filter, then rank — so Priority 1-5 stay the same regardless of how many rows display. Likely a frontend sorting issue where weighting is applied after pagination instead of before.
- **Verify**: Is the weighted sort applied to the full dataset before slicing to page size, or after?
- **Files**: `PriorityTable.tsx`, `MyDashboard.tsx`

### M2. Inline editing in Pipeline
Inline editing is missing from Pipeline page. Was it lost in the architecture migration from simple_server.py, or was it never built for this page? PriorityTable has `EditableCell` — may be reusable. Pipeline currently uses sub-page tabs (Opportunities, Accounts, Contacts, Leads) with read-only tables.
- **Verify**: Did inline editing exist in simple_server.py's frontend? Check git history.
- **Files**: `Pipeline.tsx` and its sub-pages

### M3. Notifications overhaul
Current NotificationDropdown shows overdue/due-today task counts and lists up to 8 items. User reports it's not useful — "shows all Tasks with no info and just redirects to Task inbox." Needs: better grouping, recency indicators, actionable info per notification, distinct from Task Inbox.
- **Decision**: What should notifications show that the Task Inbox doesn't? Suggestions: stage changes, new tasks assigned to you, overdue escalation, upcoming close dates.
- **Files**: `NotificationDropdown.tsx`, possibly new backend endpoint

### M4. Tasks showing tagged Contacts
Tasks in SF can have related Contacts (via WhoId or TaskRelation). Surface the Contact name in the Task Inbox view so users can see who the task involves (e.g., "Send renewal proposal" -> "Sarah Chen, Goldman Sachs Foundation").
- **Verify**: Does current SOQL for tasks fetch WhoId / Who.Name?
- **Files**: `PriorityTable.tsx` (task display), backend task query

### M5. Personal GCal toggle + privacy
Add ability to toggle personal Google Calendar on/off in Calendar view. Privacy constraint: only the logged-in user should see their own Gmail, GCal, and private Slacks. Not even admins. Consider: Pebble could use full calendar access for accountability insights (with user consent).
- **Decision**: Should this be a user preference or a per-session toggle? How does Pebble access fit with privacy?
- **Files**: `MyDashboard.tsx` (calendar section), `routes/auth.py` (scopes)

### M6. AIJI filter on Priorities page
Filter Priority Opportunities to show only AIJI-related opportunities. Check if Salesforce Campaign field + Opportunity name combo can identify these. May need a simple regex or Campaign membership query.
- **Verify**: Does Salesforce data have Campaign associations or naming conventions that identify AIJI?
- **Files**: `PriorityTable.tsx`, possibly backend filter endpoint

### M7. AIJI tracker update in Projects
Replace Projects page content with Johnny's latest AIJI tracker data. Update the local project/workstream/milestone/task database — don't touch Salesforce. The data import path is the existing Projects API.
- **Requires**: The AIJI tracker file/spreadsheet from Johnny
- **Files**: `db/seed.sql` or a data import script, Projects page components

### M8. Calendar meeting overlap detection (deferred from PR 5)
PR 5 shipped the time-axis hourly grid + all-day row + current-time indicator, but overlap detection was deferred. Currently overlapping events stack vertically instead of rendering side-by-side like GCal.
- **Files**: `WeeklyCalendar.tsx` — layout algorithm to detect overlapping intervals per day, compute column width + horizontal offset, render blocks with CSS `left`/`width`.
- **Why**: Matches GCal behavior; avoids visual confusion when two meetings run in the same time slot.

### M9. Task Inbox backend persistence (deferred from PR 6)
PR 6 shipped the Task Inbox UI (Urgent + Assigned sections, filters, sort, expanded detail). Backend persistence was deferred:
- `is_urgent` flag lives in `localStorage` only — doesn't sync across devices or with the team.
- No Salesforce write-back for urgent toggling.
- No toggle API endpoint.
- **Backend changes**: `PUT /api/salesforce/tasks/{id}` should accept `is_urgent`. If SF doesn't have a native field, store locally in a bedrock table + merge with SF data in GET response.
- **Files**: `routes/salesforce_tasks.py` (or equivalent), `TaskInbox.tsx`, `services/api.ts`.

### M10. Pipeline Cleanup Tool (stale-opportunity hygiene)
From `tasks/todo.md` Future Considerations: dedicated cleanup feature for stale opportunities (past close date or no updates in 30+ days). Was removed from the Overview dashboard — belongs as its own tool, not on the main Progress page.
- **Scope**: list stale opps grouped by owner + stage, bulk actions (update stage, close, reassign), filter by last-activity date.
- **Files**: new `pages/PipelineCleanup.tsx`, backend query endpoint for staleness.
- **Depends on**: clear "stale" definition from Scope Constitution (`product/crm-architecture/canonical-definitions.md` §4 — 30-day activity + stage gap).

---

## Large (needs planning, possibly its own sprint)

### L1. Global search bar ✅ SHIPPED (Session 6, PR #73)
Rounded search bar in the top app bar. Searches across SF Opportunities, Contacts, Accounts. Shows grouped results in a dropdown. Click opens edit dialog; secondary icon navigates to Pipeline with tab + filter. Includes local cache typeahead, search history, keyboard navigation (⌘K toggle), mobile overlay.
- **Backend exists**: `routes/salesforce_search.py` has SOSL cross-entity search + SOQL per-entity search endpoints. Already wired.
- **Decision resolved**: Option C — click opens edit dialog + "View in Pipeline" link in dropdown row.
- **Enhancement needed**: Add **Tasks** to global search — search by subject/description, click to open TaskPanel. Requires SOSL RETURNING clause update + frontend section in GlobalSearch.tsx.

### L2. Accountability mechanism
Nick's mandate: "Are the things you're prioritizing aligned with meeting your goal?" Needs design thinking — not just a feature but a workflow.
- Questions to answer first: What data shows alignment? How do we measure "closing deals toward goal"? Is this a Pebble insight (AI-generated weekly review) or a Bedrock dashboard widget?
- **Not ready to build** — needs product design session

### L3. News ticker / RSS feed
AI-focused news feed at top of Priorities page. Configurable keywords in Settings. Default keywords provided. Use Google News RSS, NewsAPI, or similar.
- **Decision**: Cost-effective approach? Google News RSS (free but scraping-gray-area), NewsAPI (paid), Serper news search (already have API key)?
- **Not urgent** — nice-to-have after core features ship

---

## Pebble Research (not UI — investigation items)

### P1. Temperature tuning across swarm layers
Should different tiers/agents use different temperatures? Low temp for precise fact extraction, higher temp for creative synthesis? Worth experimenting.
- **Investigation only** — test with a few prospects and compare output quality

### P2. Firecrawl analysis
Evaluate Firecrawl repo for web scraping in T1-T3. Converts pages to clean markdown. Could supplement or replace current web search approach.
- **Investigation only** — assess quality, cost, rate limits, compare to current Serper + raw fetch approach

---

## Already done (removed from original)

- Calendar view expansion + chronological layout (PR-05)
- Task Inbox owner filter + date range picker (PR-06)
- "Go to GCal" link on calendar events
- Tasks in Calendar view pulling beyond today
- Calendar with Task Inbox list view
- Dashboard weighted pipeline (Reach/Base/Downside)
- Logo redesign (PR-10)
- Opportunity name click opens edit dialog (Sprint 7)
- GCal connection fix
- Task color scheme (urgent/overdue/assigned)
- Server rearchitect (simple_server.py -> main.py + routes/)
- Task edit permissions (ownership enforcement)
- Column sorting in Priority Opportunities (PR-03)
- Revenue Snapshot toggle (All/Filtered/Top Priorities — 3-way)
- Total vs Weighted toggle (exists, but has a bug — see M1)
