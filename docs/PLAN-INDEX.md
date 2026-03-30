# Sprint & Milestone Index

Master index of all planned and completed milestones. Unique numbering — no duplicates, no ambiguity.

**Last completed:** M17 Session 1 (SF Audit + Prospect CRM Schema, 2026-03-30)
**Last shipped:** M18 (Project Soft-Delete, 2026-03-30)

---

## Execution Order & Dependencies

```
M9  ✅  Schema Qualification
M10 ✅  Activities Foundation (backend)
M11 ✅  Pebble PostgreSQL Migration
M12 ✅  Pebble Access Control
M18 ✅  Project Soft-Delete
 │
 ├──► M13 (Activities Timeline)  ──┐
 │    Session 1: Timeline component │
 │    Session 2: Detail modals      ├──► M16 (Integration + QA)
 ├──► M15 (Chrome Extension) ──────┘    (wiring + regression)
 │    Session 1: Manifest + scripts
 │    Session 2: Popup + flows
 ├──► M17 (SF Audit + Prospect CRM)   ← 3 sessions, absorbs M14
 │    Session 1: Schema + validation + storage ✅
 │    Session 2: T1-T3 pipeline + persistence
 │    Session 3: Drift detection + integration test
 └──► M19 (Project Ownership)         ← 1 session, deferred from M8
```

**M13 and M15 are unblocked** and can run in parallel (both depend only on M10 ✅). M16 depends on both M13 + M15. **M14 has been absorbed into M17** — the SF describe() audit resolved the field definition blocker.

---

## Open (actionable)

| Milestone | Plan File | Depends On | Size | Status | Summary |
|-----------|-----------|------------|------|--------|---------|
| **M13: Activities Timeline + Modals** | `tasks/sprint9-activities-extension-plan.md` (9B section) | M10 ✅ | L (2 sessions) | Ready | **Session 1**: Activity TS types + API methods + ActivityTimeline component. **Session 2**: OpportunityDetailModal + ContactDetailModal + page wiring. |
| ~~M14: Pebble Persistence + CRM Bridge~~ | `tasks/sprint11-pebble-persistence-crm.md` | M11 ✅ | — | **Absorbed into M17** | Conflict log, scratchpad, CRM bridge updates moved to M17 Sessions 2-3. |
| **M15: Activities Chrome Extension** | `tasks/sprint9-activities-extension-plan.md` (9C section) | M10 ✅ | L (2 sessions) | Ready | **Session 1**: Manifest V3 + service worker + content scripts + API client. **Session 2**: Popup UI + OppPicker + CascadeFlow + testing. Parallel with M13 (no frontend dependency). |
| **M16: Activities Integration + QA** | `tasks/sprint9-activities-extension-plan.md` (9D section) | M13 + M15 | S (1 session) | Planned | Wire modals into pages, global search, full regression. Worktree for safety. |
| **M17: SF Audit + Prospect CRM Mapping** | `tasks/sprint13-sf-audit-ux-polish.md` | M12 ✅ | L (3 sessions, absorbs M14) | **Session 1 complete** | SF describe() audit, prospect_sf_* typed tables, sf_field_requirements, schema drift detection, frontend validation, T1-T3 population pipeline, CRM bridge updates. Plan: `.claude/plans/effervescent-coalescing-marble.md`. |
| **M19: Project Ownership Model** | (plan needed) | M18 ✅ | S-M | Planned | owner_email + contributors, owner-only delete. Deferred from M8 scope. |
| Bedrock UI Improvements | `tasks/bedrock-ui-improvements.md` | Nothing | Ongoing | Mixed | 5 small, 7 medium, 3 large. Parallel with all tracks. |
| Google OAuth Setup | (in .cursor/plans/) | Nothing | S | Partially done | FRONTEND_URL env, OAUTH_SPRINT_CHECKLIST, redirect fix. |

### Blocked Items (external dependency)

| Item | Plan File | Blocked On |
|------|-----------|------------|
| Serper Integration | `tasks/serper-integration-sprint.md` | Serper.dev API key not configured |
| OpenCorporates Data | (tracked in `tasks/todo.md`) | OpenCorporates API key not obtained |
| ~~M14: Pebble Persistence~~ | `tasks/sprint11-pebble-persistence-crm.md` | **Resolved** — absorbed into M17; describe() audit provided field definitions |

---

## Completed

| Milestone | Date |
|-----------|------|
| M1: Production-Grade Security MVP | 2026-03-18 |
| M2: MVP Performance Pass | |
| M3: Bedrock Rollout and Pebble Alignment | |
| Bedrock PR Roadmap (PRs 1-10) | 2026-03-20 |
| Funnel Polish and AI | |
| Funnel Visual Redesign | |
| Calendar Layout Simplification | |
| Dashboard and Backend Plan | |
| Pipeline Scenario Cards | |
| Revenue vs Cashflow Layout | |
| Notification Bell Dropdown | |
| Stage B Sprint 1 — LDA/FINRA/affiliation | |
| M6: Agentic alignment + test coverage | |
| M7: Opportunity edit dialog + permissions | |
| M7.5: SF field audit + NPSP payment summary | |
| M8: Multi-object editing (Account, Contact, Payment) | 2026-03-26 |
| M8 Delete-Safety Planning | 2026-03-26 |
| M9: Schema Qualification — 23 tables deployed to segundo-db | 2026-03-27 |
| M10: Activities Foundation — backend-only, 11 endpoints, SF sync | 2026-03-29 |
| M12: Pebble Access Control — RBAC, cost limits, budget chip | 2026-03-29 |
| M11: Pebble PostgreSQL Migration — SQLite → asyncpg/psycopg2 | 2026-03-30 |
| M18: Project Soft-Delete — cascade soft-delete, trash UI, restore & purge | 2026-03-30 |

## Superseded

| Plan | Superseded By |
|------|---------------|
| Funnel Net Indicator Polish | Funnel Polish and AI |
| Sprint 7 — UX polish (original Pebble roadmap) | M7 became Opportunity edit dialog; UX items → M17 |
| Sprint 8 — Team enablement (original Pebble roadmap) | M8 became multi-object editing; team items → M12 |

## Old Sprint → New Milestone Mapping

For reference, the old sprint names map to:

| Old Name | New Milestone |
|----------|---------------|
| Sprint 9 — Schema qualification (Track A) | **M9** |
| Sprint 9A — Activities Foundation (Track D) | **M10** |
| Sprint 9B — Activities Timeline (Track D) | **M13** |
| Sprint 9C — Activities Extension (Track D) | **M15** |
| Sprint 9D — Activities Integration (Track D) | **M16** |
| Sprint 10 — Pebble PostgreSQL (Track A) | **M11** |
| Sprint 11 — Pebble Persistence (Track A) | **M14** |
| Sprint 12 — Pebble Access Control (Track B) | **M12** |
| Sprint 13 — SF Audit + UX (Track B) | **M17** |
| (new) Project Soft-Delete | **M18** |
| (new) Project Ownership Model | **M19** |

## Reference (strategic, no implementation)

| Plan |
|-----|
| Pebble Bedrock Integration Architecture |
| Pebble PRD Review and Team Prompt |
| CRM Duplicate Detection (`tasks/crm-duplicate-detection-plan.md`) — ready when needed |
