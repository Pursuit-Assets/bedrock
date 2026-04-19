# 2026-04-16 Docs + Tasks Cleanup — Archive

Archived 2026-04-16 as part of the docs/tasks hygiene pass documented in `tasks/f1-stage-buckets-plan.md` context and branch `cleanup/docs-and-tasks-2026-04-16`.

**Nothing in this directory is authoritative for current work.** It's historical reference. If you're looking for the live version of something here, consult the migration destination column below. Follow `docs/DOCUMENTATION-HYGIENE.md` for current authoritative locations.

## Why this archive exists

30 files slated for archive fell into one of four buckets:

1. **Sprint plan / build prompt files for milestones that shipped** (18 files) — one-shot build orders that have no standalone value once the work is in production code. Kept for historical reference.
2. **PR plans that shipped or were intentionally skipped** (10 files, `pr-01` through `pr-10`) — the Bedrock PR Roadmap (2026-03-18) is complete. Ship-order table with status lives in `tasks/todo.md` (links to PR files stripped as part of this cleanup).
3. **Superseded specs** (2 files) — a prior spec has been replaced by a newer canonical doc.

Keeper content from these files migrated to active docs before archive (see per-file notes below).

## File index

| File | Original location | Reason archived | Migration destination |
|---|---|---|---|
| `pr-01-ranking-stability.md` | `tasks/prs/` | Shipped — deterministic tiebreaker in production | — |
| `pr-02-stage-colors.md` | `tasks/prs/` | Shipped — colored stage chips in PriorityTable + PipelineFilterBar | — |
| `pr-03-column-sorting.md` | `tasks/prs/` | Shipped | — |
| `pr-04-revenue-snapshot-filter.md` | `tasks/prs/` | Shipped | — |
| `pr-05-calendar-expansion.md` | `tasks/prs/` | Shipped (time-axis grid + current-time indicator); **overlap detection deferred** | `tasks/bedrock-ui-improvements.md` M8 |
| `pr-06-task-inbox.md` | `tasks/prs/` | Shipped (UI + urgent-toggle in localStorage); **backend persistence deferred** | `tasks/bedrock-ui-improvements.md` M9 |
| `pr-07-home-layout.md` | `tasks/prs/` | Intentionally skipped — resizable-panel layout is functional | — |
| `pr-08-pipeline-funnel.md` | `tasks/prs/` | Shipped | — |
| `pr-09-projects-page.md` | `tasks/prs/` | Shipped — M7 (projects), M18 (soft-delete), M19 (ownership) all landed | — |
| `pr-10-logo.md` | `tasks/prs/` | Shipped (SVG + sidebar + manifest); **favicon PNGs deferred** | `tasks/bedrock-ui-improvements.md` S6 |
| `ask-pebble-build-prompt.md` | `tasks/` | Shipped — PR #50 (Ask Pebble core) | — |
| `ask-pebble-continuation-prompt.md` | `tasks/` | Template superseded; status tracked in `tasks/sprint-plan-2026-04-09.md` | — |
| `google-oauth-setup.md` | `tasks/` | Shipped 2026-03-20; dev bypass removed 2026-04-08 | — |
| `project-soft-delete-plan.md` | `tasks/` | Shipped as M18 (PR #85); deleted_at + trash + restore + 42 tests | — |
| `pebble-stage1-issues.md` | `tasks/` | Resolved issues tracker; all items closed or acceptably deferred | — |
| `server-migration-plan.md` | `tasks/` | Phase 5 complete (PRs #42, #43, Phase 4 deprecation) | — |
| `sprint10-pebble-postgresql.md` | `tasks/` | Shipped as M11 — `pebble/storage/db.py` uses asyncpg | — |
| `m10-activities-foundation-plan.md` | `tasks/` | Shipped 2026-03-29 — `routes/activities.py` + `bedrock.activity` table | — |
| `sprint3-build-prompt.md` | `tasks/` | Shipped as Pebble Sprint 3 (PR #52) — cluster architecture | — |
| `sprint3.5-build-prompt.md` | `tasks/` | Shipped as Pebble Sprint 3.5 (PR #53) — CRM tool-use agent | — |
| `sprint4-planning-prompt.md` | `tasks/` | Meta-prompt superseded by `sprint4-rescoped-plan.md` (also archived here) | — |
| `sprint4-rescoped-plan.md` | `tasks/` | Sprint 4 (Org Intelligence + 990 XML) + Sprint 4.5 (CRM Write Agent) shipped; Sprint 5 (Enhanced Write UX) conditional | 4 design decisions migrated to `docs/architecture-decisions.md` (Sprint 4 Rescoping section) |
| `sprint6-build-prompt.md` | `tasks/` | Shipped — `pebble/clusters/conflict_detector.py` + 7 test files (`test_router.py`, `test_crm_agent.py`, `test_clusters.py`, `test_crm_bridge.py`, `test_integration.py`, `test_agentic.py`, `test_org_intelligence.py`) | — |
| `sprint7.5-sf-field-audit.md` | `tasks/` | Shipped — all 11 NPSP payment fields in `frontend/src/types/salesforce.ts` | — |
| `sprint8-object-editors.md` | `tasks/` | Shipped — ContactEditDialog, AccountEditDialog, PaymentEditDialog all exist | — |
| `sprint9-schema-qualification.md` | `tasks/` | Shipped as M9 — all SQL uses `bedrock.` schema prefix | — |
| `sprint-execution-plan.md` | `tasks/` | 30 days stale (2026-03-30); superseded by `tasks/sprint-plan-2026-04-09.md` | — |
| `implementation-plan.md` | `docs/` | Nov 2025 pre-launch spec; Phase 1 shipped. Phase 2/3 roadmap preserved | `tasks/finance-phase-2-3-roadmap.md` (verbatim Phase 2/3 sections) |
| `home-page-spec.md` | `product/fundraising-team/phases/` | Superseded 2026-03-19 per DOCUMENTATION-REVIEW-2026-03-15 finding #4 | `product/crm-prds/10-home.md` (current authoritative home-page PRD) |
| `DOCUMENTATION-REVIEW-2026-03-15.md` | `product/` | 48-day-old audit snapshot; multiple findings resolved (M19 shipped, entity-map + feature-register landed, home-page-spec superseded) | Findings still outstanding carried in various active PRDs |

## Files NOT archived despite being in tasks/

These remain in the active `tasks/` tree because they represent unshipped work or current authoritative plans:

- `sprint-plan-2026-04-09.md` — current authoritative sprint roadmap
- `pebble-evolution-roadmap.md` — active roadmap
- `track-c-implementation-plan.md` — Sessions 5–7 still open
- `stage-schema-drift.md` — reframed 2026-04-16; still active
- `f1-stage-buckets-plan.md` — 2026-04-16 implementation plan for F1 + kill switch (on `plan/f1-stage-buckets` branch)
- `finance-phase-2-3-roadmap.md` — NEW 2026-04-16, captures Phase 2/3 keepers
- `bedrock-ui-improvements.md` — active UI polish backlog (extended with S6, M8, M9, M10 from archived PR plans)
- `lessons.md` — living pattern library
- `todo.md` — master session tracker (PR plan links stripped)
- `crm-duplicate-detection-plan.md` — detailed plan, unstarted
- `serper-integration-sprint.md` — unstarted (critical — blocks Pebble web search quality)
- `spec-identity-consolidation.md` — Phase B-3 backfill pending
- `sprint-backlog-sf-audit.md` — small unstarted audit
- `sprint9-activities-extension-plan.md` — M13 + M15 sessions pending
- `sprint11-pebble-persistence-crm.md` — partial (tables shipped, functions not wired)
- `sprint12-pebble-access-control.md` — partial (use_pebble_research permission not added)
- `sprint13-sf-audit-ux-polish.md` — pending
- `session5-pebble-output-metadata-plan.md` — approved spec, not yet shipped
- `projects-salesforce-roadmap.md` — unstarted
- `prs/pheromone-circuit-breaker-plan.md` — detailed plan, unstarted

## Keeper migrations at a glance

- **`tasks/finance-phase-2-3-roadmap.md`** (new) — Phase 2 (multi-invoice, smart completion, amendments, enhanced validations, variance handling) + Phase 3 (Sage payment sync, advanced reporting, workflow automation, error recovery, concurrency control) sections extracted verbatim from `docs/implementation-plan.md`.
- **`docs/architecture-decisions.md`** (appended) — Sprint 4 Rescoping section with 4 decisions: same Haiku agent for reads+writes, conversational approval, org intelligence timing (T3 auto / T2 user-triggered), 990 XML rate-limit handling. Also updated §8 + §9 status from "Design approved, implementation pending" to "Shipped in PR #50 + Sprint 3.5 / Sprint 4.5".
- **`tasks/bedrock-ui-improvements.md`** (appended) — S6 (favicon PNGs from PR 10), M8 (calendar overlap detection from PR 5), M9 (task backend persistence from PR 6), M10 (Pipeline Cleanup Tool from `tasks/todo.md` Future Considerations).
- **`tasks/todo.md`** (modified) — ship-order table PR links stripped (no longer point to valid paths); note added pointing to archive + keeper destinations.
- **`tasks/lessons.md`** (modified) — empty 2026-03-17 "No lessons recorded yet" placeholder removed.

## Context

See `tasks/stage-schema-drift.md` + `tasks/f1-stage-buckets-plan.md` for the 2026-04-16 findings that motivated the broader cleanup (22-stage SF drift, Donorbox integration discovery, bucket-vocabulary reframe).
