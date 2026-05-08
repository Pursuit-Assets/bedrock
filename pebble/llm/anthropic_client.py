"""AsyncAnthropic-backed implementation of the orchestrator's LLM
client protocols.

Implements both
``pebble.orchestrator.planner.PlannerLLMClient`` and
``pebble.orchestrator.evaluator.EvaluatorLLMClient`` in one class. One
HTTP connection pool, one cost-accounting path, one error-handling
discipline — shared between the two roles.

Design contracts
----------------

  * **Async-native.** Uses ``anthropic.AsyncAnthropic`` so a request's
    LLM call doesn't block the event loop. Sync ``ModelClient`` (used
    by the prospect research pipeline) stays untouched — that pipeline
    runs as a long batch, sync is fine there.

  * **Prompt caching ON by default.** The planner / evaluator system
    prompts are static across requests (~500 tokens each). We attach
    ``cache_control={"type": "ephemeral"}`` so Anthropic caches the
    prefix; subsequent calls within the 5-minute TTL hit at 10× lower
    input cost. ~20% saving across the typical conversation budget.

  * **One retry layer only.** This client does NOT retry on its own.
    The planner already retries once on malformed JSON; piling another
    retry layer here would mean 2-4 LLM calls on the unhappy path —
    fast way to blow the budget and confuse cost telemetry. On any
    SDK exception, we surface a clear ``AnthropicLLMError`` (or, for
    protocol callers, a ``PlannerLLMResponse(text="", stop_reason="error")``
    so the existing planner-level retry catches it cleanly).

  * **Cost accounting per call.** Every response returns token counts
    we feed into ``calculate_cost_usd`` — including the cache-creation
    and cache-read tokens that prompt caching produces. The orchestrator
    persists the cost into ``bedrock.pebble_chat_scratchpad.cost_usd``
    for the daily-cap and forensics.

  * **Singleton lifecycle.** One ``AsyncAnthropic`` per process. The
    FastAPI app constructs at lifespan startup and ``aclose()``s at
    shutdown so the underlying httpx connection pool drains cleanly.

  * **No silent fallbacks.** If ``ANTHROPIC_API_KEY`` is missing at
    construction we still construct (the SDK raises only on first
    call) — but the caller's existing path-around-no-client logic in
    ``pebble.handlers.dispatch_handler`` continues to short-circuit
    before the orchestrator ever gets here. We are NOT in the business
    of inventing a fake response when the real provider is down.

Interactions with the rest of the system
----------------------------------------

  * ``pebble.orchestrator.planner.Planner(client=AnthropicLLMClient())``
    — planner protocol satisfied.
  * ``pebble.orchestrator.evaluator.Evaluator(client=AnthropicLLMClient())``
    — evaluator protocol satisfied.
  * ``pebble.main.lifespan`` constructs / closes the singleton.
  * Tests inject an ``AnthropicLLMClient(client=<mock>)`` to control
    the AsyncAnthropic stand-in. See ``tests/test_llm_anthropic_client.py``.

What this file deliberately does NOT do
---------------------------------------

  * Streaming. The planner+evaluator protocols return whole-text
    responses — the agent's *outer* SSE stream is the orchestrator's
    job. Anthropic's streaming API would only help for the answer
    text, which we render via templates in v1.0.
  * Tool-use round-tripping. The planner uses Anthropic's tool API
    only to expose tool definitions to Sonnet — the assistant emits
    plain JSON describing a Plan, not ``tool_use`` content blocks.
    Multi-turn tool execution is the *orchestrator's* layer, not the
    LLM client's.
  * Anthropic Bedrock / Vertex routing. Direct API only for v1.0.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger(__name__)


# Avoid a hard import of ``anthropic`` at module-load time so test
# environments without the SDK can still import this file (e.g. for
# the cost helper). The real client raises ImportError on construction
# when the SDK is missing — same observable as a missing API key.
try:  # pragma: no cover — covered by integration tests with the SDK installed
    from anthropic import AsyncAnthropic
    from anthropic import APIError as _APIError
    from anthropic import RateLimitError as _RateLimitError
    from anthropic import APIConnectionError as _APIConnectionError
    from anthropic import APITimeoutError as _APITimeoutError
    _SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    AsyncAnthropic = None  # type: ignore[assignment]
    _APIError = Exception  # type: ignore[assignment]
    _RateLimitError = Exception  # type: ignore[assignment]
    _APIConnectionError = Exception  # type: ignore[assignment]
    _APITimeoutError = Exception  # type: ignore[assignment]
    _SDK_AVAILABLE = False


from .cost import calculate_cost_usd

# Lazy import the protocol response shapes — done inside methods so the
# circular import doesn't bite at module load. The planner / evaluator
# modules already import ``schemas`` heavily; we don't want them to
# also pull this LLM module's transitive deps.


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AnthropicLLMError(Exception):
    """Raised when the Anthropic API call fails in a way the protocol
    callers cannot recover from. The planner / evaluator each have
    their own exception-catching path, so this is rarely surfaced —
    but tests assert against it for the explicit-error scenario.
    """


# ---------------------------------------------------------------------------
# Defaults — overridable via env so ops can swap models without redeploy.
#
# Env reads happen INSIDE the constructor (not at module load) so tests
# can monkey-patch env vars without reloading the module — module reload
# creates fresh class objects and breaks ``pytest.raises`` identity
# checks (the imported-at-top reference goes stale).
# ---------------------------------------------------------------------------

_DEFAULT_PLANNER_MODEL_FALLBACK = "claude-sonnet-4-6"
_DEFAULT_EVALUATOR_MODEL_FALLBACK = "claude-haiku-4-5-20251001"
# Token budgets are conservative defaults; real callers pass explicit
# max_tokens values via the protocol arg.
_DEFAULT_PLANNER_MAX_TOKENS = 2048
_DEFAULT_EVALUATOR_MAX_TOKENS = 1024


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_system_blocks(system_text: str, *, cache: bool) -> list[dict[str, Any]]:
    """Anthropic's system parameter accepts either a string OR a list
    of typed blocks. Caching requires the list form — the
    ``cache_control`` field is per-block. We always convert to the
    list form so the call shape is uniform.

    Why always-list: makes test assertions trivial (no two-shape
    branching), and the runtime cost of the longer payload is
    negligible (one wrapping object, not per-token).
    """
    block: dict[str, Any] = {"type": "text", "text": system_text}
    if cache:
        block["cache_control"] = {"type": "ephemeral"}
    return [block]


def _extract_text(response_content: Any) -> str:
    """Anthropic's response.content is a list of typed blocks. For our
    use case (planner / evaluator) we expect ``[{type:'text', text:'...'}]``.
    Tool-use blocks are unexpected in this context — concatenate any
    text blocks we find and silently drop other types so a
    surprise-typed response degrades gracefully rather than crashing.
    """
    if response_content is None:
        return ""
    if isinstance(response_content, str):
        return response_content
    parts: list[str] = []
    for block in response_content:
        # SDK returns typed objects; duck-type rather than isinstance-check
        # so test stubs with plain dicts also work.
        block_type = getattr(block, "type", None) or (
            block.get("type") if isinstance(block, dict) else None
        )
        if block_type != "text":
            continue
        text_attr = getattr(block, "text", None)
        if text_attr is None and isinstance(block, dict):
            text_attr = block.get("text", "")
        parts.append(str(text_attr or ""))
    return "".join(parts)


def _extract_usage(usage: Any) -> dict[str, int]:
    """Anthropic's usage object has the fields we care about — both
    pre-cache fields (``input_tokens``, ``output_tokens``) and the
    cache-related ones (``cache_creation_input_tokens``,
    ``cache_read_input_tokens``). Newer SDK versions add fields; we
    default each to 0 if absent.
    """
    if usage is None:
        return {
            "input_tokens": 0, "output_tokens": 0,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        }

    def _g(name: str) -> int:
        # Object attr or dict key; default 0
        v = getattr(usage, name, None)
        if v is None and isinstance(usage, dict):
            v = usage.get(name)
        return int(v or 0)

    return {
        "input_tokens": _g("input_tokens"),
        "output_tokens": _g("output_tokens"),
        "cache_creation_input_tokens": _g("cache_creation_input_tokens"),
        "cache_read_input_tokens": _g("cache_read_input_tokens"),
    }


# ---------------------------------------------------------------------------
# AnthropicLLMClient
# ---------------------------------------------------------------------------

class AnthropicLLMClient:
    """One client, two roles: planner + evaluator.

    Construct once per process. Pass into both
    ``Planner(client=...)`` and ``Evaluator(client=...)``. The class
    methods mirror the protocols' shapes 1:1.

    Test injection: pass ``client=<your AsyncAnthropic stub>`` to
    bypass real-network calls. Production passes ``client=None`` and
    the constructor builds a real ``AsyncAnthropic``.
    """

    def __init__(
        self,
        *,
        client: Optional[Any] = None,
        api_key: Optional[str] = None,
        planner_model: Optional[str] = None,
        evaluator_model: Optional[str] = None,
        planner_max_tokens: int = _DEFAULT_PLANNER_MAX_TOKENS,
        evaluator_max_tokens: int = _DEFAULT_EVALUATOR_MAX_TOKENS,
        enable_prompt_cache: bool = True,
    ) -> None:
        if client is not None:
            # Test path — caller passes a stub we don't construct.
            self._client = client
        else:
            if not _SDK_AVAILABLE:
                raise AnthropicLLMError(
                    "anthropic SDK not installed; cannot construct "
                    "AnthropicLLMClient without an injected stub.",
                )
            # Real path — let the SDK pick up ANTHROPIC_API_KEY from env
            # unless caller passed one explicitly.
            self._client = AsyncAnthropic(api_key=api_key) if api_key else AsyncAnthropic()

        # Read env at construction (not module load) so monkeypatch.setenv
        # in tests works without importlib.reload.
        self.planner_model = (
            planner_model
            or os.getenv("PEBBLE_PLANNER_MODEL")
            or _DEFAULT_PLANNER_MODEL_FALLBACK
        )
        self.evaluator_model = (
            evaluator_model
            or os.getenv("PEBBLE_EVALUATOR_MODEL")
            or _DEFAULT_EVALUATOR_MODEL_FALLBACK
        )
        self.planner_max_tokens = planner_max_tokens
        self.evaluator_max_tokens = evaluator_max_tokens
        self.enable_prompt_cache = enable_prompt_cache

    # ---- Planner protocol ------------------------------------------------

    async def emit_plan(
        self,
        *,
        system: str,
        user: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 2048,
    ):
        """Implements ``PlannerLLMClient.emit_plan``.

        Returns a ``PlannerLLMResponse`` (lazy-imported to avoid
        circular imports). On any SDK error, returns a response with
        empty ``text`` and ``stop_reason='error'`` — the planner's
        existing retry catches this and feeds the error back into the
        prompt for one more shot before declaring PlannerError.
        """
        # Lazy import (see module docstring rationale).
        from pebble.orchestrator.planner import PlannerLLMResponse

        try:
            resp = await self._client.messages.create(
                model=self.planner_model,
                max_tokens=max_tokens or self.planner_max_tokens,
                system=_build_system_blocks(system, cache=self.enable_prompt_cache),
                messages=[{"role": "user", "content": user}],
                tools=tools or [],
            )
        except _RateLimitError as e:
            logger.warning("anthropic.rate_limited model=%s err=%s", self.planner_model, e)
            return PlannerLLMResponse(
                text="", stop_reason="error",
                tokens_in=0, tokens_out=0, cost_usd=0.0,
            )
        except _APITimeoutError as e:
            logger.warning("anthropic.timeout model=%s err=%s", self.planner_model, e)
            return PlannerLLMResponse(
                text="", stop_reason="error",
                tokens_in=0, tokens_out=0, cost_usd=0.0,
            )
        except (_APIConnectionError, _APIError) as e:
            logger.exception("anthropic.api_error model=%s", self.planner_model)
            return PlannerLLMResponse(
                text="", stop_reason="error",
                tokens_in=0, tokens_out=0, cost_usd=0.0,
            )

        text = _extract_text(getattr(resp, "content", None))
        usage = _extract_usage(getattr(resp, "usage", None))
        cost = calculate_cost_usd(model=self.planner_model, **usage)
        stop_reason = str(getattr(resp, "stop_reason", "end_turn") or "end_turn")

        return PlannerLLMResponse(
            text=text,
            cost_usd=cost,
            tokens_in=usage["input_tokens"] + usage["cache_creation_input_tokens"]
                      + usage["cache_read_input_tokens"],
            tokens_out=usage["output_tokens"],
            stop_reason=stop_reason,
        )

    # ---- Evaluator protocol ----------------------------------------------

    async def emit_evaluation(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int = 1024,
    ):
        """Implements ``EvaluatorLLMClient.emit_evaluation``.

        Same contract as ``emit_plan`` minus the tools arg (evaluator
        is judge-only — no tool calls).

        On API error, returns empty-text response. The evaluator's
        existing failsafe-PASS handler treats this as 'evaluator
        unavailable; ship the draft' rather than blocking the user.
        """
        from pebble.orchestrator.evaluator import EvaluatorLLMResponse

        try:
            resp = await self._client.messages.create(
                model=self.evaluator_model,
                max_tokens=max_tokens or self.evaluator_max_tokens,
                system=_build_system_blocks(system, cache=self.enable_prompt_cache),
                messages=[{"role": "user", "content": user}],
            )
        except (_RateLimitError, _APITimeoutError, _APIConnectionError, _APIError) as e:
            logger.warning(
                "anthropic.evaluator_error model=%s err_type=%s",
                self.evaluator_model, type(e).__name__,
            )
            return EvaluatorLLMResponse(
                text="", cost_usd=0.0, tokens_in=0, tokens_out=0,
            )

        text = _extract_text(getattr(resp, "content", None))
        usage = _extract_usage(getattr(resp, "usage", None))
        cost = calculate_cost_usd(model=self.evaluator_model, **usage)

        return EvaluatorLLMResponse(
            text=text,
            cost_usd=cost,
            tokens_in=usage["input_tokens"] + usage["cache_creation_input_tokens"]
                      + usage["cache_read_input_tokens"],
            tokens_out=usage["output_tokens"],
        )

    # ---- Lifecycle -------------------------------------------------------

    async def aclose(self) -> None:
        """Close the underlying AsyncAnthropic. Drains the httpx pool.
        Safe to call multiple times."""
        client = self._client
        close = getattr(client, "close", None) or getattr(client, "aclose", None)
        if close is None:
            return
        try:
            result = close()
            if hasattr(result, "__await__"):
                await result
        except Exception:
            logger.exception("anthropic.aclose_failed")


# ---------------------------------------------------------------------------
# Process-wide singleton (FastAPI lifespan-managed).
# ---------------------------------------------------------------------------

_default_client: Optional[AnthropicLLMClient] = None


def get_default_client() -> AnthropicLLMClient:
    """Return the process-wide singleton, constructing on first call.

    Construction is lazy so import-time of ``pebble.llm`` doesn't
    require ``ANTHROPIC_API_KEY`` to be set — the SDK only checks the
    key on first ``messages.create``. Tests that don't exercise the
    LLM never hit the construct path.

    For test isolation, call ``close_default_client()`` between tests
    that touch the singleton, or pass an explicit
    ``AnthropicLLMClient(client=<stub>)`` instead of relying on the
    singleton.
    """
    global _default_client
    if _default_client is None:
        _default_client = AnthropicLLMClient()
    return _default_client


async def close_default_client() -> None:
    """Close + clear the singleton. FastAPI lifespan calls this at
    shutdown so the connection pool drains. Idempotent.
    """
    global _default_client
    if _default_client is not None:
        try:
            await _default_client.aclose()
        finally:
            _default_client = None
