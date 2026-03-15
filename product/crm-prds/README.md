# Pursuit CRM (Bedrock) — PRD Index

> Phase 6 Deliverable | Version: 1.0 | Date: 2026-03-15
>
> Each PRD covers one logical component of the system. PRDs follow the template in this file.
> All PRDs reference the architecture docs in `product/crm-architecture/`.

---

## PRD Breakdown

| PRD | Scope | Phase | Features Covered | Status |
|-----|-------|-------|-----------------|--------|
| **01 — Data Model** | Full schema, all entities, all relationships, nonprofit/PBC separation, ID patterns, migration path | MVP | Foundation for all features | Draft (see `entity-map.md`) |
| **02 — Account & Contact Management** | CRUD, search, org hierarchy, Contact↔Account many-to-many, dedup | MVP | F03, F04, F44 | Not started |
| **03 — Opportunity Management** | Lifecycle, stages, pipeline views, stale detection, nonprofit vs. PBC | MVP | F01, F02, F05, F06, F07 | Not started |
| **04 — Payments & Revenue Tracking** | Payment recording, schedules, Opportunity linkage, status tracking, reconciliation fields | Post-MVP | F27, F28, F31 | Not started |
| **05 — Campaign Management** | Campaign CRUD, Campaign↔Opportunity linkage, attribution reporting | Post-MVP | F32, F33, F23 | Not started |
| **06 — Reporting & Cash Flow** | Executive dashboard, cash flow projection, revenue by stream, win rate, CSV export | MVP | F19, F20, F21, F22, F24, F25, F26 | Not started |
| **07 — Sage Integration** | Data contract, invoice push, payment pull, reconciliation sync, error handling | Post-MVP | F29, F30, F39 | Not started |
| **08 — User Roles & Permissions** | Role definitions, visibility rules, access control | MVP | F42, F43 | Not started |
| **09 — Salesforce Migration & Sync** | Initial data import, field mapping, transformation rules, validation, ongoing bidirectional sync | MVP | F38, F40, F45 | Partially exists (sync code in `data_sync.py`) |
| **10 — Weekly Priorities & Tasks** | Weekly view, task CRUD, CSV import, prospect↔grant assignment, notifications | MVP | F09, F10, F11, F12, F13 | Week 1 prototype in progress |
| **11 — Lead & Prospect Intelligence** | Lead tracker, conversion, network search, scoring, AI enrichment | Post-MVP | F14, F15, F16, F17, F18 | Not started |
| **12 — Activity & Interaction Logging** | Manual logging, Slack ingest, timeline view, transcript pipeline | MVP (manual) / Post-MVP (Slack) | F34, F35, F36, F37 | MCP Client exists for Slack |

---

## Suggested Authoring Order

1. **PRD 01 — Data Model** (foundation; already substantially drafted in `entity-map.md`)
2. **PRD 10 — Weekly Priorities & Tasks** (current week-1 prototype; ship first)
3. **PRD 03 — Opportunity Management** (core pipeline; most features depend on this)
4. **PRD 02 — Account & Contact Management** (prerequisite for Opportunities)
5. **PRD 09 — Salesforce Migration & Sync** (unblocks real data)
6. **PRD 06 — Reporting & Cash Flow** (CEO visibility — high-value)
7. **PRD 08 — User Roles & Permissions** (needed before multi-user rollout)
8. **PRD 12 — Activity & Interaction Logging** (manual logging is MVP; Slack is post-MVP)
9. **PRD 04 — Payments & Revenue Tracking** (Phase 2 gated on Sage)
10. **PRD 07 — Sage Integration** (Phase 2)
11. **PRD 05 — Campaign Management** (post-MVP)
12. **PRD 11 — Lead & Prospect Intelligence** (post-MVP)

---

## PRD Template

Every PRD follows this structure. Copy and fill in.

```markdown
# PRD — [Component Name]

> Version: 0.1 | Status: Draft | Date: YYYY-MM-DD
> Author: [name]

---

## Purpose

One paragraph: what problem does this component solve and for whom?

---

## Scope

**In scope:**
- ...

**Out of scope:**
- ...

---

## User Stories

- As a [role], I need to [do something] so that [outcome].
- ...

---

## Data Requirements

Entities touched, fields needed, relationships assumed.
Reference: `product/crm-architecture/entity-map.md`

---

## Functional Requirements

1. The system must ...
2. The system must ...
3. ...

---

## Non-Functional Requirements

- **Performance:** ...
- **Security:** ...
- **Reliability:** ...
- **Scale limits:** ...

---

## Integration Dependencies

What other PRDs or systems must exist first?

| Dependency | Type | Notes |
|-----------|------|-------|
| PRD XX | Hard / Soft | ... |

---

## Open Questions

Decisions not yet made. Resolve before development starts.

1. ...
2. ...

---

## Acceptance Criteria

How do we know this is done and working?

### Positive scenarios
- Given [context], when [action], then [expected result].

### Negative scenarios
- Given [context], when [invalid action], then [expected error handling].

### Data invariants
- [Invariant that must always hold true]
```

---

## Cross-References

| Document | Location | Relationship |
|----------|----------|-------------|
| Scope Constitution | `product/crm-scope-constitution.md` | Every PRD must trace to core jobs |
| Entity Map | `product/crm-architecture/entity-map.md` | Data model reference |
| User Journey Matrix | `product/crm-architecture/user-journey-matrix.md` | User stories derive from journeys |
| Information Flows | `product/crm-architecture/information-flows.md` | Integration points and data flow |
| Integration Register | `product/crm-architecture/integration-register.md` | External system contracts |
| Feature Register | `product/crm-architecture/feature-register.md` | Feature-to-PRD mapping |
| Requirements Gaps | `product/REQUIREMENTS-GAPS-AND-STRUCTURE.md` | Open questions to resolve |
