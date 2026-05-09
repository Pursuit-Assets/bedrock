# Bedrock v2 — Synthesis & Proposal

> Drafted 2026-05-01 after a parallel analysis of the legacy frontend, backend
> endpoint surface, and current v2 progress. Companion to
> `tasks/bedrock-redesign-data-model.md`.

---

## 1. What the legacy app does well — bring forward

These patterns earn their keep; v2 should preserve or improve on each.

### Daily-use surfaces
- **`/priorities` ("what do I do this week")** — a resizable two-pane view:
  WeeklyCalendar + TaskInbox + GoalTracker. Drives day-to-day focus for the
  fundraising team. **Status in v2: missing.** This is the biggest functional
  gap right now. Recommend rebuilding as the new Dashboard's primary view (or
  promoting Dashboard → Priorities and folding metrics into a small strip).

- **`/dashboard` ("Wall of Progress")** — owner-rollup table: FY revenue
  goal, wins, pipeline, with year-progress markers overlaid on per-owner
  progress bars. Used by leadership monthly. **Status in v2: stub.** Should
  become the *executive* view (and Priorities becomes the *IC* view).

- **`/details` (5-tab hub)** — Opportunities, Accounts, Contacts, Leads,
  Tasks all on one page with a column chooser. **Status in v2: split into
  individual nav items.** I think the split is correct — clearer mental
  model — but we lose cross-tab persistence. Trade-off worth it.

- **`/cashflow`** — finance-team view: received payments, pending
  invoices, unpaid bills, weighted forecast by month. **Status in v2:
  missing.** Lower priority but should land for finance use cases.

### Critical UX patterns
| Pattern | Legacy | v2 status |
|---|---|---|
| Resizable column widths persisted to localStorage | ✅ | ✅ shipped |
| Sortable headers with persistence | ✅ | ✅ shipped |
| Inline cell editing with optimistic updates | partial (legacy used MUI cell edit; reverted on stale fetch — same bug we just fixed) | ✅ shipped, plus checkmark animation |
| Drawer for record drill-in (right side) | ✅ heavy use | ✅ shipped (Account/Opp/Award/Contact/Project drawers) |
| Field-sensitivity locks (safe / sensitive / permission-gated) | ✅ | ❌ not in v2 — every field is freely editable. **Recommend adding** for Stage, Amount, OwnerId, AccountId. Pattern: a small "are you sure?" inline confirmation on first sensitive edit per session. |
| Record locking (concurrent edits) | ✅ via `bedrock.opportunity_lock` | ❌ not surfaced in v2. Defer until multi-user editing produces an actual incident. |
| Toast notifications (react-hot-toast top-right) | ✅ | ❌ v2 uses inline checkmark only. Add toasts for destructive actions, errors. |
| Global search (⌘K) across opps/accounts/contacts/tasks | ✅ Cmd+K | ❌ box exists in sidebar but does nothing. **Recommend wiring** in next iteration. |
| Permission-gated routes | ✅ via PermissionsContext | ❌ v2 doesn't gate routes by permission yet — all logged-in users see everything. **Recommend adding** before any production users. |
| Bulk select + bulk update | ✅ Opportunities only | ❌ not in v2. Fine to defer. |

### Field defaults the team actually uses

Confirmed via legacy `DEFAULT_VISIBLE_*` sets — bring forward as the v2
defaults, then let column-chooser expose the rest:

- **Opportunity**: Name, Account, Owner, Stage, Amount, Probability,
  CloseDate, PaymentDate__c (1st payment date), NextStep
- **Account**: Name, Type, Industry, Phone, Owner, AnnualRevenue
- **Contact**: FirstName, LastName, Email, Phone, Title, Department,
  Account
- **Task**: Subject, Status, Priority, ActivityDate, WhoId, OwnerId

v2 currently shows a smaller subset on each. **Recommend** adding the
column-chooser primitive next so users can opt into the rest.

---

## 2. What to skip / kill

| Legacy thing | Why skip |
|---|---|
| **Pebble chat (`/pebble`)** | Permission-gated already; unclear if it's used. Defer until product validates demand. |
| **Network Map** (`/network`) — react-force-graph LinkedIn visualization | Heavy bundle, unclear ROI. Skip unless Mark/Devika ask for it. |
| **DataTools cleanup page** | Admin-only; rebuild only if dedup/cleanup workflows are missed. |
| **AutomationReview** (lazy-loaded, non-MVP) | Was experimental in legacy, can stay deferred. |
| **Contract_* fields** in OpportunityEditDialog | Legacy bug — fields don't exist in live SF org. Don't port. |
| **The four "redirect" routes** (`/overview`, `/reports`, `/pipeline-old`, etc.) | Backwards-compat URLs from prior renames. Don't carry forward. |

---

## 3. Task management — the rebuild's biggest current gap

The legacy app fragments tasks across **three systems**:
1. **Salesforce Task** (SObject; the canonical CRM task)
2. **`bedrock.project_task`** (Postgres; the execution-flavor task with
   dependencies, gantt support)
3. **`sf_task_project`** bridge (links #1 to a project)

Backend coverage today:

| Endpoint | Status | Notes |
|---|---|---|
| `GET /api/salesforce/my-tasks` | ✅ exists | User's open SF tasks, date-bounded |
| `GET /api/salesforce/opportunities/{id}/tasks` | ✅ exists | All SF tasks WhatId-linked to opp |
| `POST /api/salesforce/opportunities/{id}/tasks` | ✅ exists | Create — locked-aware |
| `PUT /api/salesforce/tasks/{id}` | ✅ exists | Update — sophisticated lock logic |
| `DELETE /api/salesforce/tasks/{id}` | ✅ exists | Lock-aware |
| `POST /api/salesforce/tasks/{id}/duplicate` | ✅ exists | Cross-opp duplication |
| **`GET /api/salesforce/contacts/{id}/tasks`** | ❌ missing | Per-contact task list |
| **`GET /api/salesforce/accounts/{id}/tasks`** | ❌ missing | Per-account task list |
| **`POST /api/salesforce/tasks` (no opp scope)** | ❌ missing | Create a task w/ arbitrary WhatId |
| **`GET /api/salesforce/tasks` (global, with filters)** | ❌ missing | Global task list across opps |
| `POST /api/projects/{id}/sf-tasks` (link to project) | ✅ | |
| All `project_task` CRUD | ✅ | |

### What v2 has now

- **Tasks page**: rewritten today to union SF my-tasks + project_tasks. Read-only drawer.
- **Account drawer**: shows tasks for the account by walking opps → SF tasks per opp (N+1 fetches; works but slow with whales). Filters to opps' tasks.
- **Opportunity drawer**: shows tasks via `useOpportunityTasks(opp.Id)`.
- **Award drawer**: shows tasks via the underlying opp, post-award-date.
- **Project drawer**: shows project_tasks (open, by deadline).
- **No way to create tasks from any drawer** — only from clicking through to SF.

### Recommended task additions (in priority order)

**P0 — these unblock the daily workflow:**
1. **Inline create-task button** in Account, Opp, and Award drawers. Calls
   `POST /api/salesforce/opportunities/{opp_id}/tasks`. For accounts, pick
   "associate with which opp?" if multiple; for awards, default to underlying opp.
2. **Inline edit on task rows** (Status + ActivityDate) using `PUT
   /api/salesforce/tasks/{id}`. Same optimistic-mutation pattern as accounts.
3. **Mark complete checkbox** on every task row. Sets `Status='Completed'`.

**P1 — fills product gaps:**
4. **`GET /api/salesforce/accounts/{id}/tasks` backend endpoint** — query
   `WHERE WhatId IN (... opps for this account ...)`. Lets the Account drawer
   stop doing N+1 fetches. ~40 lines in `main.py`.
5. **`GET /api/salesforce/contacts/{id}/tasks` backend endpoint** — query
   `WHERE WhoId = '{contact_id}'`. Lets the Contact drawer surface tasks.
6. **Bulk-mark-complete** on the Tasks page.

**P2 — nice to have:**
7. **`POST /api/salesforce/tasks` (no opp context)** — for orphan tasks /
   tasks tied to Account directly.
8. **Task dependencies UI** for project_tasks (the field exists; legacy
   doesn't surface it well).

---

## 4. Permissions — recommend wiring before production

Legacy has 34 permission keys; v2 has zero gating today. Minimum viable:

- **Route guards**: `view_projects`, `use_pebble_*` block routes per-user.
- **Edit gating**: any inline edit checks `edit_own_*` or `edit_all_*`. Cells
  switch to read-only display if user lacks permission.
- **Admin-only views**: Settings → Permissions Manager (not yet built; legacy
  has it).
- **`_enforce_record_ownership`**: backend already does this on every PUT.
  v2 just needs to render error toasts gracefully when the 403 lands.

Suggested next-step: add a `usePermissions()` hook that hydrates from `GET
/api/permissions/me` and exposes `can(key)`. Wire it into the same pattern as
`useCurrentUser()`.

---

## 5. What's good in v2 right now

Patterns now consistent across **Accounts, Pipeline, Awards, Contacts,
Projects, Tasks**:

- ✅ Top-level full-height layout with self-scrolling table area
- ✅ Resizable columns persisted to localStorage per page
- ✅ Sortable headers (asc → desc → cleared on third click)
- ✅ Virtualized rows (~30 in DOM regardless of dataset size)
- ✅ Sticky header + sticky totals footer
- ✅ Drawer pattern for row drill-in with sections (stats / details / tasks /
  payments / activity)
- ✅ Inline edit with checkmark animation (Accounts, Pipeline, Awards,
  Contacts editable cells)
- ✅ Optimistic React Query mutations (cache rewrite + 2s deferred refetch)
- ✅ Persistent React Query cache (`PersistQueryClientProvider`) — 2nd loads
  near-instant
- ✅ AuthGate handles persister-restore phase correctly
- ✅ Reusable primitives: `<ResizableTh>`, `<ColGroup>`, `<SortableHeader>`,
  `<InlineText>`, `<InlineSelect>`, `<Drawer>`, `<Toolbar>`, `<Tag>`,
  `<StageChip>`

---

## 6. Open questions for you

1. **Priorities page** — bring it back as the new Dashboard, or as a
   separate `/priorities` route? Legacy has both routes; users default to
   `/priorities`. My recommendation: rebuild as the default home page; keep
   the executive Wall-of-Progress as `/dashboard`.

2. **Cashflow** — required for v1, or post-v1? Legacy has 4 sub-tabs
   (FinanceDashboard / ReceivedPayments / PendingInvoices / UnpaidBills).
   Heavy build.

3. **Permissions** — when do we wire route + edit gating? Before any
   non-admin uses v2, or after? Legacy enforces tightly.

4. **Field sensitivity locks** — bring forward, or trust users? Legacy
   gates Stage, Amount, OwnerId, AccountId behind a one-click "are you sure"
   confirmation. Adds friction; prevents fat-finger fundraising errors.

5. **Bulk operations** — needed in v1? Legacy has bulk stage-change +
   bulk-withdraw on Opportunities. Useful for end-of-quarter cleanup.

6. **Task creation buttons** in drawers — should I add P0 items 1-3 from
   §3 next, or prioritize Priorities/Dashboard rebuild first?

7. **Record locking** — defer or surface in v2? Multiple staff editing the
   same opp simultaneously is rare but real.

8. **Column chooser** + **saved views** — confirmed both in our last chat.
   Sequence them after task management?

---

## 7. Recommended next iteration sequence

If you want me to keep going, my suggested order (in roughly half-day
blocks):

1. **Task creation + complete checkbox** in drawers (P0 #1-3 from §3).
   Half day. Unblocks the daily workflow.
2. **Backend per-account / per-contact tasks endpoints** (P1 #4-5 from §3).
   1-2 hours.
3. **Priorities page** (rebuild legacy /priorities). 1 day.
4. **Dashboard** (Wall of Progress, owner rollup). 1 day.
5. **Permissions wiring** — usePermissions hook + route guards + edit
   gates. 1 day.
6. **Column chooser** primitive. 1 day.
7. **Cashflow page** rebuild. 1-2 days.
8. **Saved views** primitive. 1-2 days.

That's roughly 1.5-2 weeks to feature-parity with the parts of legacy that
matter, plus the redesigned-from-scratch task surface.
