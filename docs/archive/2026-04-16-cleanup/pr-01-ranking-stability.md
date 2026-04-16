# PR 1: Fix Weighted Priority Ranking Stability

**Type:** Bug fix
**Size:** Small
**Branch:** `fix/ranking-stability`
**Depends on:** Nothing

## Problem

When switching the row count between 5, 10, 25, or 50 in Priority Opportunities, the ranking changes. Priority #1–5 should be identical whether showing 5 or 50 rows. The topN control should only affect how many rows are *visible*, not which opportunities are ranked highest.

## Root Cause Investigation

Two likely causes in the current code:

1. **`computeWeightedPriority()` in `src/utils/priorityScoring.ts`** — if the scoring function uses any rank-relative or dataset-size-relative inputs (percentiles, normalization against current set), then changing the visible count could change scores.

2. **Unstable sort** — JavaScript's `Array.sort()` is not guaranteed stable in all engines. If two opportunities have the same `weightedPriority` score, their relative order may flip depending on array size.

## Fix

### Step 1: Audit `computeWeightedPriority()`
- Confirm each opportunity's score depends only on its own fields (Amount, Probability, CloseDate proximity, overdue tasks, stage weight).
- If any normalization exists (e.g., "rank among top N"), remove it and score absolutely.

### Step 2: Add deterministic tiebreaker
In `PriorityTable.tsx`, the sort comparator:

```typescript
// Current
items.sort((a, b) => b.weightedPriority - a.weightedPriority);

// Fixed — add tiebreaker by Opportunity ID
items.sort((a, b) => {
  const diff = b.weightedPriority - a.weightedPriority;
  if (diff !== 0) return diff;
  return (a.opp.Id || '').localeCompare(b.opp.Id || '');
});
```

Same tiebreaker for the Total mode sort by Amount.

### Step 3: Ensure sort happens before slice
Verify the data flow: filter → sort → slice. The slice must be the very last operation.

## Files to Touch

- `financial_forecasting/frontend/src/utils/priorityScoring.ts`
- `financial_forecasting/frontend/src/components/PriorityTable.tsx`

## Verification

- Load page with 50 rows visible. Note ranks 1–5.
- Switch to 5 rows. Confirm same 5 opportunities in same order.
- Switch to 25. Confirm ranks 1–5 unchanged, 6–25 are new rows.
- Toggle Total ↔ Weighted. Confirm stability within each mode.

## Acceptance Criteria

- [ ] Ranks 1–N are identical regardless of topN setting (for any N ≤ topN)
- [ ] Total and Weighted modes each have deterministic sort order
- [ ] No behavioral regression in filter interactions
