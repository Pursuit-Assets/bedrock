# PR 7: Home Page Layout Redesign

**Type:** Feature
**Size:** Medium
**Branch:** `feature/home-layout`
**Depends on:** PR 5 (Calendar Expansion), PR 6 (Task Inbox)

## Problem

Current layout is a single-column vertical stack: Calendar → Priority Opportunities → Revenue Snapshot. With the new Task Inbox, the page needs a better information hierarchy that answers "What should I do RIGHT NOW?" at the top.

## Target Layout

```
+-------------------------------+--------------------+
|       Calendar (~60%)         |   Task Inbox       |
|   (time-slot grid)            |   (~40%)           |
|   [Day | Week | 2Wk]         |   [Urgent]         |
|   [Calendar toggles]         |   [Assigned]       |
|                               |   [Filters]        |
+-------------------------------+--------------------+
|       Priority Opportunities (full width)           |
|   [Filters] [Rows] [Total/Weighted]                |
|   [...table rows...]                                |
+---------+----------+----------+--------------------+
|  Total  | Weighted | Closing  |  [Snapshot Mode ▼] |
| Pipeline| Pipeline |This Month|                    |
+---------+----------+----------+--------------------+
```

## Design Details

### Top Row: Calendar + Inbox (side-by-side)

- MUI Grid: `xs={12} md={7}` for Calendar, `xs={12} md={5}` for Inbox
- Shared height: ~400px default, both scrollable independently
- Inbox is collapsible: a collapse button lets Calendar expand to full width
- Collapsed state persists in user preferences

### Responsive Behavior

- **Desktop (md+):** Side-by-side layout as shown
- **Tablet/Mobile (< md):** Stack Calendar above Inbox (full width each)

### Middle: Priority Opportunities

- Full width, unchanged structure
- Filters, row count, total/weighted toggle in the header

### Bottom: Revenue Snapshot

- Full width, three metric cards in a row
- Snapshot mode selector (from PR 4) in the header

### Section Spacing

- 16px gap between sections
- Each section has a subtle card border (existing pattern)
- Section headers with consistent typography

## Implementation

Refactor `MyDashboard.tsx` layout from sequential Box/Stack to MUI Grid:

```tsx
<Grid container spacing={2}>
  {/* Top row */}
  <Grid item xs={12} md={inboxCollapsed ? 12 : 7}>
    <WeeklyCalendar ... />
  </Grid>
  {!inboxCollapsed && (
    <Grid item xs={12} md={5}>
      <TaskInbox ... />
    </Grid>
  )}

  {/* Priority Opportunities */}
  <Grid item xs={12}>
    <PriorityTable ... />
  </Grid>

  {/* Revenue Snapshot */}
  <Grid item xs={12}>
    <RevenueSnapshot ... />
  </Grid>
</Grid>
```

## Files to Touch

- `financial_forecasting/frontend/src/pages/MyDashboard.tsx` — layout restructure

## Acceptance Criteria

- [ ] Calendar and Inbox render side-by-side on desktop
- [ ] Stack vertically on narrow screens
- [ ] Inbox collapse button works and persists state
- [ ] Calendar expands to full width when inbox is collapsed
- [ ] Priority Opportunities and Revenue Snapshot below at full width
- [ ] All existing functionality preserved (no regressions)
- [ ] Consistent spacing and visual hierarchy
