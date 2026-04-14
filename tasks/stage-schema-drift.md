# Opportunity Stage Schema Drift — pending glossary + fixes

**Status:** Discovered 2026-04-14 during the adversarial-review follow-up pass. Three fixes (F1, F2, F3) are gated on this note getting resolved.

## The finding

A live SOQL query against Pursuit's Salesforce org (via Developer Console, 2026-04-14):

```sql
SELECT StageName, COUNT(Id) cnt FROM Opportunity GROUP BY StageName ORDER BY COUNT(Id) DESC
```

returned **22 distinct stage values**. The canonical frontend enum
`frontend/src/types/salesforce.ts:OPPORTUNITY_STAGES` and the Python enum
`financial_forecasting/models.py:OpportunityStage` both declare **13**.
Alignment is asserted by `frontend/src/types/salesforce.test.ts:40`,
but that only proves the two declarations match each other — not that
either matches reality.

## Live stage counts (2026-04-14)

| Stage | Count | In enum? | Notes |
|---|---|---|---|
| Closed / Completed | 1,923 | ✅ | **Won and paid fully** (JP 2026-04-14) |
| Closed Lost | 1,206 | ✅ | Lost |
| Withdrawn | 1,167 | ✅ | Lost |
| In Collection | 650 | ❌ | Likely a legacy / alternate collecting stage; function TBD |
| Closed Won | 575 | ❌ | Legacy won terminal; still live |
| Lead Gen | 192 | ✅ | Active |
| New Lead | 183 | ✅ | Active |
| Qualifying | 131 | ✅ | Active |
| Close/Unknown | 68 | ❌ | Dirty data; TBD whether to migrate or leave |
| Design / Proposal Creation | 54 | ✅ | Active |
| Proposal Negotiation | 50 | ✅ | Active |
| Collecting / In Effect | 47 | ✅ | **Won, under contract, being paid over time** (JP 2026-04-14) |
| Closed / Did not Fulfill | 46 | ✅ | Lost |
| Closed / Full-Time or Successful Conversion | 14 | ❌ | PBC success variant |
| Contract Creation | 7 | ✅ | Active |
| Negotiating Contract | 7 | ✅ | Active |
| Closed / Temporary Hire | 5 | ❌ | PBC success variant |
| Closed / Fulfilled | 5 | ❌ | Probably success; TBD |
| Closed / Contract or Agreement But No Fellows Hired | 4 | ❌ | Closed without revenue — probably lost, not won |
| Contract Signing | 3 | ❌ | Active, pre-close |
| Closed / Sourcing | 2 | ❌ | TBD — name suggests active, not closed |
| Verbal Commitment | 1 | ❌ | Active, late-funnel |

**Totals:** 22 distinct stages in live data. 9 of them not in either enum.

## Glossary definitions confirmed so far (JP, 2026-04-14)

- **`Closed / Completed`** — won and got paid fully.
- **`Collecting / In Effect`** — won, have a contract, and are in the process of being paid (potentially multiple payments across the grant period).

These two are "the good ones" for revenue purposes. The PBC-flavored success
stages (`Closed / Full-Time or Successful Conversion`, `Closed / Temporary
Hire`, etc.) should be labeled as a separate category when we sit down with
the fundraising team to define the full glossary.

## What this breaks in the current codebase

### B1 — Funnel classifier silently misclassifies 575+ wins as setbacks
**Where:** `financial_forecasting/frontend/src/components/pipelineFunnelTransitions.ts:WON_STAGES`

Currently `WON_STAGES = ['Closed / Completed']`. Transitions INTO `Closed Won`
fall through to the `ti > fi ? 'forward' : 'backward'` branch and — since
`Closed Won` isn't in `STAGE_IDX` either — return `'backward'`. Every
historical Closed Won transition currently renders as a red setback on
the funnel. Same for the PBC success variants.

PR #105 was specifically meant to fix this bucket-routing bug for wins.
The fix was correct for `Closed / Completed` but blind to the 575
`Closed Won` records and the ~30 PBC success variants.

### B2 — Sage Intacct auto-invoicing skips 77% of eligible opps
**Where:** `financial_forecasting/data_sync.py:565, 916`

Both references query / check for `StageName = 'Closed Won'` exactly. With
575 matching records vs 1,923 `Closed / Completed`, the trigger fires for
~23% of deals Pursuit has actually won. The other 1,923 closed-and-paid opps
never get an Intacct invoice draft created.

(Whether every `Closed / Completed` opp *should* trigger an Intacct invoice
is a separate finance-process question. Maybe only a subset. That decision
goes into the glossary too.)

### B3 — Type lies: `opp.StageName: OpportunityStage` admits invalid values
**Where:** `frontend/src/types/salesforce.ts:SalesforceOpportunity.StageName`

The field is typed as the tight union `OpportunityStage` (13 values), but
real records carry values outside that union (`'In Collection'`,
`'Closed Won'`, `'Verbal Commitment'`, etc.). TypeScript happily narrows
assuming invalid values can't appear, which hides branches. Any code like
`if (opp.StageName === 'Closed Won')` is type-errored out even though
that stage is real.

## Deferred fixes (not shipping in this PR)

### F1 — Expand `WON_STAGES` + `LOST_STAGES` in `types/salesforce.ts`
Change from `readonly OpportunityStage[]` to `Set<string>` (to admit values
outside the tight union) and add:

- `WON_STAGES`: `Closed / Completed`, `Closed Won` **at minimum**. After
  glossary: probably also the PBC success variants as a labeled subset
  (`WON_STAGES_PBC` or similar).
- Maybe add `REVENUE_EARNING_STAGES = WON_STAGES ∪ ['Collecting / In Effect', 'In Collection']`
  for dashboards that want "we got or are getting the money" as one bucket.

Depends on: glossary decisions on PBC variants + `In Collection` semantics.

### F2 — `data_sync.py` Intacct invoicing: query all won-equivalent stages
Replace:
```python
WHERE StageName = 'Closed Won'
```
with (minimum):
```python
WHERE StageName IN ('Closed Won', 'Closed / Completed')
```

After glossary: probably also the PBC variants that produce billable revenue.
The event handler at `data_sync.py:916` (`handle_opportunity_stage_change`)
needs the matching expansion.

Depends on: confirming with finance which stages should trigger an invoice.

### F3 — Sync `OPPORTUNITY_STAGES` to the live picklist
Add the 9 missing stages to `OPPORTUNITY_STAGES` in `types/salesforce.ts`,
to `OpportunityStage` in `models.py`, and update `salesforce.test.ts` to
match. This is the larger refactor — changes the typed union, affects
picklist dropdowns (`PipelineFilterBar`, `StageCell`, `OpportunityEditDialog`),
and will surface currently-hidden branches.

Decision needed: do we include legacy values like `Closed Won`, `In Collection`,
`Close/Unknown` in the dropdowns at all, or mark them display-only
(filter out from the editor UI, keep in the type union)? Leaning toward
a `LEGACY_STAGES` label that excludes them from the editor but keeps them
visible on existing records.

Depends on: F1 landing first, plus a call on how to surface legacy values
in the edit UI.

## Glossary location (long-term)

The stage definitions + this taxonomy should land in:

- **Primary:** `product/ONBOARDINGPRD.md` (the onboarding PRD that defines
  roles, permissions, day-by-day onboarding for RM / Executive / PM profiles).
  Add a "CRM Glossary" section covering Opportunity stages, Lead statuses,
  Project phases, Task priorities, and any domain jargon (AIJI, Builders, PBC).
- **Companion:** `product/ONBOARDING-ADDENDUM.md` (the exhaustive companion
  doc). Flag from there with a link; the detailed table lives in
  ONBOARDINGPRD.

Both files already exist; this will be a new section rather than a new file.

## What shipped in the PR that prompted this note

The adversarial-review-followups PR (16 fixes — C2/C3/C4, H1–H7, M1 partial,
M2, M3, M5) intentionally **does not** touch B1, B2, B3, F1, F2, or F3. Those
are pre-existing and deserve their own review cycle with the glossary. The
shipped M1 lifted `WON_STAGES` / `LOST_STAGES` into `types/salesforce.ts`
from `pipelineFunnelTransitions.ts` — that move is safe because the values
are unchanged; it just puts the right symbol in the right file for F1 to
land cleanly later.

Overview.tsx, PaymentProcessing.tsx, and Accounts.tsx retain their
defensive `.includes('Closed Won')` substring matching. That was the
right call — 575 live records prove it's load-bearing.

## Next steps (in order)

1. **Glossary conversation** (JP + fundraising team) — classify the 9
   missing stages as won / lost / active / revenue-earning / legacy.
2. **Add the CRM Glossary section** to `product/ONBOARDINGPRD.md`.
3. **F3** (enum sync) — this is the enabler. One PR.
4. **F1 + F2** (funnel + data_sync) — one PR each, can be parallel.
5. **Backfill test**: once `OPPORTUNITY_STAGES` matches reality, add a
   runtime assertion or data-migration helper that flags any new stage
   values that appear in production data but aren't in the enum. Prevents
   the drift from re-occurring silently.
