# Decision: full delete `Opportunity.Type` from Bedrock

**Decided:** 2026-04-21 by JP after 2-pass verification against origin/dev HEAD `4a9407a`.
**Future PR:** `pr-opp-type-deprecation` (actual number: #158 in the revised sequence).

## Why full delete, not UI-only

JP's direction: *"Jac referenced the right Opportunity Record Type field that shows 'other fee for service' and philanthropy and whatnot. That's the real field we needed."* Type is fully obsolete.

Full delete over UI-only because:

1. **No data loss.** Type values remain in Salesforce; Bedrock stops pulling them. 5 SOQL-line reversal if ever needed.
2. **UI-only leaves a trap.** Future developers see `Type` in the API response during debugging, assume meaning, re-surface. Comments don't prevent that; absence does.
3. **`RecordType.Name` already labels meaningfully.** `OpportunityEditDialog.tsx:578-613` renders a "Record Type" picker showing "Philanthropy / Other fee for service" etc. No additional labeling needed.
4. **`RenewalRepeat__c` captures the "renewal vs new" dimension Type encoded.** `OpportunityEditDialog.tsx:619-629` already exposes it. Nothing semantic lost.

## Full deletion inventory (verified at origin/dev 4a9407a)

### Backend (`financial_forecasting/main.py`)

| Line | What |
|---|---|
| 310 | `opp_type: Optional[str] = Query(None, description="Filter by Opportunity Type field")` param — delete |
| 322 | cache key includes `opp_type` — remove from f-string |
| 333 | SOQL `SELECT ... Description, Type, OwnerId, ...` — remove `Type,` |
| 352-353 | `if opp_type: where_clauses.append(f"Type = '{escape_soql_string(opp_type)}'")` — delete block |
| 1591 | search-opportunities SOQL `SELECT ... Description, Type` — remove `, Type` |
| 1619 | response dict `"Type": record.get("Type")` — delete entry |

### Frontend types (`financial_forecasting/frontend/src/types/salesforce.ts`)

| Line | What |
|---|---|
| 129 | `Type: string | null;` on `SalesforceOpportunity` — delete |

### Frontend pages / components

| Location | What |
|---|---|
| `hooks/useOpportunityTypePicklist.ts` | **delete entire file** |
| `components/inline-edit/cells/TypeCell.tsx` | **delete entire file** |
| `pages/Opportunities.tsx:45` | `import { useOpportunityTypePicklist } ...` — delete |
| `pages/Opportunities.tsx:117` | `const typePicklist = useOpportunityTypePicklist();` — delete |
| `pages/Opportunities.tsx:289-290` | `typeOptions: typePicklist.options,` and `typePicklist.options` in deps array — delete |
| `pages/Opportunities.tsx:466-472` | `typeOptions={(() => {...})()}` passed to PipelineFilterBar — delete the prop, remove the IIFE |
| `pages/Opportunities/columns.tsx:36` | `// TypeCell import removed ...` stale comment — delete |
| `pages/Opportunities/columns.tsx:83-85` | `typeOptions?: string[]` dead interface field — delete |
| `pages/Opportunities/columns.tsx:157` | `// Opportunity.Type column removed ... Leaving TypeCell in place for future use.` — delete |
| `components/PipelineFilterBar.tsx:22` | `types: string[]` in PipelineFilters — delete |
| `components/PipelineFilterBar.tsx:34` | `types: []` in DEFAULT_FILTERS — delete |
| `components/PipelineFilterBar.tsx:52-54` | `typeOptions?: string[]` prop — delete |
| `components/PipelineFilterBar.tsx:64` | `typeOptions = []` default — delete |
| `components/PipelineFilterBar.tsx:131` | active-filter count block for `filters.types.length` — delete |
| `components/PipelineFilterBar.tsx:206-217` | Type Autocomplete block — delete |

### Tests

| File:line | What |
|---|---|
| `tests/conftest.py::make_sf_opportunity` | `Type: "Other fee for service"` default (added by B2 PR #144) — delete |
| `tests/test_api_endpoints.py::test_get_opportunities_returns_records` | `assert data[0]["Type"] == "Other fee for service"` — delete or replace with RecordType assertion |

## Out of scope (NOT touched by this PR)

- `Account.Type` (`main.py:496` SOQL) — different object, different field, keep.
- `Task.Type` / `Task.TaskSubtype` (`main.py:936, 958`) — different object, keep.
- `Opportunity.RecordTypeId` / `RecordType.Name` — the replacement field, already wired by Jac's #151.
- `Opportunity.RenewalRepeat__c` — still an editable field, separate concern.

## Size estimate

Medium (200-500 LOC diff). Clean subtractive deletion. No behavior change for users — the filter chip disappears (intended) and the API response drops one field.

## Review checklist before merge

- [ ] `tsc --noEmit` clean (catches any missed type references)
- [ ] `pytest tests/test_api_endpoints.py` — no `Type` assertion failures
- [ ] Manual smoke: open Opp list, confirm Type filter chip is gone from PipelineFilterBar, confirm grid still renders correctly, confirm edit drawer has RecordType (not Type), confirm filter count is still accurate
- [ ] Grep `Type` across the touched files one more time — any remaining reference is intentional (Account.Type, Task.Type) or needs removal

## Shipped 2026-04-21 — actual PR #160 (lane-interleaved; B2 claimed #159 first)

This doc was written pre-A1/A2/A3, so line numbers drifted by −2 (backend, A3 deleted imports) and +10 (search_opportunities region, A1 pagination elsewhere in file). Content-verified re-location completed; all 22 enumerated edit points landed with updated line numbers. See `tasks/parallel-pr-lanes.md` for the final A4 row (numbering + scope-expansion).

**4 additional consumers surfaced during verification (JP-approved scope expansion):**

1. **`Opportunities.tsx:346-348`** — Type filter predicate `if (f.types.length > 0) { filtered = filtered.filter((opp) => opp.Type && f.types.includes(opp.Type)); }`. Deletion cascade from the PipelineFilterBar `types: string[]` removal — tsc-required.
2. **`pbcOnly` dead state cascade** — `Opportunities.tsx:63` useState + `useOpportunityData.ts` param + `useOpportunityData.ts:59-62` `params.opp_type = 'PBC'` branch + `services/api.ts:143` method signature. `setPbcOnly` is never called anywhere in the codebase (verified full-repo grep); dead code leftover from 2026-03-03. Cleaned per `feedback_production_discipline` "no stubs" rule.
3. **`Progress.tsx:192 isRenewal`** — `const isRenewal = (opp) => opp.Type === 'Renewal'` used on 6 callsites in base-case/downside forecast calculations. Rewrite to `opp.RenewalRepeat__c === 'Renewal'` aligns with canonical `utils/priorityScoring.ts:110-112` pattern and the `OpportunityEditDialog.tsx:625-628` Renewal/Repeat picklist `{'New', 'Renewal', 'Upsell'}`. Latent-bug fix. Required adding `RenewalRepeat__c?: string;` to the local `Opportunity` interface in `Progress.tsx:49-68` (replaces the deleted `Type?: string;` field).
4. **`Priorities.tsx:816` + `priorityScoring.ts:14`** — dead `Type: opp.Type || ''` mapping + `Type?: string;` interface field on `PriorityOpp`. Full-repo grep confirmed no consumer reads `PriorityOpp.Type`; renewal semantics use `.RenewalRepeat` (priorityScoring.ts:110). Dropped both.

**Test-assertion correction.** The B2 2026-04-19 regression guard in `test_api_endpoints.py:336` asserted `data[0]["Type"] == "Other fee for service"`. Per JP 2026-04-21: "Other fee for service" is a RecordType.Name value, not a Type value — B2 misdiagnosed the field. A4 swapped the assertion to `assert data[0]["RecordType"]["Name"] == "Other fee for service"` and the `make_sf_opportunity` fixture to provide `RecordTypeId: "012TESTRECORDTYPE01"` + `RecordType: {"Name": "Other fee for service"}` (the backend SOQL already selects RecordType.Name at main.py:336 and returns records raw at main.py:369 — no backend change needed).

**Verification results.** `pytest` 20/718/22 (baseline unchanged — net test-count delta 0). `tsc --noEmit` clean. `CI=true npm test` 25/25 suites / 367/367 tests. Full-repo grep zero Opportunity.Type stragglers; remaining `Type` hits are Account.Type, Task.Type, Content-Type header, or archive/deprecated files.
