"""Tests for generate_chart (chisel-migrated)."""

from __future__ import annotations

import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

from pebble.chisel.handler_adapter import HandlerContext
from pebble.chisel.tools.generate_chart.handler import Input, run
from pebble.orchestrator.tools import ToolContext


def _ctx() -> HandlerContext:
    return HandlerContext(ToolContext(user_email="rm@pursuit.org", conversation_id="c1"))


@pytest.mark.asyncio
async def test_emits_chart_spec_shape() -> None:
    out = await run(
        Input(
            kind="bar", title="Pipeline",
            data=[{"name": "Acme", "amount": 100}, {"name": "Beta", "amount": 50}],
            x_key="name", y_keys=("amount",),
        ),
        _ctx(),
    )
    assert out["kind"] == "bar"
    assert out["title"] == "Pipeline"
    assert out["x_key"] == "name"
    assert out["y_keys"] == ["amount"]
    assert out["row_count"] == 2
    assert isinstance(out["chart_id"], str) and len(out["chart_id"]) > 0


def test_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        Input(kind="3d-pie", data=[])  # type: ignore[arg-type]


def test_rejects_non_object_data_rows() -> None:
    with pytest.raises(ValidationError):
        Input(kind="bar", data=["not-an-object"])  # type: ignore[list-item]


@pytest.mark.asyncio
async def test_empty_data_is_valid() -> None:
    out = await run(Input(kind="line", data=[]), _ctx())
    assert out["row_count"] == 0
    assert out["data"] == []
