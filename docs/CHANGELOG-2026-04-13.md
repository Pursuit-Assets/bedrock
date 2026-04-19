# Bedrock Changes — April 13-14, 2026

Summary of all changes from this session for JP's review.

---

## Bug Fixes (7 total)

### Bug 1: Data limits + account search (done prior session)
- Backend default limits increased from 100 to 2000 for accounts/contacts
- Account picker on NewOpportunity converted to server-side typeahead search with 300ms debounce

### Bug 2: Task drawer on wrong side
- **File**: `components/TaskPanel.tsx`
- **Root cause**: `position: 'relative'` in PaperProps overrode MUI Drawer's `position: fixed` + `right: 0`, causing the panel to render in normal document flow (left side)
- **Fix**: Removed `position: 'relative'` from PaperProps

### Bug 3: Priority opps not editable inline
- **File**: `components/PriorityTable.tsx`
- Added `OppEditableCell` component for inline editing of Stage (dropdown), Amount (currency input), and CloseDate (date picker)
- Saves via `apiService.updateOpportunity()` on blur/enter
- Probability remains read-only (auto-calculated from stage in SF)

### Bug 4: Column widths shift on sort (done prior session)
- Added `tableLayout: 'fixed'` to priority table

### Bug 5: Opp detail modal should be right drawer
- **File**: `components/OpportunityEditDialog.tsx`
- Converted from `<Dialog>` to `<Drawer anchor="right">`
- Added resize handle (480-900px range), close button header, scrollable content, sticky footer
- Same props interface — no changes needed in consumer files

### Bug 6: Inactive owners grouped in filters
- **Files**: `pages/MyDashboard.tsx`, `components/TaskInbox.tsx`, `components/PipelineFilterBar.tsx`, `pages/Opportunities/EditCells.tsx`, `components/OpportunityEditDialog.tsx`, `pages/NewOpportunity.tsx`
- **Backend** (`main.py`): Removed `WHERE IsActive = true` from SF users query — now returns all users with `IsActive` field. Default limit bumped to 1000.
- Owner filter dropdowns grouped by Active/Inactive with `ListSubheader` dividers
- Users with 0 opportunities excluded from Priorities owner dropdown
- Task inbox owner filter only shows users who own tasks
- OwnerEditCell and owner Autocompletes in edit forms also grouped

### Bug 7: Goals settings UI (renamed to Targets)
- **File**: `pages/Settings.tsx`
- Added "Targets" tab (was "Goals") gated behind `manage_targets` permission (admin + exec)
- Inline row addition — no popup dialog. Pick owner, set amount, period auto-uses selected FY
- Table shows only explicitly created targets (no $2M default)
- Edit and delete per row
- Added `manage_targets` to permission groups in Settings

---

## Dashboard Overhaul

### Pipeline Summary Table
- **File**: `pages/Overview.tsx`
- Replaced 4 metric cards + Current Quarter Focus card with a single compact table
- **Rows**: Wins, Total Pipeline, Upside, Base Case, Downside
- **Columns**: Overall, FY26, Q1, Q2, Q3, Q4
- Wins included in all scenario calculations at 100% (using CloseDate for time scoping)
- Past quarters: only Wins row shows values, all others show "—"
- Overall column: only Total Pipeline and Wins have values, scenarios show "—"
- Tooltips explain each calculation

### Individual Progress Table
- Replaced owner selector + OwnerGoalWidget donut charts with a target-based table
- Shows all users who have revenue targets set
- Each row: Owner, progress bar, wins, remaining, projected, target
- **Progress bar**: Year-progress marker (vertical line with dot) showing calendar position. Color-coded by pace: green (ahead), yellow (within 75%), red (behind)
- **Expandable rows**: Click to see wins (closed opps) and open pipeline detail (sorted by weighted value, showing what they need to close to hit target)

### Hidden Below-Fold Content
- Removed DashboardBelowFoldCharts (cash flow cards, 12-month forecast, position cards, quarterly projection)
- Cleaned up all related data fetches, state, and unused imports

---

## UI/UX Changes

### Nav Cleanup
- **File**: `components/Layout.tsx`
- Removed from sidebar: Data Tools, Cash Flow, Pebble, Research, Auto Review
- Remaining: Dashboard, Priorities, Pipeline, Projects, Settings

### Consistent Drawer Panels
- **Files**: `TaskPanel.tsx`, `ActivityIntelligencePanel.tsx`, `OpportunityEditDialog.tsx`
- All three now: 680px default width, 480-900px resize range, same drag handle on left edge
- ActivityIntelligencePanel gained resize capability (was fixed at 560px)
- TaskPanel max reduced from 1200 to 900

### Priority Table Column Spacing
- **File**: `components/PriorityTable.tsx`
- Switched from fixed px widths to percentage-based: # 3%, Opportunity 20%, Stage 14%, Amount 8%, Close 7%, Prob 5%, Alerts 30%, Tasks 5%, Actions 8%
- Added `minWidth: 1000` so table scrolls horizontally on narrow screens

---

## Infrastructure

### Cloud Run Deployment
- Backend `min-instances` changed from 0 to 1 (eliminates cold start on login, ~$5-10/mo)
- Cloud SQL Auth Proxy configured — backend connects to `second-db` via Unix socket instead of public IP. No more IP allowlist dependency for Cloud Run.
- Favicon 500 fixed: removed missing `.ico` reference from index.html, nginx returns 204 for `/favicon.ico`

### Backend Changes
- **File**: `main.py`
- SF users query returns all users (active + inactive) with `IsActive` field
- Default user limit bumped from 100 to 1000

---

## Identity Consolidation

### org_users as canonical staff table

**Problem**: `bedrock.app_user` was a separate staff identity table that duplicated `public.org_users`. Two sources of truth for the same people.

**Solution**: Made `public.org_users` the canonical staff table, added `bedrock.user_config` for app-specific settings (permission profile), retired `bedrock.app_user`.

### Backend Changes
- **`routes/permissions.py`** — Full rewrite. All queries changed from `bedrock.app_user` to `public.org_users JOIN bedrock.user_config`. Added `_ensure_org_user()` to auto-provision on first visit. `/me` endpoint backfills `sf_user_id` to org_users.
- **`routes/projects.py`** — Project contributor picker changed from `bedrock.app_user` to `org_users JOIN user_config JOIN permission_profile`

### Database Changes
- **`db/init.sql`** — Added `bedrock.user_config` table (org_user_id UUID PK, profile_id UUID FK). Conditional ALTER adds `sf_user_id` and `is_active` columns to `public.org_users`.
- **`db/migrations/2026-04-13-identity-consolidation.sql`** — Migration that copies `sf_user_id` from `app_user` to `org_users` by email match, creates `user_config` rows, creates `org_users` rows for any unlinked `app_user` entries. Idempotent (ON CONFLICT DO NOTHING).

### Impact
- All staff now have one identity in `public.org_users` shared across the platform
- `bedrock.user_config` stores only Bedrock-specific settings (which permission profile)
- `bedrock.app_user` still exists but is no longer read by any code — can be dropped after verification period
- No frontend changes needed — permissions API response shape unchanged

---

## Commits

| Hash | Message |
|------|---------|
| `d0902f0` | feat: identity consolidation — org_users as canonical staff table |
| `756f88c` | fix: dashboard bugs 2-7, nav cleanup, targets tab, consistent drawers |
| `bdb030d` | feat: dashboard overhaul — pipeline table, target progress, hide financials |
| `37ec3bc` | feat: pipeline table — add Q1-Q4 columns, past quarters wins-only |
| `8ecc40d` | feat: pipeline table — add Wins row, past quarters show actuals only |
| `40b3d30` | fix: remove wins from Overall column, keep 1 warm backend instance |
