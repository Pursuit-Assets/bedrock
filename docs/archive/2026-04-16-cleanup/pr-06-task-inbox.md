# PR 6: Task Inbox

**Type:** Feature
**Size:** Large
**Branch:** `feature/task-inbox`
**Depends on:** Nothing (but ships before PR 7)

## Problem

No unified task view. Tasks are scattered across opportunity detail panels and the calendar. Users need a single inbox that answers "what should I do next?" with urgency-aware sorting.

## Design

### Component: `TaskInbox.tsx`

Two sections stacked vertically:

**1. Urgent Requests** (top, visually distinct with red/amber accent)
- Tasks manually flagged as urgent by any user
- Sorted by due date (soonest first)
- Shows who flagged it / who created the task

**2. Assigned** (below)
- All other tasks assigned to the current user
- Sorted by due date (soonest first)
- Grouped or ungrouped by linked Opportunity (user toggle)

### Task Row Layout

```
[Urgent badge?] [Status dot] Task Subject
  Due: Mar 20  |  Opp: FY26 - Google - AIJI  |  Assigned by: Devika
  [Expand ▼]
```

Expanded view shows: Description, Status selector, Priority selector, Drive link, Edit/Delete actions.

### Filters

Toolbar above the inbox with filter chips:

| Filter | Options |
|--------|---------|
| Status | Not Started, In Progress, Completed, Deferred |
| Priority | High, Normal, Low |
| Due Date | Overdue, Today, This Week, Next 7 Days, Next 30 Days, All |
| Opportunity | Multi-select from linked opportunities |
| Owner | Current user (default), All users |

### Sorting

Column-style sort toggles: Subject, Due Date, Status, Priority, Opportunity.

### Urgent Flag

- New boolean field `is_urgent` on tasks
- Any user can flag a task as urgent (toggle button on the task row)
- Flagging moves it to the Urgent Requests section immediately
- Unflagging moves it back to Assigned

### Visual Highlighting

- **Overdue:** Red left-border + "Overdue" chip
- **Due within 24h:** Amber left-border + "Due soon" chip
- **Completed:** Muted/greyed text, collapsed by default

### `created_by` Tracking

**For Salesforce-synced tasks:**
- Pull `CreatedById` from Salesforce Task object
- Map to user name for display

**For tasks created in Bedrock:**
- Save `created_by` as current user's ID on create
- Display as "Assigned by [name]"

**Data model addition:**
```
Task {
  ...existing fields...
  is_urgent: boolean (default false)
  created_by: string (user ID)
  created_by_name: string (denormalized for display)
}
```

## API Changes

### Backend (FastAPI)

- `GET /api/salesforce/my-tasks` — add `created_by` and `is_urgent` to response
- `PUT /api/salesforce/tasks/{id}` — accept `is_urgent` field
- `POST /api/salesforce/tasks` — accept `created_by`, `is_urgent`
- If `is_urgent` isn't a native SF field, store locally and merge with SF data

### Frontend (`src/services/api.ts`)

- Update `getMyTasks()` return type to include `created_by`, `is_urgent`
- Update `createTask()` and `updateTask()` to send new fields

## Files to Touch

- `financial_forecasting/frontend/src/components/TaskInbox.tsx` — **new file**
- `financial_forecasting/frontend/src/services/api.ts` — update task endpoints
- `financial_forecasting/frontend/src/types/salesforce.ts` — add `is_urgent`, `created_by` to Task type
- `financial_forecasting/backend/` — update task endpoints (FastAPI)

## Acceptance Criteria

- [ ] Inbox shows two sections: Urgent Requests and Assigned
- [ ] Tasks flagged as urgent appear in Urgent Requests section
- [ ] Filters work for Status, Priority, Due Date, Opportunity, Owner
- [ ] Columns are sortable
- [ ] Overdue tasks have red visual indicator
- [ ] Due-soon tasks (24h) have amber visual indicator
- [ ] Expanding a task shows full details with edit capability
- [ ] `created_by` displays correctly for both SF and Bedrock-created tasks
- [ ] Flagging/unflagging urgent updates the view immediately
