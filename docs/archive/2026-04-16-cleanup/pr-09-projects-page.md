# PR 9: Projects Page

**Type:** Feature (Major)
**Size:** XL
**Branch:** `feature/projects-page`
**Depends on:** Nothing (but needs separate deep planning session)
**Status:** Needs detailed design before implementation

## Problem

The team uses the AIJI Project Tracker spreadsheet (Google Sheets / Excel) for deep project planning with milestones, hierarchical tasks, and workstream tracking. This should live in Bedrock for centralized access and real-time collaboration.

## Informed by AIJI Project Tracker_v6.xlsx

The spreadsheet has this structure:

### Workstreams (top-level grouping)
1. Strategy & Design
2. Partnerships & Development
3. Communications & Narrative
4. Launch & Activation

### Milestones (under each workstream)
Fields: Workstream, Milestone name, Status (On Track / At Risk / Needs Attention), Priority (Now / Later / On-going), Description, Owner, Source link

### Tasks (under each milestone)
Fields: Workstream, Project (milestone), Task, Status, Owner, Deadline, Description, Updates, Link

### Key Views from the Spreadsheet
- **Executive Snapshot** — workstream status RAG, key metrics, focus areas, input from Nick
- **Top 30 Funders** — grouped by stage with funder details
- **Total AIJI Funder Pipeline** — segmented into Funds Secured / Active Pipeline / Early-stage
- **Board Pipeline** — advisory board tracking
- **Partner Pipeline** — partner tracking by tier

## Proposed Design

### Navigation
- New "Projects" nav item in sidebar (between Priorities and Pipeline)
- Route: `/projects`

### View Selector
Dropdown or tabs at the top:
- **AIJI Construction Plan** — milestones + tasks for Launch & Activation
- **AIJI Campaign Plan** — milestones + tasks for Partnerships & Communications
- **Executive Snapshot** — summary matching the spreadsheet's format
- **Full Project View** — all workstreams expanded

### Data Model

```
Project {
  id, name, description, created_at, updated_at
}

Workstream {
  id, project_id, name, sort_order
}

Milestone {
  id, workstream_id, name, status, priority, description, owner, source_url, sort_order
}

ProjectTask {
  id, milestone_id, title, status, owner, deadline, description, updates, link,
  parent_task_id (nullable — for sub-tasks),
  depends_on (nullable — task ID this depends on),
  sort_order
}
```

**Note:** This is separate from Salesforce Tasks. ProjectTasks are for internal project management; SF Tasks are for opportunity-linked CRM actions. They may link in the future.

### Sub-Task Dependencies
- Tasks can have a `parent_task_id` for nesting
- Tasks can have `depends_on` for sequencing (e.g., "Finalize charter" before "Confirm commitments")
- Visual: indented children, dependency arrows or blocked-status indicators
- Salesforce Tasks don't support this natively — this is Bedrock-only

### Storage
- PostgreSQL tables (new schema)
- Optionally seed from the AIJI spreadsheet as initial data
- No Salesforce sync for milestones/project-tasks (Bedrock-native)

## Open Questions (for deep planning session)

1. **Should Projects be generic or AIJI-specific?** If generic, any user can create a project. If AIJI-specific, it's a fixed structure seeded from the spreadsheet.
2. **Who can edit?** All team members, or only project owners/admins?
3. **How do the Executive Snapshot metrics connect?** Are they manually entered or auto-calculated from Salesforce data (like the spreadsheet's auto-refresh from SF)?
4. **Timeline/Gantt view?** Start with list view, add timeline later?
5. **Relationship to Salesforce?** Should creating a task in Projects optionally create a corresponding SF Task?
6. **Import from spreadsheet?** One-time seed from the xlsx, or ongoing sync?

## Files to Touch (estimated)

- `financial_forecasting/frontend/src/pages/Projects.tsx` — **new page**
- `financial_forecasting/frontend/src/components/ProjectView.tsx` — **new**
- `financial_forecasting/frontend/src/components/MilestoneList.tsx` — **new**
- `financial_forecasting/frontend/src/components/ProjectTaskList.tsx` — **new**
- `financial_forecasting/frontend/src/components/ExecutiveSnapshot.tsx` — **new**
- `financial_forecasting/frontend/src/components/Layout.tsx` — add nav item
- `financial_forecasting/frontend/src/services/api.ts` — project endpoints
- `financial_forecasting/backend/` — CRUD endpoints + DB schema
- `App.tsx` — add route

## Acceptance Criteria (high-level)

- [ ] Projects page accessible from sidebar navigation
- [ ] View selector switches between Construction, Campaign, Snapshot, Full views
- [ ] Workstream → Milestone → Task hierarchy renders correctly
- [ ] Sub-task nesting works with visual indentation
- [ ] Task CRUD (create, edit, delete, reorder)
- [ ] Milestone CRUD
- [ ] Status updates (On Track / At Risk / Needs Attention) with color coding
- [ ] Executive Snapshot view matches the spreadsheet's format
