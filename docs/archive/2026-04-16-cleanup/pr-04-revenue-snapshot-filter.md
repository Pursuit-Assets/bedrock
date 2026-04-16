# PR 4: Revenue Snapshot Filter Selector

**Type:** Feature
**Size:** Small
**Branch:** `feature/revenue-snapshot-filter`
**Depends on:** Nothing

## Problem

Revenue Snapshot always shows full pipeline totals. Users want the numbers scoped to what they're actually looking at in Priority Opportunities.

## Design

### Selector Options

Add a small `Select` dropdown to the Revenue Snapshot header with three modes:

| Mode | Label | What it calculates from |
|------|-------|------------------------|
| `all` | All Pipeline | All open opportunities (current behavior) |
| `filtered` | All Filtered | All opportunities matching current PriorityTable filters (stage, close date, tasks, amount) — ignores the topN row limit |
| `priorities` | Just Priorities | Only the opportunities currently visible in the table (filters + topN) |

### Data Flow

Currently in `MyDashboard.tsx`, `pipelineStats` is computed from all opportunities:

```typescript
const pipelineStats = useMemo(() => {
  const openOpps = opportunities.filter(isOpen);
  return {
    total: sum(openOpps, 'Amount'),
    weighted: sum(openOpps, o => o.Amount * o.Probability / 100),
    closingThisMonth: openOpps.filter(closesThisMonth),
  };
}, [opportunities]);
```

Change to accept a filtered opportunity list based on the selected mode. PriorityTable needs to expose its filtered (pre-slice) and visible (post-slice) opportunity lists via callback or shared state.

### State

```typescript
const [snapshotMode, setSnapshotMode] = useState<'all' | 'filtered' | 'priorities'>('all');
```

Persist in `prefs` alongside `topN` and `showWeighted`.

## Files to Touch

- `financial_forecasting/frontend/src/pages/MyDashboard.tsx`
- `financial_forecasting/frontend/src/components/PriorityTable.tsx` — expose filtered/visible lists

## Acceptance Criteria

- [ ] Selector appears in Revenue Snapshot header
- [ ] "All Pipeline" matches current behavior exactly
- [ ] "All Filtered" reflects filter changes in real-time (amount updates when stage filter changes)
- [ ] "Just Priorities" updates when topN or filters change
- [ ] Selected mode persists across page navigations
