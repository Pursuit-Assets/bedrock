# PR 8: Pipeline Funnel Accountability Visualization

**Type:** Feature
**Size:** Large
**Branch:** `feature/pipeline-funnel`
**Depends on:** Nothing
**Location:** Dashboard/Overview page (`/dashboard`)

## Problem

Nick needs visibility into pipeline health: are opportunities actually moving through stages, or is the pipeline stagnant? The team needs a forcing function that shows whether effort is translating into movement.

## Design

### Funnel Visualization

A vertical funnel (widest at top, narrowest at bottom) with one layer per active stage:

```
┌──────────────────────────────────────┐
│  Lead Gen          45 opps  $135M    │  ↑+3 ↓-2  net: +1
├────────────────────────────────┐     │
│  New Lead        22 opps  $48M │     │  ↑+5 ↓-3  net: +2
├──────────────────────────┐     │     │
│  Qualifying    12 opps $27M    │     │  ↑+2 ↓-1  net: +1
├────────────────────┐     │     │     │
│  Design/Proposal  4 $6.3M│     │     │  ↑+1 ↓-0  net: +1
├──────────────┐     │     │     │     │
│  Proposal Neg 3 $5.8M    │     │     │  ↑+1 ↓-1  net: 0
├──────────┐   │     │     │     │     │
│  Collect  1 $150K │     │     │     │  ↑+0 ↓-0  net: 0
└──────────┘   │     │     │     │     │
```

Each layer shows:
- Stage name
- Current count of opportunities
- Current total amount
- **Movement indicators:** green arrow (moved in) / red arrow (moved out) / net change
- Net positive = green highlight, net negative = red highlight, zero = neutral

### Date Range Selector

Toolbar above the funnel:
- Last 7 days (default)
- Last 30 days
- Last 90 days
- Custom range (date picker)

### Click-Through Detail

Clicking a funnel layer opens a detail panel (drawer or expandable section):

**Moved In:**
| Opportunity | From Stage | Amount | Date |
|------------|------------|--------|------|
| FY26 - Google | Lead Gen → Qualifying | $5M | Mar 14 |

**Moved Out:**
| Opportunity | To Stage | Amount | Date |
|------------|----------|--------|------|
| FY26 - Arrow Impact | Qualifying → Withdrawn | $250K | Mar 10 |

**Summary:**
- Net in: +2 opportunities, +$4.75M
- Net out: -1 opportunity, -$250K
- Net change: +1, +$4.5M

### Stagnation Detection

If a stage has zero net movement for the selected period, show an amber "Stagnant" badge. This directly addresses Nick's concern: "are you actually moving deals?"

## Data Source: Stage Change History

**Challenge:** We need historical stage transition data. Options:

**Option A: Salesforce OpportunityFieldHistory**
- SF tracks field changes if Field History Tracking is enabled for Stage
- Query: `SELECT OpportunityId, OldValue, NewValue, CreatedDate FROM OpportunityFieldHistory WHERE Field = 'StageName'`
- Pros: Free, already tracked if enabled
- Cons: Requires SF admin to enable; limited to 18-month retention

**Option B: Local stage_change_log table**
- Log every stage change made through Bedrock to a PostgreSQL table
- Schema: `opportunity_id, old_stage, new_stage, changed_at, changed_by`
- Pros: Full control, unlimited retention, works offline
- Cons: Only captures changes made through Bedrock (misses direct SF edits)

**Option C: Both (recommended)**
- Pull SF history for existing data
- Log locally going forward for guaranteed capture
- Merge both sources for the funnel

### Backend API

```
GET /api/pipeline/stage-movement?start=2026-03-10&end=2026-03-17
Response: {
  stages: [
    {
      name: "Lead Gen",
      current_count: 45,
      current_amount: 135000000,
      moved_in: [{ opp_id, opp_name, from_stage, amount, date }],
      moved_out: [{ opp_id, opp_name, to_stage, amount, date }],
    },
    ...
  ]
}
```

## Informed by AIJI Project Tracker

The Executive Snapshot tab shows static metrics (Cash Secured: $150K, Active: $12.6M, Qualifying: $27M, Early-stage: $135M). The funnel replaces this with a dynamic, interactive view that shows *movement* not just snapshots.

The "Comments / Feedback" column on the Total AIJI Funder Pipeline maps to the click-through detail — Nick can see exactly which deals moved and why.

## Files to Touch

- `financial_forecasting/frontend/src/components/PipelineFunnel.tsx` — **new file**
- `financial_forecasting/frontend/src/pages/Overview.tsx` — integrate funnel
- `financial_forecasting/backend/` — stage movement API endpoint
- `financial_forecasting/backend/` — stage_change_log table migration (if Option B/C)

## Acceptance Criteria

- [ ] Funnel renders with one layer per active stage
- [ ] Each layer shows count, amount, and movement indicators
- [ ] Date range selector filters the movement data
- [ ] Clicking a layer shows detail: which opportunities moved in/out
- [ ] Stagnation detection shows amber badge for zero-movement stages
- [ ] Net positive/negative visually distinguished (green/red)
- [ ] Data source works (SF history, local log, or both)
