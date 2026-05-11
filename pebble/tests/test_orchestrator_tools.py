"""Tests for ``pebble.orchestrator.tools`` — registry + ToolSpec
shape + dispatch behavior.
"""

import os
import sys
from uuid import uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.schemas import ToolResult
from pebble.orchestrator.tools import (
    DEFAULT_REGISTRY,
    ToolContext,
    ToolRegistry,
    ToolSpec,
    make_input_schema,
)


def _ctx(**kw) -> ToolContext:
    return ToolContext(
        user_email=kw.get("user_email", "u@x.org"),
        conversation_id=kw.get("conversation_id", str(uuid4())),
        org_id=kw.get("org_id", "pursuit"),
    )


async def _stub_handler(args, ctx):
    return ToolResult(step_id=uuid4(), tool="stub", ok=True, data=args)


def _spec(name="stub", **kw) -> ToolSpec:
    return ToolSpec(
        name=name,
        description=kw.get("description", "test stub"),
        input_schema=kw.get("input_schema", make_input_schema(properties={})),
        handler=kw.get("handler", _stub_handler),
        cost_estimate_usd=kw.get("cost_estimate_usd", 0.0),
        requires_human=kw.get("requires_human", False),
    )


# ---------------------------------------------------------------------------
# Registry: register / get / iter / names
# ---------------------------------------------------------------------------

def test_register_adds_spec():
    reg = ToolRegistry()
    reg.register(_spec("alpha"))
    assert "alpha" in reg
    assert len(reg) == 1
    assert reg.get("alpha").name == "alpha"


def test_register_rejects_duplicate_name():
    reg = ToolRegistry()
    reg.register(_spec("alpha"))
    with pytest.raises(ValueError, match=r"already registered"):
        reg.register(_spec("alpha"))


def test_register_rejects_sync_handler():
    """Handlers must be async — the orchestrator awaits them. A sync
    handler would silently no-op (it returns a coroutine-less value
    that AsyncMock would happily accept). Catch at registration time.
    """
    def sync_handler(args, ctx):
        return None

    reg = ToolRegistry()
    with pytest.raises(TypeError, match=r"async"):
        reg.register(_spec("alpha", handler=sync_handler))


def test_get_unknown_returns_none():
    reg = ToolRegistry()
    assert reg.get("does_not_exist") is None


def test_iter_specs_preserves_insertion_order():
    """Planner sees tools in registration order — stable contract."""
    reg = ToolRegistry()
    reg.register(_spec("first"))
    reg.register(_spec("second"))
    reg.register(_spec("third"))
    assert [s.name for s in reg.iter_specs()] == ["first", "second", "third"]


def test_unregister_drops_spec():
    reg = ToolRegistry()
    reg.register(_spec("alpha"))
    reg.unregister("alpha")
    assert "alpha" not in reg


def test_unregister_unknown_is_noop():
    reg = ToolRegistry()
    reg.unregister("does_not_exist")    # must not raise


# ---------------------------------------------------------------------------
# Anthropic-shape export
# ---------------------------------------------------------------------------

def test_to_anthropic_dict_shape():
    spec = _spec(
        "search_crm",
        description="Cross-entity search.",
        input_schema={"type": "object", "properties": {"q": {"type": "string"}}},
    )
    d = spec.to_anthropic_dict()
    assert d == {
        "name": "search_crm",
        "description": "Cross-entity search.",
        "input_schema": {"type": "object", "properties": {"q": {"type": "string"}}},
    }
    # No accidental keys leaking — Anthropic API rejects unknown keys.
    assert set(d.keys()) == {"name", "description", "input_schema"}


def test_to_anthropic_list_iterates_in_order():
    reg = ToolRegistry()
    reg.register(_spec("a"))
    reg.register(_spec("b"))
    out = reg.to_anthropic_list()
    assert [d["name"] for d in out] == ["a", "b"]


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_invoke_calls_registered_handler():
    captured = {}

    async def handler(args, ctx):
        captured["args"] = args
        captured["user"] = ctx.user_email
        return ToolResult(step_id=uuid4(), tool="x", ok=True, data={"echo": args})

    reg = ToolRegistry()
    reg.register(_spec("echo", handler=handler))
    result = await reg.invoke("echo", {"hi": "there"}, _ctx())
    assert result.ok is True
    assert result.data == {"echo": {"hi": "there"}}
    assert captured["user"] == "u@x.org"


@pytest.mark.asyncio
async def test_invoke_unknown_tool_returns_failure():
    reg = ToolRegistry()
    result = await reg.invoke("missing", {}, _ctx())
    assert result.ok is False
    assert "unknown_tool" in result.error
    assert "missing" in result.error


@pytest.mark.asyncio
async def test_invoke_handler_exception_wrapped():
    """Handler exceptions become ToolResult(ok=False) — never crash
    the orchestrator. A broken tool fails its step; the rest of the
    plan can continue."""
    async def boom(args, ctx):
        raise RuntimeError("tool internal failure")
    reg = ToolRegistry()
    reg.register(_spec("boom", handler=boom))
    result = await reg.invoke("boom", {}, _ctx())
    assert result.ok is False
    assert "RuntimeError" in result.error
    assert "tool internal failure" in result.error


# ---------------------------------------------------------------------------
# make_input_schema helper
# ---------------------------------------------------------------------------

def test_make_input_schema_strict_default():
    schema = make_input_schema(
        properties={"q": {"type": "string"}},
        required_keys=["q"],
    )
    assert schema["type"] == "object"
    assert schema["additionalProperties"] is False
    assert schema["required"] == ["q"]


def test_make_input_schema_allows_additional_when_explicit():
    schema = make_input_schema(
        properties={"q": {"type": "string"}},
        additional_properties=True,
    )
    assert "additionalProperties" not in schema


# ---------------------------------------------------------------------------
# DEFAULT_REGISTRY isolation
# ---------------------------------------------------------------------------

def test_default_registry_is_separate_from_test_registries():
    test_reg = ToolRegistry()
    test_reg.register(_spec("test_only"))
    assert "test_only" not in DEFAULT_REGISTRY
    # Cleanup just in case.
    test_reg.unregister("test_only")
