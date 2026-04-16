# PR 2: Stage Colors & Pipeline Ordering

**Type:** UI polish
**Size:** Medium
**Branch:** `feature/stage-colors-ordering`
**Depends on:** Nothing

## Problem

1. Stage chips in PriorityTable and Pipeline are unstyled or use a coarse 4-color scheme (success/error/warning/info).
2. Stage Selector filter sorts alphabetically instead of pipeline order.
3. No validation prevents entering a nonexistent stage name when editing.

## Design

### Canonical Stage Color Map

Define in `src/types/salesforce.ts` next to `OPPORTUNITY_STAGES`:

```typescript
export const STAGE_COLORS: Record<OpportunityStage, string> = {
  '--None--':                    '#9E9E9E', // grey
  'Lead Gen':                    '#42A5F5', // light blue
  'New Lead':                    '#29B6F6', // cyan-blue
  'Qualifying':                  '#26C6DA', // teal
  'Design / Proposal Creation':  '#66BB6A', // green
  'Proposal Negotiation':        '#FFA726', // orange
  'Contract Creation':           '#FF7043', // deep orange
  'Negotiating Contract':        '#EF5350', // red-orange
  'Collecting / In Effect':      '#AB47BC', // purple (active/closed-won)
  'Closed / Did not Fulfill':    '#78909C', // blue-grey
  'Closed / Completed':          '#4CAF50', // solid green
  'Closed Lost':                 '#E53935', // red
  'Withdrawn':                   '#BDBDBD', // light grey
};
```

Colors progress from cool (early pipeline) to warm (late pipeline) to accent (closed states).

### Stage Ordering

The `OPPORTUNITY_STAGES` array is already in pipeline order. Use its index for:
- Stage Selector filter chip ordering (replace `.sort()`)
- Sort comparator when users sort by Stage column (PR 3)

### Where to Apply Colors

| Location | File | Current | Change |
|----------|------|---------|--------|
| PriorityTable stage column | `src/components/PriorityTable.tsx` | Default chip | Colored chip using `STAGE_COLORS` |
| Pipeline DataGrid stage column | `src/pages/Opportunities/columns.tsx` | `getStageColor()` (4 colors) | `STAGE_COLORS` lookup |
| PriorityTable Stage filter chips | `src/components/PriorityTable.tsx` | Unstyled | Colored to match |
| PipelineFilterBar stage chips | `src/components/PipelineFilterBar.tsx` | Unstyled | Colored to match |
| TaskPanel stage references | `src/components/TaskPanel.tsx` | Text only | Colored chip if stage is displayed |

### Stage Validation on Edit

When stage is editable (e.g., Pipeline DataGrid, Opportunity detail):
- Use an Autocomplete/Select component constrained to `OPPORTUNITY_STAGES`
- Allow free-text typing for search, but only accept values from the list
- Show validation error for invalid stage names

## Files to Touch

- `financial_forecasting/frontend/src/types/salesforce.ts` — add `STAGE_COLORS` map
- `financial_forecasting/frontend/src/components/PriorityTable.tsx` — apply colors, fix filter ordering
- `financial_forecasting/frontend/src/pages/Opportunities/columns.tsx` — use new colors
- `financial_forecasting/frontend/src/pages/Opportunities/helpers.ts` — update/replace `getStageColor()`
- `financial_forecasting/frontend/src/components/PipelineFilterBar.tsx` — apply colors to stage chips

## Acceptance Criteria

- [ ] Every stage chip in the app uses the canonical color from `STAGE_COLORS`
- [ ] Stage Selector filter shows stages in pipeline order (Lead Gen → Collecting)
- [ ] Stage editing only accepts valid stage names from `OPPORTUNITY_STAGES`
- [ ] Colors are visually distinct and readable on both light backgrounds and dark text
