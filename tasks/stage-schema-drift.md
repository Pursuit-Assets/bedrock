# Opportunity Stage Schema Drift — findings + bucket-based fixes

**Status:** Discovered 2026-04-14 during the adversarial-review follow-up pass. Further resolved 2026-04-16 via SOQL investigation. Active implementation plan: `tasks/f1-stage-buckets-plan.md`.

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
| In Collection | 650 | ❌ | **ISA RecordType, 2019–2020 Pursuit Bond legacy — out of philanthropy scope** (confirmed 2026-04-16) |
| Closed Won | 575 | ❌ | **Donorbox-auto-populated philanthropy donations, 2019→2026-04-04 actively flowing** (confirmed 2026-04-16) |
| Lead Gen | 192 | ✅ | Active |
| New Lead | 183 | ✅ | Active |
| Qualifying | 131 | ✅ | Active |
| Close/Unknown | 68 | ❌ | Dirty data; TBD — park for future PBC/Bulk Edit sprint |
| Design / Proposal Creation | 54 | ✅ | Active |
| Proposal Negotiation | 50 | ✅ | Active |
| Collecting / In Effect | 47 | ✅ | **Won, under contract, being paid over time** (JP 2026-04-14) |
| Closed / Did not Fulfill | 46 | ✅ | Lost |
| Closed / Full-Time or Successful Conversion | 14 | ❌ | PBC success variant — park for future PBC sprint |
| Contract Creation | 7 | ✅ | Active |
| Negotiating Contract | 7 | ✅ | Active |
| Closed / Temporary Hire | 5 | ❌ | PBC success variant — park for future PBC sprint |
| Closed / Fulfilled | 5 | ❌ | Probably PBC success; park |
| Closed / Contract or Agreement But No Fellows Hired | 4 | ❌ | PBC closed-without-revenue; park |
| Contract Signing | 3 | ❌ | Active pre-close; park |
| Closed / Sourcing | 2 | ❌ | PBC-flavored; park |
| Verbal Commitment | 1 | ❌ | Active late-funnel; park |

**Totals:** 22 distinct stages in live data. 9 not in either enum. 2 fully resolved 2026-04-16 (In Collection, Closed Won). 7 parked for a future PBC + Bulk Edit sprint.

## 2026-04-16 investigation findings (resolved)

SOQL on the full `StageName = 'In Collection'` and `StageName = 'Closed Won'` populations resolved two of the nine unclassified stages:

- **`In Collection` (650 records) — ISA RecordType.** All 30 sampled records are `RecordType.Name = 'ISA'` (Income Share Agreement / Pursuit Bond — Fellows and Builders sharing a percentage of earnings after successful job placement). Almost all created 2019–2020. Legacy Bond-cohort data, tracked elsewhere for Bond collection/enforcement. **Out of philanthropy MVP scope.** Excluded from all philanthropy bucket sets.
- **`Closed Won` (575 records) — Donorbox integration.** All records are Philanthropy RecordType. `LeadSource` is null on every record. `Campaign.Name = 'Online Donations'` and the word `Donorbox` appears in `Opportunity.Name`. CreatedDate range 2019 → 2026-04-04 — actively flowing. Auto-populated by Pursuit's Donorbox online-giving integration (individual donations typically under $20k). **Operationally equivalent to `Closed / Completed` for revenue reporting** — the money has already been received via Donorbox's Stripe payment processor.

### Critical F2 implication

Donorbox donations are already-paid receipts, not invoice-eligible. When F2 ships, the Intacct auto-invoice query must exclude them via `Campaign.Name = 'Online Donations'` OR `Name LIKE '%Donorbox%'`. See `tasks/f1-stage-buckets-plan.md` §5.3 for the full 7-rail F2 bundle.

## Glossary definitions confirmed so far (JP, 2026-04-14 + 2026-04-16)

- **`Closed / Completed`** — won and got paid fully (2026-04-14).
- **`Collecting / In Effect`** — won, have a contract, and are in the process of being paid (potentially multiple payments across the grant period). The Pursuit fundraising-team doc (shared 2026-04-16) defines it as "The ink is dry. We're just waiting for the check to clear" at 100% probability.
- **`Closed Won`** — Donorbox-auto-populated philanthropy donation, money already received (2026-04-16).
- **`In Collection`** — ISA RecordType legacy, 2019–2020 Pursuit Bond cohort, out of philanthropy scope (2026-04-16).

The 4 PBC-prefixed stages (`Full-Time or Successful Conversion`, `Temporary Hire`, `Contract or Agreement But No Fellows Hired`, `Sourcing`), plus `Close/Unknown`, `Contract Signing`, `Verbal Commitment`, and `Closed / Fulfilled` remain unclassified — parked for the future PBC + Bulk Edit sprint.

## What this breaks in the current codebase

### B1 — Funnel classifier silently misclassifies wins as setbacks

**Where:** `financial_forecasting/frontend/src/components/pipelineFunnelTransitions.ts:WON_STAGES`

Currently `WON_STAGES = {'Closed / Completed'}` (lifted from `types/salesforce.ts:90` in the adversarial-review PR). Transitions INTO `Closed Won` (575 records) or `Collecting / In Effect` (47 records) fall through to the `ti > fi ? 'forward' : 'backward'` branch. `Closed Won` isn't in `STAGE_IDX`, so those transitions render as `'backward'` (red setback). `Collecting / In Effect` is in `ACTIVE_FUNNEL_STAGES`, so transitions to it render as `'forward'` — but per the fundraising-team doc, a signed contract at 100% probability IS a win.

PR #105 fixed this bucket-routing for `Closed / Completed`. Remaining drift: `Closed Won` (575) and `Collecting / In Effect` (47). F1 (`tasks/f1-stage-buckets-plan.md` PR 1) fixes both.

### B2 — Sage Intacct auto-invoicing skips 77% of eligible opps

**Where:** `financial_forecasting/data_sync.py:565, 916`

Both references query / check for `StageName = 'Closed Won'` exactly. With 575 matching records vs 1,923 `Closed / Completed`, the trigger fires for ~23% of deals Pursuit has actually won. The other 1,923 closed-and-paid opps never get an Intacct invoice draft created.

**BUT**: now that we've confirmed `Closed Won` is Donorbox-auto-populated donations (not grants), the 575 records that DO currently fire invoices are probably creating wrong Intacct entries — Donorbox donations are already settled via Stripe and shouldn't flow through Intacct's grant-invoice pipeline.

**Near-term mitigation:** `tasks/f1-stage-buckets-plan.md` PR 2 adds a feature flag `INTACCT_AUTO_INVOICE_ENABLED=false` that short-circuits both `sync_opportunity_invoicing` and `handle_opportunity_stage_change`. Keeps everything off until F2 is properly designed. Flag ships now; F2 bundle ships later.

### B3 — Type lies: `opp.StageName: OpportunityStage` admits invalid values

**Where:** `frontend/src/types/salesforce.ts:SalesforceOpportunity.StageName`

The field is typed as the tight union `OpportunityStage` (13 values), but
real records carry values outside that union (`'Closed Won'`, `'Verbal Commitment'`, etc.). TypeScript happily narrows assuming invalid values can't appear, which hides branches. Any code like `if (opp.StageName === 'Closed Won')` is type-errored out even though that stage is real.

F3 (below) keeps the enum at 13 for MVP. `Set<string>` buckets in F1 work around the type issue via string-typed sets that admit values outside the union.

## Deferred fixes — MVP scope in `tasks/f1-stage-buckets-plan.md`

JP directive (2026-04-16): **SF stages are sacred. No LEGACY_STAGES flag. No enum deprecation. No edit-UI hiding. Bucket on top via `Set<string>`.**

Also: F2 Intacct auto-invoicing stays off until the full bundle ships (expanded stage filter + Donorbox exclusion + RecordType filter + date guard + pre-flight cleanup + HITL review + finance onboarding).

### F1 — Bucket sets (frontend + backend canonical)

Widen `WON_STAGES` / `LOST_STAGES` in `frontend/src/types/salesforce.ts` from `readonly OpportunityStage[]` to `ReadonlySet<string>` (admits values outside the tight union). Add `PAYMENT_RECEIVED_STAGES`. Mirror the sets in `financial_forecasting/models.py` as `frozenset[str]` with `_SET` suffix (`WON_STAGES_SET`, `LOST_STAGES_SET`, `COLLECTING_STAGES_SET`, `PAYMENT_RECEIVED_STAGES_SET`).

Finalized memberships:

```
OPEN_STAGES              = {Lead Gen, New Lead, Qualifying,
                            Design / Proposal Creation, Proposal Negotiation,
                            Contract Creation, Negotiating Contract}
WON_STAGES               = {Collecting / In Effect, Closed / Completed, Closed Won}
LOST_STAGES              = {Closed Lost, Withdrawn, Closed / Did not Fulfill}
COLLECTING_STAGES        = {Collecting / In Effect}                    // ⊂ WON_STAGES
PAYMENT_RECEIVED_STAGES  = {Closed / Completed, Closed Won}            // ⊂ WON_STAGES
```

`OPEN_STAGES`, `COLLECTING_STAGES`, `CLOSED_STAGES` (pre-existing terminal-closed bucket) stay as `readonly OpportunityStage[]` — all their members are in the 13-stage enum, and consumers (`useOpportunityData.ts`, `OpportunityEditDialog.tsx`) rely on array semantics (`.includes()`, spread).

Implementation plan: `tasks/f1-stage-buckets-plan.md` §3. Ready to ship as its own PR.

### F2 — Intacct invoice trigger (deferred bundle)

F2 is gated off by the kill switch in `tasks/f1-stage-buckets-plan.md` PR 2. When ready to re-enable, F2 expands to the following 7-rail bundle in a single release:

1. **Expanded stage query** — `WHERE StageName IN (WON_STAGES_SET)` with SOQL interpolation using `escape_soql_string()` from `security.py:40` (precedent at `routes/finance.py:56`).
2. **Donorbox exclusion** — `AND NOT (Campaign.Name = 'Online Donations' OR Name LIKE '%Donorbox%')`. Donorbox donations are already-paid Stripe receipts, not invoice-eligible.
3. **RecordType filter** — `AND RecordType.Name = 'Philanthropy'` (or equivalent). Prevents ISA/PBC records from leaking into Intacct flow.
4. **Date guard** — `AND CloseDate > '<flag-flip-date>'`. Historical backlog stays manual; only new deals flow through auto-invoice.
5. **Pre-flight data cleanup** — `Invoice_Status__c` backfilled on all pre-flag-flip `Closed / Completed` / `Collecting / In Effect` records that were invoiced outside Intacct. Delivered via future Bulk Edit page.
6. **HITL review queue** — auto-invoice proposals land in a pending-review state; finance approves before Intacct writes. Requires new DB table, UI, and workflow.
7. **Finance onboarding** — team confirms GL-mapping, monitors queue, knows how to approve/reject.

F2 stays off until ALL seven rails are in place.

### F3 — Enum sync deferred to post-MVP

Original F3 (sync `OPPORTUNITY_STAGES` to the live picklist) is deferred to the post-MVP PBC + Bulk Edit sprint. The 13-stage enum stays as-is for the philanthropy MVP. String-valued bucket sets in F1 admit values outside the enum so philanthropy reporting still covers the 575 Donorbox records (via `Closed Won` in `WON_STAGES` / `PAYMENT_RECEIVED_STAGES`) without requiring enum widening.

When F3 eventually ships: widen `OPPORTUNITY_STAGES` (and `OpportunityStage` enum) to include the PBC-specific stages **without any LEGACY_STAGES flag** — all stages are valid picklist values and should appear in edit dropdowns.

Depends on: PBC-variant classifications from fundraising-team glossary session (7 unresolved stages: PBC variants + `Close/Unknown` + edge cases).

## Known pre-existing defects (not fixed by F1 / kill switch)

Uncovered during the 2026-04-16 audit. Documented here; fixes live in follow-up PRs.

1. **`forecasting_engine.py:179, 234, 538`** — SOQL queries hardcode the terminal-closed stage list as `{'Closed / Completed', 'Closed / Did not Fulfill', 'Closed Lost', 'Withdrawn'}`. Does NOT include `Closed Won`. Effect:
   - L179 (historical analysis): 575 Donorbox records excluded from the 2-year closed-opportunity history.
   - L234, L538 (open-pipeline forecasting): 575 Donorbox records included as "open" (because they're `NOT IN` the hardcoded closed list), inflating open-pipeline counts and skewing payment forecasts.
   - **Recommended fix:** follow-up PR replacing literals with `WON_STAGES_SET ∪ LOST_STAGES_SET` references from F1 shipped sets.

2. **RecordType filtering audit.** Frontend opportunity fetchers other than `useOpportunityData.ts` may not pass `record_type='Philanthropy'` (which the backend endpoint at `main.py:305` supports). Any that don't filter are showing ISA + PBC records mixed into philanthropy views (Overview, Progress, Accounts). Inventory + systematic filter addition is a separate PR.

3. **`main.py:342–345` stage param validation** — `if s in VALID_STAGES` filters incoming stage filters against the 13-stage enum. If a caller passes `stages=['Closed Won']`, it's silently dropped. Currently no caller does this; document as latent bug.

4. **Consumer stage-list drift.** Multiple frontend files have hardcoded stage arrays that mirror but desync from `types/salesforce.ts` buckets:
   - `Overview.tsx:76` `CLOSED_WON_STAGES` (6-entry defensive substring list — actively correct; keep)
   - `Overview.tsx:476` `GOAL_STAGES = ['Collecting / In Effect', 'Closed / Completed']` (excludes Donorbox from individual fundraiser goals — **product decision pending**)
   - `GoalTracker.tsx:6` `GOAL_STAGES` — same 2 entries
   - `Opportunities.tsx:208` `closedStages` — 4 entries, no `Closed Won`
   - Follow-up PR: normalize these to import from `types/salesforce.ts`.

5. **Donorbox goal-inclusion decision.** Should Donorbox donations count toward individual fundraiser goals? `GOAL_STAGES` currently excludes them. **Needs JP's call.** Product decision, not technical.

## Glossary location (long-term)

The stage definitions + this taxonomy should land in:

- **Primary:** `product/ONBOARDINGPRD.md` (onboarding PRD that defines roles, permissions, day-by-day onboarding for RM / Executive / PM profiles). Add a "CRM Glossary" section covering Opportunity stages, Lead statuses, Project phases, Task priorities, and domain jargon (AIJI, Builders, PBC).
- **Companion:** `product/ONBOARDING-ADDENDUM.md` §I (exhaustive companion doc). Decision matrix table with `Pursuit decision` column. **2 of 10 rows resolved 2026-04-16; 8 remain for the fundraising-team session.**

Both files already exist; this is a new section rather than a new file.

## Next steps (in order)

1. **Ship F1** (bucket sets + funnel classifier fix) — see `tasks/f1-stage-buckets-plan.md` PR 1. Ready for implementation; no external decisions required.
2. **Ship kill switch** (`INTACCT_AUTO_INVOICE_ENABLED=false`) — see `tasks/f1-stage-buckets-plan.md` PR 2. Ready for implementation; locks off auto-invoicing until F2 bundle is ready.
3. **Fundraising-team glossary session** (JP + fundraising team) — classify the 8 remaining unresolved stages (PBC variants + `Close/Unknown` + edge cases). Populate `product/ONBOARDING-ADDENDUM.md` §I decision matrix.
4. **Post-MVP sprint: F3 enum widen + Bulk Edit cleanup page + PBC-specific handling.** Unlocks F2 bundle rail #5 (pre-flight data cleanup).
5. **F2 bundle (7 rails)** — ships when all prerequisites are in place + finance is onboarded. Flips `INTACCT_AUTO_INVOICE_ENABLED=true` in prod `.env`.
