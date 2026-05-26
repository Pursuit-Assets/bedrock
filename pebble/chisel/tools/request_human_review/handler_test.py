"""Tests for request_human_review (chisel-migrated)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

from pebble.chisel.autoload import autoload
from pebble.chisel.handler_adapter import HandlerContext
from pebble.chisel.tools.request_human_review.handler import Input, run
from pebble.orchestrator.tools import ToolContext, ToolRegistry


def _ctx() -> HandlerContext:
    return HandlerContext(ToolContext(user_email="rm@pursuit.org", conversation_id="c1"))


@pytest.mark.asyncio
async def test_handler_returns_checkpoint_payload() -> None:
    out = await run(Input(reason="ambiguous record"), _ctx())
    assert out == {
        "checkpoint": True,
        "reason": "ambiguous record",
        "options": [],
    }


@pytest.mark.asyncio
async def test_handler_passes_options_through() -> None:
    out = await run(Input(reason="pick one", options=("Acme", "Beta Corp")), _ctx())
    assert out["options"] == ["Acme", "Beta Corp"]
    assert out["checkpoint"] is True


def test_handler_rejects_empty_reason() -> None:
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        Input(reason="")


def test_autoload_registers_tool() -> None:
    """Behavioural parity: autoload discovers this manifest + handler,
    registers a working ToolSpec with strict schema and requires_human=True."""
    reg = ToolRegistry()
    root = Path(__file__).resolve().parents[3] / "chisel"
    report = autoload(registry=reg, root=root)
    assert "request_human_review" not in (e[0] for e in report.errors)
    spec = reg.get("request_human_review")
    assert spec is not None
    assert spec.requires_human is True
    assert spec.input_schema["additionalProperties"] is False
    assert "reason" in spec.input_schema["properties"]
