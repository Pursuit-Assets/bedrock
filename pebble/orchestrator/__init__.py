"""Pebble orchestrator package.

Houses TWO distinct orchestrators that historically lived in one
``orchestrator.py`` file but have grown into different concerns:

  1. **Prospect-research pipeline** (``_pipeline``) — the original
     Pebble: Workers → Foragers → Queen multi-source enrichment for
     a single prospect. Re-exported from this ``__init__`` so legacy
     callers (``pebble.handlers.tier3``, ``pebble.clusters``, etc.)
     keep working.

  2. **Chat orchestrator** (``chat_orchestrator``) — the new agentic
     loop for Ask-Pebble: planner → executor → evaluator → renderer
     with bounded autonomy. Designed per the Anthropic Architect
     curriculum's session-2 patterns (orchestrator-worker, scratchpad,
     evaluator-optimizer, bounded autonomy, schema-aware tools).

Submodules:
  * ``schemas``           — Pydantic models for Plan / PlanStep / ToolResult.
  * ``budget``            — bounded-autonomy guard with hard caps.
  * ``tools``             — ToolRegistry + ToolSpec for chat tools.
  * ``builtin_tools``     — search_crm, get_record, request_human_review.
  * ``scratchpad``        — durable insert-only step trace.
  * ``executor``          — runs a Plan; consults the budget; persists steps.
  * ``planner``           — Sonnet emits a Plan from user query + tools.
  * ``evaluator``         — Haiku-as-judge; PASS/RETRY/ABORT verdict.
  * ``renderer``          — turns ExecutionResult into a FinalResponse.
  * ``chat_orchestrator`` — ties planner + executor + evaluator into a loop.

Each module is callable in isolation so we can unit-test without a
running Anthropic API. Real LLM calls go through dependency-injected
clients passed in from the FastAPI route layer.
"""

# Legacy prospect-research pipeline — preserved at the old module
# path for backward compatibility. New chat-orchestrator code lives
# in `.chat_orchestrator`, etc.
from ._pipeline import (  # noqa: F401
    ProspectBudgetTracker,
    PROSPECT_COST_CAP_USD,
    activate_foragers,
    fetch_research_data,
    quorum_verify_claims,
    research_single_prospect,
    score_source_richness,
    stage1_enrich_prospect,
    stage2_score,
    synthesize_profile,
    verify_urls,
)
