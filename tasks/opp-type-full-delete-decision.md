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
