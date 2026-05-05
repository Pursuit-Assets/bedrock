# Bedrock Redesign — Data Model Plan

> Status: Draft for review | Date: 2026-04-30 | Branch: `claude/bedrock-redesign`
>
> Scope: data model changes required by the Bedrock UI redesign (Linear/Attio
> aesthetic, 7-page nav, Awards as a first-class concept). UI work follows in a
> separate plan doc once this is signed off.
>
> Companion: `product/crm-architecture/entity-map.md` — Award entity will be
> added there post-merge.

---

## 1. Goal

Introduce **Award** as a thin lifecycle entity layered over closed-won
Philanthropy Opportunities, so the redesign can present a clean post-award
management surface (status, period, payment progress, linked project, tasks)
without polluting Opportunity (SF SoT) and without introducing a fourth task
system.

Net new tables: **1** (`bedrock.award`).
Net new columns on existing tables: **1** (`activity.award_id`, optional).
Net new Postgres triggers: **0** (auto-create handled in backend code).

---

## 2. In Scope (this plan)

- New `bedrock.award` table (1:1 with closed-won Philanthropy Opp).
- One-time backfill for all currently-won Philanthropy Opps.
- Auto-create handler in the existing CRM-bridge write path.
- Optional `award_id` column on the existing activity table.
- Updates to canonical docs (`entity-map.md`, `database-schema.md`).

## 3. Out of Scope (deferred — see §10)

- PBC contract requirements / contract-side awards.
- `compliance_status` on Award.
- Bedrock-side account intelligence storage (tier, score, enriched flag).
- A `withdrawn` opportunity stage (canonical stays at 7 stages).
- Any net-new task table. Tasks for awards are queries, not rows (see §8).

---

## 4. Schema Changes

### 4.1 New table: `bedrock.award`

```sql
-- Migration: financial_forecasting/db/migrations/YYYY-MM-DD-add-award-table.sql
-- Idempotent DDL (matches conventions in docs/database-schema.md §8)

CREATE TABLE IF NOT EXISTS bedrock.award (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    opportunity_id  TEXT NOT NULL,                 -- SF Opportunity.Id (18-char)
    award_status    TEXT NOT NULL DEFAULT 'Active'
                    CHECK (award_status IN ('Active', 'Closing', 'Closed')),
    award_date      DATE,                          -- when opp transitioned to closed-won
    period_end_date DATE,                          -- mirrors GrantRequirements.grant_end_date
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    deleted_by      TEXT
);

-- Enforce 1:1 with Opp (excluding soft-deleted rows)
CREATE UNIQUE INDEX IF NOT EXISTS uq_award_opp_active
    ON bedrock.award(opportunity_id)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_award_not_deleted
    ON bedrock.award(id)
    WHERE deleted_at IS NULL;

-- updated_at trigger (uses existing bedrock.set_updated_at() helper)
CREATE TRIGGER trg_award_updated_at
    BEFORE UPDATE ON bedrock.award
    FOR EACH ROW EXECUTE FUNCTION bedrock.set_updated_at();
```

**Down migration**: `DROP TABLE bedrock.award;` (idempotent guard on its own).

### 4.2 Add `award_id` to activity table (additive)

```sql
ALTER TABLE bedrock.activity
    ADD COLUMN IF NOT EXISTS award_id UUID
    REFERENCES bedrock.award(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_award
    ON bedrock.activity(award_id)
    WHERE award_id IS NOT NULL;
```

No constraint that exactly one of `(opportunity_id | contact_id | prospect_id |
award_id)` is set — matches today's permissive shape.

### 4.3 No changes to

- Opportunity (SF SoT, untouched).
- `bedrock.project`, `workstream`, `milestone`, `project_task` (existing
  hierarchy stays as-is per JP).
- `project_opportunity` junction (carries the Project ↔ Opp link that the
  redesign reads as Project ↔ Award transitively — see §7).
- Salesforce Task model (no `award_id` push to SF).

---

## 5. Backfill — Philanthropy only

### 5.1 Target SOQL

Pull all Opportunities meeting both criteria:

```sql
-- Pseudocode; run via existing salesforce_search service
SELECT Id, Name, AccountId, RecordType.Name, StageName,
       CloseDate, LastModifiedDate, /* + any history fields available */
FROM Opportunity
WHERE RecordType.Name = 'Philanthropy'        -- per JP: Philanthropy only
  AND StageName IN (
      'Closed Won',                           -- 575 rows in current SF (per canonical-definitions.md §1)
      'Closed / Fulfilled',                   -- 5 rows (TBD which program — flag)
      'Collecting',                           -- if present (legacy "money in flight")
      'In Effect'                             -- if present (legacy "active grant")
  )
  AND IsDeleted = false
```

**Open verification step before running**: confirm exact stage values currently
in SF for Philanthropy record type. The canonical-definitions §1 lists 22 live
stage values across all record types; we want the subset that applies to
Philanthropy. Will verify with a `SELECT StageName, COUNT(Id) FROM Opportunity
WHERE RecordType.Name = 'Philanthropy' GROUP BY StageName` before write.

**Explicitly excluded** from backfill:
- Non-Philanthropy record types (PBC, ISA / Pursuit Bond, etc.).
- `In Collection` (650 ISA legacy rows — out of scope per
  `canonical-definitions.md` §1).
- Deleted opps.

### 5.2 Insert shape

```python
# Per row from SF query:
{
    "opportunity_id": opp.Id,
    "award_status": (
        "Closed" if opp.StageName in ("Closed / Fulfilled",) else "Active"
    ),
    "award_date": opp.CloseDate,                  # CloseDate as award_date proxy
    "period_end_date": grant_req.grant_end_date   # JOIN to GrantRequirements
                       if exists else None,        # if no GR row, leave NULL
    "notes": "Backfilled YYYY-MM-DD from SF stage=" + opp.StageName,
}
```

If we have access to SF stage history, prefer the timestamp of the transition
into `Closed Won` over `CloseDate`; otherwise `CloseDate` is acceptable.

### 5.3 Backfill script location

`financial_forecasting/scripts/backfill_awards.py` — one-shot, idempotent
(uses `INSERT ... ON CONFLICT (opportunity_id) WHERE deleted_at IS NULL DO
NOTHING`). Logs row counts (eligible, inserted, skipped).

### 5.4 Dry-run + verification

1. Dry-run against staging Postgres: counts only, no writes.
2. Spot-check 10 known awards (Robin Hood Foundation Power Fund, JPMC
   apprenticeship, etc.) appear with correct `award_date`.
3. Verify no PBC/ISA opps were touched.
4. Production run only after JP signs off on the dry-run report.

---

## 6. Auto-create handler

### 6.1 Trigger point

When an Opp.stage transitions into `closed-won` AND `RecordType.Name ==
'Philanthropy'`, ensure a `bedrock.award` row exists.

### 6.2 Implementation location

Backend handler in the existing CRM-bridge path that writes Opp updates back
from Bedrock to Salesforce. Specifically: after the SF write succeeds and
returns the new stage, call `awards_service.ensure_for_opp(opp_id)`.

We do **not** use a Postgres trigger — Opp lives in SF, not Postgres, so a
trigger has nothing to fire on. Sync direction is SF → Bedrock (read).

### 6.3 Idempotency

`ensure_for_opp(opp_id)` is `INSERT ... ON CONFLICT DO NOTHING`. Safe to call
on every closed-won transition or sync poll.

### 6.4 Edge cases

- **Stage moves back** (closed-won → in-negotiation): leave the award row in
  place with status='Active'. Manual cleanup if it becomes a real workflow
  (rare). Don't soft-delete on stage regression.
- **Stage moves to closed-lost** after closed-won: same — leave award row.
  This is a rare retroactive change; ops can manually soft-delete.
- **Multiple closed-won transitions over time**: idempotent — only one row
  ever exists per opp.

---

## 7. Linking Awards to Projects (UI semantics)

**No new column.** Award ↔ Project is transitive through Opp:

```
Award (1:1 opp_id) ←→ Opportunity ←→ project_opportunity (M:N) ←→ Project
```

In the redesign UI, an Award detail page resolves its linked Project(s) by:

```sql
SELECT p.*
FROM bedrock.project p
JOIN bedrock.project_opportunity po ON po.project_id = p.id
WHERE po.opportunity_id = (SELECT opportunity_id FROM bedrock.award WHERE id = $1)
  AND p.deleted_at IS NULL;
```

The mockup shows a 1:1 visual ("Project: PACE Bedrock Y1") but the underlying
M:N junction allows multiple projects to be tied to a single opp/award.
Display either (a) the most-recently-updated project, with a "+N more" if
multiple, or (b) all in a list. Decide in the UI plan doc.

**Creating a project from an Award page** writes a new `project` row + a
`project_opportunity` row tying it to the Award's underlying opp.

---

## 8. Tasks for Awards (no new table)

Per the discussion: don't introduce a fourth task system. Award tasks are a
**query** that unions:

1. **SF Tasks** where `WhatId = award.opportunity_id` **AND
   `CreatedDate >= award.award_date`**.
2. **`bedrock.project_task`** entries inside any milestone of any project
   linked to the award's opp (transitive via `project_opportunity`)
   **AND `created_at >= award.award_date`**.

**The `award_date` cutoff is load-bearing.** Tasks created during the
pipeline phase (pre-award) belong to the Opportunity record, not the Award
record. The Opp detail page still shows them; the Award detail page does
not. This keeps the Award UI focused on post-award management.

If `award.award_date IS NULL` (rare — a backfilled award where we couldn't
determine the transition date), fall back to `award.created_at` so the
Award page still shows something coherent.

Creating a task from an Award detail page:

- **If Award has ≥1 linked Project**: create a `project_task` under a
  default milestone of the (most recently active) linked project. Backend
  creates an "Award management" milestone if none exists.
- **If Award has no linked Project**: create an SF Task with `WhatId =
  award.opportunity_id`.

This keeps SF as the SoT for CRM-flavor tasks and Bedrock as the SoT for
execution-flavor (Gantt-y) tasks, without introducing a third writable store.

The redesign's global Tasks page does the same union, filtered to the
authenticated user.

---

## 9. Canonical doc updates (after migration lands)

- `product/crm-architecture/entity-map.md` — add Award as entity #12.
- `product/crm-architecture/canonical-definitions.md` — add `award_status`
  enum to §6 (Entity Status Enums).
- `docs/database-schema.md` — add `bedrock.award` row to the table
  reference (Domain A or new Domain H — recommend Domain A: Project
  Management, since awards live alongside projects in usage).

These changes are **doc-only** and ship in the same PR as the migration so
the docs don't drift.

---

## 10. PBC follow-up checklist (deferred)

When PBC support is added back:

- [ ] Add `contract_requirements` table parallel to `grant_requirements`, or
      generalize via `requirements` superclass with `revenue_stream`
      discriminator.
- [ ] Backfill awards for PBC RecordTypes (`Closed / Full-Time or Successful
      Conversion` etc.) — consult JP on which stages count.
- [ ] Add `compliance_status` to Award (vocabulary differs grants vs.
      contracts).
- [ ] Decide whether `period_end_date` semantics are identical for PBC
      (probably yes — contract end date).
- [ ] Update auto-create handler to widen the RecordType filter beyond
      `Philanthropy`.

## 11. Account intelligence follow-up (deferred)

The redesign shows `tier`, `score`, `enriched` on Account. For now these are
derived from Pebble's existing prospect-intelligence layer (no new columns).
JP flagged: "we might need to re-do bedrock" — interpret as: defer
Bedrock-side `account_intelligence` storage decision until the broader Pebble
re-architecture clarifies.

---

## 12. Risks

1. **SF stage drift.** Live SF has 22 distinct stage values; canonical has 7.
   Backfill is keyed on stage name strings. If JP renames stages in SF
   (mentioned as possible), backfill query and auto-create handler must
   update. Mitigation: centralize the "what counts as a closed-won
   philanthropy stage" set as one constant in `awards_service`.

2. **Project ↔ Award is M:N transitively but presented as 1:1.** Users
   may create a second project linked to the same opp and be confused which
   one shows on the Award page. Mitigation: pick a deterministic display
   rule (most-recently-updated) and surface "+N more" when multiple exist.
   Document in UI plan.

3. **`award_date` proxy from `CloseDate`.** Not always the actual transition
   date. Acceptable for backfill; not load-bearing for any business logic
   yet. If a future report requires the true transition date, pull from SF
   stage history.

4. **Task "creation routing" is implicit.** A user creating a task from an
   Award page won't necessarily know whether their task landed in
   `project_task` or SF Task. Mitigation: surface the destination in the
   create-task dialog ("This task will be added to project: X" vs. "This
   task will be added to Salesforce, linked to opportunity Y").

5. **Activity polymorphism is unconstrained.** Adding `award_id` without a
   "exactly one of" CHECK matches existing pattern but means activities can
   have ambiguous parentage. Mitigation: none for now (matches precedent);
   revisit if reporting suffers.

---

## 13. Verification before "done"

- [ ] Migration up + down round-trip cleanly on a fresh DB.
- [ ] Backfill dry-run produces a row count that matches an independent
      SOQL count of `RecordType.Name='Philanthropy' AND StageName IN
      (allowlist)`.
- [ ] Spot-check: at least 5 known awards (RHF Power Fund, JPMC
      apprenticeship, Bloomberg Civic, Google AI, Microsoft Skills) appear
      with sensible `award_date` and `period_end_date` (where GR exists).
- [ ] Auto-create handler unit-tested: closed-won transition on
      Philanthropy opp creates exactly one award; on PBC/ISA does not;
      idempotent on repeated calls.
- [ ] Project ↔ Award resolution query returns expected projects for at
      least one award with linked project (RHF) and one without.
- [ ] Activity table accepts `award_id` writes; existing activity reads
      unaffected.

---

## 14. Open items needing JP confirmation before write

1. Exact set of Philanthropy-applicable closed/active stage names — verify
   via `SELECT StageName, COUNT(Id) FROM Opportunity WHERE
   RecordType.Name='Philanthropy' GROUP BY StageName`. Will run before
   committing the backfill script.

2. Project↔Award display rule when multiple projects link to one opp:
   most-recently-updated singleton with "+N more", or list all? (My
   recommendation: singleton + "+N more" for cleanliness; full list on a
   sub-tab.)

3. `period_end_date` for awards lacking a `GrantRequirements` row — leave
   NULL, or fall back to `award_date + N years` heuristic? (My
   recommendation: NULL; show "—" in UI; user can edit.)

---

## 15. Sequence

1. JP signs off on this plan + answers §14 open items.
2. Run verification SOQL for §14.1.
3. Write migration + backfill script + auto-create handler in one PR.
4. Migration applies on staging; backfill dry-run; review counts.
5. Production migration + production backfill.
6. Doc updates (§9) ship with the PR.
7. Move to UI plan doc (`tasks/bedrock-redesign-ui-plan.md`).

---

*Companion docs after this lands: `tasks/bedrock-redesign-ui-plan.md`
(frontend-v2 scaffold, route map, screen-by-screen build order).*
