"""Pebble chat orchestrator — Anthropic-style agentic patterns.

See ``tasks/pebble-bi-architect.md`` for the full design. This package
houses the orchestrator-worker decomposition of Pebble's L1+ chat path:

- ``schemas.py`` — Pydantic models for Plan, PlanStep, ToolCall, ToolResult.
- ``budget.py`` — Bounded-autonomy guard. Pre-flight + per-step checks.
- ``tools/`` (sibling pkg ``pebble.tools``) — formal Anthropic-shape tool defs.
- ``executor.py`` — runs the plan; consults the budget; persists every
  step to ``bedrock.pebble_chat_scratchpad``.
- ``evaluator.py`` — Haiku-as-judge; scores factuality / completeness;
  triggers up to one re-plan.
- ``planner.py`` — Sonnet emits a Plan from the user query + tool defs.
- ``chat_orchestrator.py`` — top-level: plan → execute → evaluate →
  render. Streams SSE events to the FE.

Each module is callable in isolation so we can unit-test without a
running Anthropic API. Real LLM calls go through dependency-injected
clients passed in from the FastAPI route layer.
"""
