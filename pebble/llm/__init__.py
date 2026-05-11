"""LLM client package for the Pebble chat orchestrator.

Provides an AsyncAnthropic-backed implementation of the
``PlannerLLMClient`` and ``EvaluatorLLMClient`` protocols defined in
``pebble.orchestrator.planner`` and ``pebble.orchestrator.evaluator``.

Why a separate package instead of inlining into orchestrator/:
  * The orchestrator is provider-agnostic by design — its protocols
    don't import ``anthropic``. Tests stub the protocols. Production
    plugs in an ``AnthropicLLMClient``.
  * If we ever route some calls via Bedrock / OpenRouter / a future
    self-hosted model, those clients land here too without touching
    orchestrator core.
  * Keeps ``model_client.py`` (sync, used by the prospect research
    pipeline T1/T2/T3) untouched. Two LLM clients in two modules,
    each tuned for its lifecycle.

Public surface:
  * ``AnthropicLLMClient`` — the AsyncAnthropic wrapper.
  * ``get_default_client`` / ``close_default_client`` — process-wide
    singleton lifecycle. The FastAPI app constructs once at lifespan
    startup and closes at shutdown.
  * ``calculate_cost_usd`` — pure pricing function reused by both
    real and mock clients so cost telemetry stays consistent.
"""

from .anthropic_client import (  # noqa: F401
    AnthropicLLMClient,
    AnthropicLLMError,
    close_default_client,
    get_default_client,
)
from .cost import (  # noqa: F401
    MODEL_RATES,
    ModelRates,
    calculate_cost_usd,
)
