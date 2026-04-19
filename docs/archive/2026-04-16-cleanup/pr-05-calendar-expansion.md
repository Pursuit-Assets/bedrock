# PR 5: Calendar Expansion + Multi-Calendar Toggles

**Type:** Feature
**Size:** Large
**Branch:** `feature/calendar-expansion`
**Depends on:** Nothing

## Problem

1. Calendar is a simple grid showing max 5 events per day without time positioning. Needs GCal-like chronological layout.
2. No way to toggle calendar sources on/off. Currently hardcoded to PBD calendar + SF tasks.

## Part A: Chronological Calendar Layout

### Current State
`WeeklyCalendar.tsx` renders events as stacked chips in day columns. No time axis. Max 5 visible per day with "+N more" overflow.

### Target State
- Time-slot based layout with hourly rows (e.g., 7am–9pm)
- Events rendered as blocks spanning their actual start→end time
- All-day events and dateless tasks appear in a header row above the time grid
- Overlapping events render side-by-side (like GCal)
- Keep Day/Week/2Week view toggle
- Scroll to current time on load

### Implementation Approach

**Option A: Build from scratch with CSS Grid**
- Time axis as rows, days as columns
- Events absolutely positioned by start time + duration
- Overlap detection algorithm to calculate column width/offset

**Option B: Use a calendar library (FullCalendar, react-big-calendar)**
- `react-big-calendar` with MUI integration
- Already supports time grid, event overlap, day/week views
- Less custom code, more configuration

**Recommendation:** react-big-calendar — it handles the hard layout math and is well-maintained. Style it with MUI theme to match Bedrock's look.

### Key Details
- Event height = duration in minutes / 60 * row-height
- Min event height = 20px (for very short events)
- Click event to see details (opportunity link, description)
- Current time indicator line (red line like GCal)

## Part B: Calendar Source Toggles

### Design

A "Calendars" button/popover in the calendar header that opens a checkbox list:

```
[x] PBD Calendar          (blue dot)
[x] Salesforce Tasks       (amber dot)
[ ] Personal Calendar      (green dot)    ← only if authorized in Settings
```

### Rules
- Only show calendars that are connected and authorized in Settings
- Each calendar source gets a distinct color for its events
- Toggle state persists in user preferences
- When unchecked, events from that source are hidden (not removed from data, just filtered from view)

### Settings Integration
- Settings page (`src/pages/Settings.tsx`) already has a Google Calendar section
- Extend to support adding multiple calendar IDs
- Store authorized calendar list in user preferences or backend user record
- Architecture decision 6C in `docs/architecture-decisions.md` already plans for this

### API
`/api/calendar/my-events` already accepts `calendar_id` param. For multiple calendars, make parallel calls per authorized calendar ID and merge results.

## Files to Touch

- `financial_forecasting/frontend/src/components/WeeklyCalendar.tsx` — major rewrite
- `financial_forecasting/frontend/src/pages/MyDashboard.tsx` — update calendar data fetching for multi-source
- `financial_forecasting/frontend/src/pages/Settings.tsx` — multi-calendar authorization UI
- `package.json` — add `react-big-calendar` (if Option B)

## Acceptance Criteria

- [ ] Events display at their actual time positions in a time-slot grid
- [ ] Day/Week/2Week views all work with time-based layout
- [ ] All-day and dateless items appear in a header row
- [ ] Overlapping events render side-by-side
- [ ] Current time indicator visible
- [ ] Calendar source toggles show only authorized calendars
- [ ] Toggling a source on/off shows/hides its events immediately
- [ ] Toggle state persists across sessions
- [ ] No write-back to Google Calendar (read-only)
