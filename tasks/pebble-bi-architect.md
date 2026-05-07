# Pebble BI Assistant — Agentic Architecture

> Status: Build spec. Applies every pattern from the Claude Certified Architect curriculum.
> Goal: a true business-intelligence assistant for Pursuit's CRM that's intuitive out of the box, not a chatbot wrapper around SOSL.
> Date: 2026-05-07
> Bar: enterprise-grade. No toys.

## The patterns we apply (and where)

| Pattern | Where it lives in Pebble |
|---|---|
| **Orchestrator-worker** | `pebble/orchestrator/chat_orchestrator.py` — planner generates a plan, executor runs steps via tools, evaluator scores the answer. |
| **Bounded autonomy** | `pebble/orchestrator/budget.py` — per-conversation cap on tool calls, cost, wall-clock. Hard-stop at the boundary, not best-effort. |
| **Scratchpad / state externalization** | `bedrock.pebble_chat_scratchpad` — every step (plan, tool call, tool result, eval, render) persisted. Enables replay, debugging, training. |
| **Tool use (formal)** | `pebble/tools/registry.py` — Anthropic-format tool specs (`name`, `description`, `input_schema`). Tools: `search_crm`, `get_record`, `query_metric`, `fetch_pebble_research`, `propose_write`, `generate_chart`, `request_human_review`. |
| **Reflection / evaluation** | `pebble/orchestrator/evaluator.py` — Haiku scores each response on factuality (cite presence), completeness (plan-step coverage), harm. Below threshold → one re-plan. |
| **Routing / classification** | Existing `pebble/router.py` extended: L0-redirect (deterministic nav), L0-fact (template SQL → text), L1-orchestrator (planner). |
| **Disambiguation** | Tool calls return `disambiguation_required` when input matches >1 record above threshold. Frontend renders chooser; user picks; orchestrator resumes from scratchpad. |
| **Citation / provenance** | Every text claim wraps in `<cite id="hit_123">…</cite>`. Frontend renders as numeric superscripts → footnote panel. Evaluator rejects responses that exceed a no-citation budget. |
| **Workflow vs agent** | `pebble/workflows/` — deterministic compositions for common queries ("weekly pipeline review", "renewal check"). Agent only fires for novel queries. Workflows are auditable, versioned, fast. |
| **Conflict resolution** | When two tool results disagree (e.g. SF says owner=A, activity-derived inference says owner=B), orchestrator emits an explicit `conflict` step with both sources; renderer surfaces the disagreement. |
| **Memory / compaction** | `bedrock.pebble_chat_messages` already exists; new `bedrock.pebble_chat_summary` rollup table. Conversations >20 turns get summarized; orchestrator hydrates summary instead of full history. |
| **Resilience** | Retries with backoff inside tools. Circuit breakers per backend (search, SF, Pebble research). Graceful degradation order matches `tasks/pebble-search-spec-security.md` §6. |
| **Bounded recursion** | Plan can have nested steps but max-depth = 3. Anti-pattern: agent re-plans recursively until budget exhausts. |
| **Streaming with tool calls** | Anthropic streaming + tool-use events. Frontend renders plan steps as they execute, not just final text. User sees what Pebble's doing. |
| **Human-in-the-loop checkpoint** | Any step calling `propose_write` HARD-STOPS the executor. User must confirm via card; confirmation carries user JWT (not internal-key) → executor resumes. |
| **Schema-aware NL → query** | `pebble/tools/query_metric.py` accepts a metric name (e.g. "stale-pipeline-by-owner") + bound params. Query templates live in `pebble/metrics/` keyed by metric name. NL → metric-name lookup is the slot the agent fills, not raw NL → SQL. |

## Data flow

```
              user query
                  │
                  ▼
    ┌──────────────────────┐
    │      L0 Router       │  ← Haiku classifier
    └──────────────────────┘
       │           │           │
       ▼           ▼           ▼
   L0 nav    L0 metric    L1 agent
   /accounts  template    Orchestrator
                            │
                            ▼
       ┌─────────────────────────────────────┐
       │            Planner                  │  ← Sonnet
       │  emits Plan = [step1, step2, …]     │
       │  each step: {tool, args,            │
       │   expected_shape, success_criteria}│
       └─────────────────────────────────────┘
                            │
                            ▼
       ┌─────────────────────────────────────┐
       │           Executor                  │
       │   ┌──────────────────────────────┐  │
       │   │     Budget Watchdog          │  │
       │   │  tool_calls / cost / wall    │  │
       │   └──────────────────────────────┘  │
       │   for each step:                    │
       │     scratchpad.write(step)          │
       │     result = tool.invoke(args)      │
       │     scratchpad.write(result)        │
       │     if conflict → conflict step     │
       │     if disambig → checkpoint        │
       │     if budget exhausted → halt      │
       └─────────────────────────────────────┘
                            │
                            ▼
       ┌─────────────────────────────────────┐
       │           Evaluator                 │  ← Haiku
       │  factuality / completeness / harm   │
       │  threshold gate; one re-plan max    │
       └─────────────────────────────────────┘
                            │
                            ▼
       ┌─────────────────────────────────────┐
       │           Renderer                  │
       │   stream tokens + citations +       │
       │   charts + suggested actions        │
       └─────────────────────────────────────┘
                            │
                            ▼
                       SSE → FE
```

## Schemas

### bedrock.pebble_chat_scratchpad (new)

Every step of every conversation gets a row. Tree-shaped via `parent_step_id` so re-plans branch.

```sql
CREATE TABLE bedrock.pebble_chat_scratchpad (
    id              UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    parent_step_id  UUID,
    step_number     INT NOT NULL,
    step_type       TEXT CHECK (step_type IN
        ('plan','tool_call','tool_result','evaluation','render',
         'conflict','checkpoint','error')),
    tool_name       TEXT,
    tool_args       JSONB,
    tool_result     JSONB,
    cost_usd        NUMERIC,
    duration_ms     INT,
    user_email      CITEXT NOT NULL,
    org_id          TEXT NOT NULL DEFAULT 'pursuit',
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

### Plan schema (Pydantic)

```python
class PlanStep(BaseModel):
    step_id: UUID
    tool: str
    args: dict[str, Any]
    expected_shape: str
    success_criteria: str
    depends_on: list[UUID] = []

class Plan(BaseModel):
    plan_id: UUID
    user_query: str
    steps: list[PlanStep]
    rationale: str  # planner's chain-of-thought summary
    estimated_cost_usd: float
    estimated_tool_calls: int
```

### Budget contract

- Per conversation: 20 tool calls / $0.50 / 60s
- Per user-day: $5 (existing cap)
- Per org-day: $50

When budget exhausts mid-execution, executor halts cleanly, persists `error` step, returns whatever's been answered.

## Tool registry — formal Anthropic-shape

Each tool: `{name, description, input_schema}`. The orchestrator pipes them straight to Sonnet. Tools live in `pebble/tools/`:

- `search_crm(query, types?, filters?, limit?)` — calls `/api/search` (Layer 1.8) with the originating user's credentials.
- `get_record(entity_type, entity_id)` — single record fetch via `/api/salesforce/{type}/{id}`.
- `query_metric(metric_name, params)` — runs a curated SQL template from `pebble/metrics/{metric_name}.sql`. Metrics start: `stale_pipeline`, `at_risk_renewals`, `coverage_by_owner`, `cash_forecast_quarter`, `top_open_accounts`.
- `fetch_pebble_research(prospect_name?, contact_id?)` — reads `pebble_research_sessions`.
- `propose_write(action, payload)` — emits a `checkpoint` step. Executor halts. Frontend renders confirm-card. User confirm hits the actual write endpoint with their JWT.
- `generate_chart(data, kind)` — returns Recharts-shape JSON.
- `request_human_review(reason)` — explicit pause (e.g. low-confidence interpretation).

## Bounded autonomy enforcement

`pebble/orchestrator/budget.py:Budget` is a small dataclass:

```python
@dataclass
class Budget:
    max_tool_calls: int = 20
    max_cost_usd: float = 0.50
    max_wall_seconds: float = 60.0
    spent_tool_calls: int = 0
    spent_cost_usd: float = 0.0
    started_at: float = field(default_factory=time.monotonic)

    def remaining(self) -> dict: ...
    def check(self) -> Optional[str]: ...   # None = OK, else reason for halt
    def charge(self, calls: int = 0, cost: float = 0.0) -> None: ...
```

Executor `check()`s before every tool call. Halt condition writes a final `error` step + emits a degraded response: "I covered N of M questions before hitting my budget."

## Workflow library

Common queries get deterministic compositions instead of agent-fired plans:

- `weekly_pipeline_review.py` — call `query_metric("at_risk_renewals")`, `query_metric("stale_pipeline")`, `query_metric("coverage_by_owner")`, render as 3-section briefing with charts.
- `daily_digest.py` — same pattern, ran from cron, emails to user.
- `pre_call_briefing.py(account_id)` — fetch account + last 5 activities + open opps + `pebble_profile` if any.
- `renewal_check.py(opportunity_id)` — fetch opp + payment schedule + last activity + risk score.

Workflows fire when the L0 router classifies the query as a known pattern. Otherwise the L1 agent fires. Workflows are auditable, versioned in code, fast, cheap.

## Evaluator (judge model)

Haiku takes:
- The original query
- The plan
- The scratchpad (final state)
- The proposed response

Returns:
- `factuality` ∈ [0, 1] — every claim has a citation or matches a tool result?
- `completeness` ∈ [0, 1] — plan steps satisfied?
- `harm` ∈ {none, mild, severe} — content safety
- `verdict` ∈ {pass, retry, abort}

If `retry`, executor gets one more shot with the eval feedback in the planner's context. If `abort`, response is replaced with a degraded message ("I had trouble answering — try rephrasing").

## Renderer + frontend hooks

Streamed events (SSE):

- `plan` — sends the Plan to FE; FE renders steps as todo-list.
- `step_start {step_id, tool, args_summary}` — FE marks step in-progress.
- `step_result {step_id, summary}` — FE marks done.
- `token {text}` — final answer streaming.
- `cite {id, ref}` — citations as the answer streams.
- `chart {data, kind}` — embedded visualization.
- `action_proposal {action_id, payload, diff_preview}` — confirm-card.
- `done`.
- `error {reason}`.

Frontend:
- `PebblePanel.tsx` — plan-as-todos view + streamed answer + citations footnote + suggested-action cards.
- Always-on omnibox in `AppShell.tsx` header (not just cmd-K) for discoverability.
- Sample queries in empty state, role-aware.

## Intuitive out of the box

- **Empty state**: 6 sample prompts based on user role (RM sees deal-pipeline prompts, Exec sees portfolio prompts).
- **Slash commands**: `/digest`, `/pipeline`, `/at-risk`, `/research <name>` — workflow shortcuts.
- **First-login coachmark**: 3-second tour highlighting the omnibox + "Ask Pebble" affordance.
- **Daily digest email**: every weekday morning, 3-5 priority items per user. (Opt-out, not opt-in.)
- **In-context queries**: when on `/accounts/{id}`, the omnibox is pre-scoped to that account. "What's at risk here?" auto-fills the account ID.
- **Quick actions**: results have hover-affordances ("explore", "send follow-up", "schedule").

## What ships in v1.0

The v1.0 cut is the foundation that makes all of the above possible — not all of the above:

1. ✅ Tool registry + Plan/Step schemas
2. ✅ `bedrock.pebble_chat_scratchpad` table
3. ✅ Budget watchdog
4. ✅ Orchestrator skeleton (planner → executor → evaluator)
5. ✅ Evaluator (Haiku)
6. ✅ One concrete workflow (`weekly_pipeline_review`) as the worked example
7. ✅ Citation enforcement
8. ✅ Disambiguation flow

Layered later: more workflows, more metrics, daily digest, in-context omnibox, slash commands.

The point of v1.0 is that the architecture supports all of them mechanically. New workflows = new file in `pebble/workflows/`. New metrics = new SQL template in `pebble/metrics/`. New tools = new entry in the registry. No core changes.
