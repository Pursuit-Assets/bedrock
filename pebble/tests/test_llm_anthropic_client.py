"""Tests for ``pebble.llm.anthropic_client`` — the AsyncAnthropic
wrapper implementing ``PlannerLLMClient`` + ``EvaluatorLLMClient``.

Strategy
--------

Two test modes:

1. **Pure mocks** — fast, deterministic, no external dependencies.
   A FakeAsyncAnthropic stub implements ``messages.create`` returning
   canned response objects. Every behavior contract is asserted here.

2. **Cassettes** — recorded JSON of real Anthropic responses captured
   under realistic prompts. Replayed via the same FakeAsyncAnthropic
   shim. Two cassettes ship with the repo:

       fixtures/anthropic_cassettes/planner_search_acme.json
       fixtures/anthropic_cassettes/evaluator_pass.json

   These give us confidence the parser handles real API shapes
   without burning API spend on every test run.

Asserts:
  A. Happy path planner — text extracted, cost > 0, tokens populated.
  B. Happy path evaluator — same but EvaluatorLLMResponse shape.
  C. Prompt cache ON → system blocks include cache_control.
  D. Prompt cache OFF → system blocks omit cache_control.
  E. RateLimitError → returns empty-text PlannerLLMResponse w/ stop_reason='error'.
  F. APITimeoutError → same empty-text path.
  G. APIError → same empty-text path.
  H. Evaluator API error → empty-text EvaluatorLLMResponse, no exception raised.
  I. Default models read from env (PEBBLE_PLANNER_MODEL / PEBBLE_EVALUATOR_MODEL).
  J. Constructor honors per-call max_tokens override.
  K. _extract_text handles list of typed blocks, dicts, strings, None.
  L. _extract_usage handles object attrs, dict keys, missing usage.
  M. Tokens reported include cache_creation + cache_read in tokens_in.
  N. aclose() drains client cleanly; idempotent.
  O. get_default_client / close_default_client singleton lifecycle.
  P. Cassette: planner_search_acme replays into a valid Plan-like response.
  Q. Cassette: evaluator_pass replays into a valid Evaluation-like response.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.llm import anthropic_client as ac_mod
from pebble.llm.anthropic_client import (
    AnthropicLLMClient,
    AnthropicLLMError,
    _build_system_blocks,
    _extract_text,
    _extract_usage,
    close_default_client,
    get_default_client,
)


# ---------------------------------------------------------------------------
# Simple exception types for error-path tests.
#
# Real ``anthropic.APIError`` / ``RateLimitError`` etc. require complex
# constructor args (httpx.Request, etc.) and are awkward to instantiate
# in tests. Instead, our tests monkey-patch the client's ``_RateLimitError``
# / ``_APIError`` etc. *references* to be simple Exception subclasses
# we can construct freely. The client's ``except _RateLimitError`` blocks
# then catch them transparently.
# ---------------------------------------------------------------------------

class _SimRateLimit(Exception):
    pass


class _SimTimeout(Exception):
    pass


class _SimAPIConn(Exception):
    pass


class _SimAPIError(Exception):
    pass


@pytest.fixture
def patched_errors(monkeypatch):
    """Replace the client's exception-class references with simple ones
    so tests can raise / catch without the SDK's required-arg friction.
    """
    monkeypatch.setattr(ac_mod, "_RateLimitError", _SimRateLimit)
    monkeypatch.setattr(ac_mod, "_APITimeoutError", _SimTimeout)
    monkeypatch.setattr(ac_mod, "_APIConnectionError", _SimAPIConn)
    monkeypatch.setattr(ac_mod, "_APIError", _SimAPIError)
    return None


# ---------------------------------------------------------------------------
# FakeAsyncAnthropic — stand-in for ``anthropic.AsyncAnthropic``.
# ---------------------------------------------------------------------------

class _FakeUsage:
    """Mirrors anthropic.types.Usage object shape."""
    def __init__(
        self,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_creation_input_tokens: int = 0,
        cache_read_input_tokens: int = 0,
    ) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.cache_creation_input_tokens = cache_creation_input_tokens
        self.cache_read_input_tokens = cache_read_input_tokens


class _FakeTextBlock:
    type = "text"
    def __init__(self, text: str) -> None:
        self.text = text


class _FakeMessage:
    """Mirrors anthropic.types.Message object shape — text-only content."""
    def __init__(
        self,
        text: str,
        *,
        usage: Optional[_FakeUsage] = None,
        stop_reason: str = "end_turn",
    ) -> None:
        self.content = [_FakeTextBlock(text)]
        self.usage = usage or _FakeUsage()
        self.stop_reason = stop_reason


class FakeAsyncAnthropic:
    """Captures kwargs passed to messages.create + returns canned responses.

    Test pattern:
        fake = FakeAsyncAnthropic(responses=[_FakeMessage("..."), ...])
        client = AnthropicLLMClient(client=fake)
        resp = await client.emit_plan(...)
        assert fake.calls[0]["model"] == "claude-sonnet-4-6"
    """

    def __init__(
        self, responses: Optional[list[Any]] = None,
        *, raise_for_call: Optional[BaseException] = None,
    ) -> None:
        self._responses: list[Any] = list(responses or [])
        self._raise = raise_for_call
        self.calls: list[dict[str, Any]] = []
        self.closed = False
        self.messages = self  # mirror SDK's nested ``client.messages.create`` access

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if self._raise is not None:
            raise self._raise
        if not self._responses:
            raise AssertionError(
                "FakeAsyncAnthropic exhausted — test expected fewer create() calls",
            )
        head = self._responses.pop(0)
        if isinstance(head, BaseException):
            raise head
        return head

    async def aclose(self) -> None:
        self.closed = True


# ---------------------------------------------------------------------------
# A. Happy path planner
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_planner_happy_path_returns_text_and_cost():
    fake = FakeAsyncAnthropic(responses=[
        _FakeMessage(
            text='{"rationale":"...","steps":[]}',
            usage=_FakeUsage(input_tokens=500, output_tokens=200),
        ),
    ])
    client = AnthropicLLMClient(client=fake, planner_model="claude-sonnet-4-6")

    resp = await client.emit_plan(
        system="planner system prompt",
        user="user query",
        tools=[{"name": "search_crm", "description": "x", "input_schema": {}}],
    )
    assert resp.text == '{"rationale":"...","steps":[]}'
    assert resp.cost_usd > 0
    assert resp.tokens_in == 500
    assert resp.tokens_out == 200
    assert resp.stop_reason == "end_turn"

    # Verify call shape
    call = fake.calls[0]
    assert call["model"] == "claude-sonnet-4-6"
    assert call["messages"] == [{"role": "user", "content": "user query"}]
    assert call["tools"][0]["name"] == "search_crm"


# ---------------------------------------------------------------------------
# B. Happy path evaluator
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_evaluator_happy_path_returns_text_and_cost():
    fake = FakeAsyncAnthropic(responses=[
        _FakeMessage(
            text='{"verdict":"pass","factuality":0.9}',
            usage=_FakeUsage(input_tokens=300, output_tokens=80),
        ),
    ])
    client = AnthropicLLMClient(client=fake, evaluator_model="claude-haiku-4-5-20251001")

    resp = await client.emit_evaluation(
        system="evaluator system prompt",
        user="trace + draft",
    )
    assert resp.text == '{"verdict":"pass","factuality":0.9}'
    assert resp.cost_usd > 0
    assert resp.tokens_in == 300
    assert resp.tokens_out == 80

    call = fake.calls[0]
    assert call["model"] == "claude-haiku-4-5-20251001"
    # Evaluator should NOT pass tools (it's judge-only)
    assert "tools" not in call


# ---------------------------------------------------------------------------
# C. Prompt cache ON → cache_control on system blocks
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prompt_cache_on_attaches_cache_control():
    fake = FakeAsyncAnthropic(responses=[_FakeMessage("ok")])
    client = AnthropicLLMClient(client=fake, enable_prompt_cache=True)
    await client.emit_plan(system="sys", user="u", tools=[])
    call = fake.calls[0]
    assert isinstance(call["system"], list)
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}


# ---------------------------------------------------------------------------
# D. Prompt cache OFF → no cache_control
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prompt_cache_off_omits_cache_control():
    fake = FakeAsyncAnthropic(responses=[_FakeMessage("ok")])
    client = AnthropicLLMClient(client=fake, enable_prompt_cache=False)
    await client.emit_plan(system="sys", user="u", tools=[])
    call = fake.calls[0]
    assert "cache_control" not in call["system"][0]


# ---------------------------------------------------------------------------
# E, F, G. Errors → empty-text PlannerLLMResponse
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_planner_rate_limit_returns_empty_response(patched_errors):
    fake = FakeAsyncAnthropic(responses=[_SimRateLimit("simulated rate limit")])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_plan(system="s", user="u", tools=[])
    assert resp.text == ""
    assert resp.stop_reason == "error"
    assert resp.cost_usd == 0.0


@pytest.mark.asyncio
async def test_planner_timeout_returns_empty_response(patched_errors):
    fake = FakeAsyncAnthropic(responses=[_SimTimeout("simulated timeout")])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_plan(system="s", user="u", tools=[])
    assert resp.text == ""
    assert resp.stop_reason == "error"


@pytest.mark.asyncio
async def test_planner_api_error_returns_empty_response(patched_errors):
    fake = FakeAsyncAnthropic(responses=[_SimAPIError("simulated 500")])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_plan(system="s", user="u", tools=[])
    assert resp.text == ""
    assert resp.stop_reason == "error"


@pytest.mark.asyncio
async def test_planner_api_connection_error_returns_empty_response(patched_errors):
    fake = FakeAsyncAnthropic(responses=[_SimAPIConn("connection reset")])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_plan(system="s", user="u", tools=[])
    assert resp.text == ""
    assert resp.stop_reason == "error"


# ---------------------------------------------------------------------------
# H. Evaluator API error → empty-text response, no exception
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_evaluator_api_error_returns_empty_response(patched_errors):
    fake = FakeAsyncAnthropic(responses=[_SimAPIError("simulated 500")])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_evaluation(system="s", user="u")
    assert resp.text == ""
    assert resp.cost_usd == 0.0


@pytest.mark.asyncio
async def test_evaluator_rate_limit_returns_empty_response(patched_errors):
    fake = FakeAsyncAnthropic(responses=[_SimRateLimit("rl")])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_evaluation(system="s", user="u")
    assert resp.text == ""
    assert resp.cost_usd == 0.0


# ---------------------------------------------------------------------------
# I. Env-overridable defaults — read at construction time, no module reload.
# ---------------------------------------------------------------------------

def test_default_models_overridable_via_env(monkeypatch):
    monkeypatch.setenv("PEBBLE_PLANNER_MODEL", "claude-sonnet-fake")
    monkeypatch.setenv("PEBBLE_EVALUATOR_MODEL", "claude-haiku-fake")
    fake = FakeAsyncAnthropic(responses=[])
    client = AnthropicLLMClient(client=fake)
    assert client.planner_model == "claude-sonnet-fake"
    assert client.evaluator_model == "claude-haiku-fake"


def test_constructor_explicit_models_override_env(monkeypatch):
    monkeypatch.setenv("PEBBLE_PLANNER_MODEL", "claude-from-env")
    fake = FakeAsyncAnthropic(responses=[])
    client = AnthropicLLMClient(
        client=fake, planner_model="claude-explicit",
    )
    assert client.planner_model == "claude-explicit"


def test_default_models_when_env_unset(monkeypatch):
    """Without env override, fallback to the canonical defaults."""
    monkeypatch.delenv("PEBBLE_PLANNER_MODEL", raising=False)
    monkeypatch.delenv("PEBBLE_EVALUATOR_MODEL", raising=False)
    fake = FakeAsyncAnthropic(responses=[])
    client = AnthropicLLMClient(client=fake)
    assert client.planner_model == "claude-sonnet-4-6"
    assert client.evaluator_model == "claude-haiku-4-5-20251001"


# ---------------------------------------------------------------------------
# J. max_tokens passed through
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_max_tokens_per_call_passed_through():
    fake = FakeAsyncAnthropic(responses=[_FakeMessage("ok")])
    client = AnthropicLLMClient(client=fake)
    await client.emit_plan(system="s", user="u", tools=[], max_tokens=512)
    assert fake.calls[0]["max_tokens"] == 512


@pytest.mark.asyncio
async def test_evaluator_max_tokens_per_call():
    fake = FakeAsyncAnthropic(responses=[_FakeMessage("ok")])
    client = AnthropicLLMClient(client=fake)
    await client.emit_evaluation(system="s", user="u", max_tokens=256)
    assert fake.calls[0]["max_tokens"] == 256


# ---------------------------------------------------------------------------
# K. _extract_text handles every shape we'd see
# ---------------------------------------------------------------------------

def test_extract_text_from_typed_blocks():
    blocks = [_FakeTextBlock("hello"), _FakeTextBlock(" world")]
    assert _extract_text(blocks) == "hello world"


def test_extract_text_from_dicts():
    blocks = [{"type": "text", "text": "from"}, {"type": "text", "text": " dict"}]
    assert _extract_text(blocks) == "from dict"


def test_extract_text_skips_non_text_blocks():
    blocks = [
        _FakeTextBlock("real"),
        {"type": "tool_use", "id": "x", "input": {}, "name": "y"},
        _FakeTextBlock(" text"),
    ]
    assert _extract_text(blocks) == "real text"


def test_extract_text_handles_string_input():
    # Defensive: SDK could in theory return content as a plain string
    assert _extract_text("plain") == "plain"


def test_extract_text_handles_none():
    assert _extract_text(None) == ""


def test_extract_text_handles_empty_list():
    assert _extract_text([]) == ""


# ---------------------------------------------------------------------------
# L. _extract_usage shape handling
# ---------------------------------------------------------------------------

def test_extract_usage_from_object():
    u = _FakeUsage(
        input_tokens=10, output_tokens=20,
        cache_creation_input_tokens=5, cache_read_input_tokens=3,
    )
    out = _extract_usage(u)
    assert out == {
        "input_tokens": 10, "output_tokens": 20,
        "cache_creation_input_tokens": 5, "cache_read_input_tokens": 3,
    }


def test_extract_usage_from_dict():
    u = {"input_tokens": 7, "output_tokens": 14,
         "cache_creation_input_tokens": 0, "cache_read_input_tokens": 4}
    out = _extract_usage(u)
    assert out["input_tokens"] == 7
    assert out["cache_read_input_tokens"] == 4


def test_extract_usage_handles_none():
    out = _extract_usage(None)
    assert out == {
        "input_tokens": 0, "output_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
    }


def test_extract_usage_handles_missing_cache_fields():
    """Older SDK versions may not include cache_creation_input_tokens."""
    class _OldUsage:
        input_tokens = 100
        output_tokens = 50
    out = _extract_usage(_OldUsage())
    assert out["input_tokens"] == 100
    assert out["output_tokens"] == 50
    assert out["cache_creation_input_tokens"] == 0
    assert out["cache_read_input_tokens"] == 0


# ---------------------------------------------------------------------------
# M. tokens_in includes cache tokens
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tokens_in_includes_cache_creation_and_read():
    fake = FakeAsyncAnthropic(responses=[
        _FakeMessage(
            text="ok",
            usage=_FakeUsage(
                input_tokens=100,
                output_tokens=50,
                cache_creation_input_tokens=400,  # one-time cache write
                cache_read_input_tokens=600,      # cache hit
            ),
        ),
    ])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_plan(system="s", user="u", tools=[])
    # tokens_in surfaces TOTAL input footprint for cost forensics
    assert resp.tokens_in == 100 + 400 + 600
    assert resp.tokens_out == 50


# ---------------------------------------------------------------------------
# N. aclose lifecycle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_aclose_drains_client():
    fake = FakeAsyncAnthropic(responses=[])
    client = AnthropicLLMClient(client=fake)
    await client.aclose()
    assert fake.closed is True


@pytest.mark.asyncio
async def test_aclose_idempotent():
    fake = FakeAsyncAnthropic(responses=[])
    client = AnthropicLLMClient(client=fake)
    await client.aclose()
    await client.aclose()  # should not raise
    assert fake.closed is True


@pytest.mark.asyncio
async def test_aclose_tolerates_missing_close_method():
    """Stub without close/aclose method should not crash."""
    bare = MagicMock(spec=[])  # no methods
    bare.messages = MagicMock()
    client = AnthropicLLMClient(client=bare)
    await client.aclose()  # no-op, no exception


# ---------------------------------------------------------------------------
# O. Singleton lifecycle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_default_client_singleton(monkeypatch):
    """get_default_client returns the same instance on repeated calls."""
    # Monkey-patch the SDK so construction works without a real key
    monkeypatch.setattr(ac_mod, "_SDK_AVAILABLE", True)
    fake_class = MagicMock(return_value=FakeAsyncAnthropic(responses=[]))
    monkeypatch.setattr(ac_mod, "AsyncAnthropic", fake_class)
    # Also reset the singleton between tests
    monkeypatch.setattr(ac_mod, "_default_client", None)

    c1 = get_default_client()
    c2 = get_default_client()
    assert c1 is c2

    await close_default_client()
    assert ac_mod._default_client is None


def test_default_client_raises_when_sdk_missing(monkeypatch):
    monkeypatch.setattr(ac_mod, "_SDK_AVAILABLE", False)
    monkeypatch.setattr(ac_mod, "_default_client", None)
    with pytest.raises(AnthropicLLMError):
        AnthropicLLMClient()


@pytest.mark.asyncio
async def test_close_default_client_idempotent(monkeypatch):
    monkeypatch.setattr(ac_mod, "_default_client", None)
    await close_default_client()  # nothing to close
    await close_default_client()  # still nothing


# ---------------------------------------------------------------------------
# Cassette helpers
# ---------------------------------------------------------------------------

_FIXTURES = Path(__file__).parent / "fixtures" / "anthropic_cassettes"


def _load_cassette(name: str) -> _FakeMessage:
    """Load a recorded API response and adapt it to the FakeMessage
    shape so the client can parse it as if it came from the SDK.
    """
    path = _FIXTURES / name
    with path.open() as f:
        data = json.load(f)
    text = "".join(b["text"] for b in data["content"] if b["type"] == "text")
    usage = data["usage"]
    return _FakeMessage(
        text=text,
        usage=_FakeUsage(
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
            cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
        ),
        stop_reason=data.get("stop_reason", "end_turn"),
    )


# ---------------------------------------------------------------------------
# P. Cassette: planner_search_acme parses cleanly
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cassette_planner_search_acme():
    msg = _load_cassette("planner_search_acme.json")
    fake = FakeAsyncAnthropic(responses=[msg])
    client = AnthropicLLMClient(client=fake, planner_model="claude-sonnet-4-6")
    resp = await client.emit_plan(
        system="planner system",
        user="Tell me about Acme Corp",
        tools=[
            {"name": "search_crm", "description": "x", "input_schema": {}},
        ],
    )
    # The cassette text is valid JSON containing a one-step plan
    parsed = json.loads(resp.text)
    assert parsed["steps"][0]["tool"] == "search_crm"
    assert parsed["steps"][0]["args"]["query"] == "Acme Corp"
    # Cost reflects Sonnet rates × the recorded token counts
    assert resp.cost_usd > 0
    assert resp.tokens_in == 612
    assert resp.tokens_out == 184


# ---------------------------------------------------------------------------
# Q. Cassette: evaluator_pass parses cleanly
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cassette_evaluator_pass():
    msg = _load_cassette("evaluator_pass.json")
    fake = FakeAsyncAnthropic(responses=[msg])
    client = AnthropicLLMClient(client=fake)
    resp = await client.emit_evaluation(system="evaluator system", user="trace + draft")
    parsed = json.loads(resp.text)
    assert parsed["verdict"] == "pass"
    assert parsed["factuality"] == 0.92
    assert resp.cost_usd > 0
    assert resp.tokens_in == 425
    assert resp.tokens_out == 78


# ---------------------------------------------------------------------------
# Misc — _build_system_blocks shape contract
# ---------------------------------------------------------------------------

def test_build_system_blocks_with_cache():
    blocks = _build_system_blocks("hi", cache=True)
    assert blocks == [
        {"type": "text", "text": "hi", "cache_control": {"type": "ephemeral"}}
    ]


def test_build_system_blocks_without_cache():
    blocks = _build_system_blocks("hi", cache=False)
    assert blocks == [{"type": "text", "text": "hi"}]
