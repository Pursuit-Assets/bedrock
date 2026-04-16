# Project Hierarchy Soft-Delete Plan

**Milestone**: M18
**Status**: Complete (shipped 2026-03-30, PR #85)
**Priority**: High — mitigates irreversible data loss from accidental deletes. Team is actively using Projects.
**Dependency**: M10 (Activities Foundation) — M10 establishes the soft-delete pattern (deleted_at, partial index, UPSERT WHERE guard). M18 applies that proven pattern to projects + refactors CASCADE.
**Can parallel with**: M13 (Activities Timeline) — touches completely different files

## Problem

The `project` table uses `ON DELETE CASCADE`. A single `DELETE FROM project WHERE id = $1` permanently destroys:
- All workstreams (CASCADE from project)
- All milestones (CASCADE from workstream)
- All project_tasks (CASCADE from milestone)
- All sf_task_project bridge rows (CASCADE from project)
- All project_opportunity junction rows (CASCADE from project)

This is irreversible. No undo, no trash bin, no recovery.

## Risk Assessment

| Table | Current delete | Cascade depth | Data loss severity |
|-------|---------------|---------------|-------------------|
| `project` | Hard delete | Root — cascades to everything | **Critical** |
| `workstream` | Hard delete (cascade) | Cascades to milestones + tasks | **High** |
| `milestone` | Hard delete (cascade) | Cascades to tasks | **Medium** |
| `project_task` | Hard delete (cascade) | Leaf node + SF bridge rows | **Medium** |
| `activity` | Soft delete (Sprint 9A) | Leaf node | Already handled |
| `app_user` | `is_active` boolean | N/A | Already handled |
| Junction tables | Hard delete | Leaf nodes | Low (recreatable) |

## Proposed Design

### Phase 1: Add `deleted_at` to project hierarchy

Add `deleted_at TIMESTAMPTZ` to: `project`, `workstream`, `milestone`, `project_task`.

**Do NOT remove CASCADE constraints yet.** Instead:
1. Add `deleted_at` column to each table (idempotent ALTER TABLE)
2. Replace `DELETE FROM` with `UPDATE SET deleted_at = now()` in all route handlers
3. Add `WHERE deleted_at IS NULL` to all SELECT queries
4. Add partial indexes: `CREATE INDEX ... WHERE deleted_at IS NULL`

### Phase 2: Application-level cascade soft-delete

When soft-deleting a project:
1. `UPDATE project SET deleted_at = now() WHERE id = $1`
2. `UPDATE workstream SET deleted_at = now() WHERE project_id = $1`
3. `UPDATE milestone SET deleted_at = now() WHERE workstream_id IN (SELECT id FROM workstream WHERE project_id = $1)`
4. `UPDATE project_task SET deleted_at = now() WHERE milestone_id IN (SELECT id FROM milestone WHERE workstream_id IN (SELECT id FROM workstream WHERE project_id = $1))`

Wrap in a transaction. All-or-nothing.

### Phase 3: Restore and cleanup

- `POST /api/projects/{id}/restore` — clears `deleted_at` on project + all children
- Scheduled cleanup: permanently delete records where `deleted_at < now() - interval '60 days'`
- This matches the "Trash Bin" concept already in todo.md

## Files to Modify

- `db/init.sql` — Add `deleted_at` columns (idempotent ALTER TABLE)
- `routes/projects.py` — Replace DELETE with soft-delete, add WHERE filters
- `routes/sf_dependencies.py` — Add WHERE deleted_at IS NULL
- Tests — Update to verify soft-delete behavior

## Notes from Sprint 9A Planning Session

- The `activity` table (Sprint 9A) is the first soft-delete table in the codebase
- The pattern is proven there: `deleted_at TIMESTAMPTZ`, partial index, WHERE guard
- `app_user` already uses `is_active BOOLEAN` which is effectively soft-delete
- The CASCADE refactor (Phase 2) is the hard part — needs careful transaction handling
- Consider: should hard-delete still be available to admins? (Emergency cleanup)

## Implementation Notes (2026-03-30)

Shipped with scope additions beyond original plan:
- `deleted_by TEXT` audit column on all 4 hierarchy tables (not in original plan)
- Trash UI in sidebar with collapsible section, visible to all users (not in original plan)
- Admin-only permanent purge via `DELETE /projects/{id}/purge` (not in original plan)
- Timestamp-matching restore: only restores cascade-deleted children, preserves individually-deleted items (not in original plan)
- 90-day retention window (updated from original 60-day)
- 42 tests covering auth, CRUD, soft-delete, restore, purge, trash list

Deferred to M19: Project ownership model (owner_email, contributors, owner-only delete).
