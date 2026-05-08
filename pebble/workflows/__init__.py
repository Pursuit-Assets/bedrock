"""Pebble workflow library — deterministic compositions for common
queries. Workflows fire when the L0 router classifies a query as a
known pattern (e.g. ``/pipeline`` slash command); the L1 agent only
fires for novel queries.

Workflows are auditable, versioned in code, fast, and cheap. Each
workflow:

  1. Registers a tool spec in ``DEFAULT_REGISTRY`` so the L1 planner
     can also invoke it for natural-language requests like
     "show me a weekly pipeline review."
  2. Exposes a ``build_<name>_plan`` function that returns a
     pre-baked ``Plan`` the slash-command path runs through
     ``ChatOrchestrator.run_stream_with_plan(plan, allow_replan=False)``.

Two entry points to the same code path = same SSE event vocabulary,
same scratchpad rows, same renderer behavior.

v1.0 ships ``weekly_pipeline_review`` as the worked example. New
workflows = new file in this package + register at import time. No
core orchestrator changes needed.
"""

from .weekly_pipeline_review import (  # noqa: F401
    AGGREGATE_PIPELINE_VIEWS_SPEC,
    build_weekly_pipeline_review_plan,
    register_workflow_tools,
)

# Auto-register at import time so the planner sees workflow tools on
# first request, same pattern as ``pebble.orchestrator.builtin_tools``.
register_workflow_tools()
