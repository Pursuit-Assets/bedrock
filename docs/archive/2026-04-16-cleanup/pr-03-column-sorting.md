# PR 3: Column Sorting for Priority Opportunities

**Type:** Feature
**Size:** Medium
**Branch:** `feature/priority-table-sorting`
**Depends on:** PR 1 (stable ranking needed first)

## Problem

PriorityTable rows are locked to a single sort order (weighted priority desc or amount desc). Users want to sort by any column to answer questions like "which deals close soonest?" or "which account has the most pipeline?"

## Design

### Sortable Columns

| Column | Sort Type | Comparator |
|--------|-----------|------------|
| Opportunity Name | Alphabetical | `localeCompare` |
| Account | Alphabetical | `localeCompare` |
| Stage | Pipeline order | Index in `OPPORTUNITY_STAGES` array |
| Amount | Numeric | Numeric diff |
| Close Date | Chronological | Date comparison |
| Tasks | Numeric | Task count |
| Actions | **Not sortable** | — |

### UX

- Each sortable column header gets MUI `TableSortLabel`
- Click header → sort ascending; click again → descending; click again → reset to default (weighted/total)
- Active sort column is visually indicated (bold + arrow icon)
- Default sort remains weighted priority or total amount (from the toggle)
- Sort state resets when switching between Total and Weighted modes

### Implementation

Add sort state to PriorityTable:

```typescript
const [sortConfig, setSortConfig] = useState<{
  field: string;
  direction: 'asc' | 'desc';
} | null>(null);
```

Apply sort after filter, before slice:

```typescript
// 1. Filter
let items = applyFilters(scoredItems);
// 2. Sort (user-selected or default)
if (sortConfig) {
  items = applySortByField(items, sortConfig);
} else {
  items = applyDefaultSort(items, showWeighted);
}
// 3. Slice to topN
items = items.slice(0, maxRows);
```

## Files to Touch

- `financial_forecasting/frontend/src/components/PriorityTable.tsx`

## Acceptance Criteria

- [ ] All columns except Actions have clickable sort headers
- [ ] Sorting is type-appropriate (alpha, numeric, date, pipeline-order)
- [ ] Toggling asc/desc/reset works correctly
- [ ] Default sort (weighted/total) applies when no column sort is active
- [ ] Sort is stable (ties broken by Opportunity ID, from PR 1)
