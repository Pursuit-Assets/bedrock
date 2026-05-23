"""Tests for get_record (chisel-migrated)."""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

from pebble.chisel.handler_adapter import HandlerContext, build_handler_wrapper
from pebble.chisel.tools.get_record.handler import (
    Input,
    RecordFetchError,
    RecordNotFound,
    run,
)
from pebble.orchestrator.tools import ToolContext


def _ctx_with_client(client) -> ToolContext:
    return ToolContext(
        user_email="rm@pursuit.org",
        conversation_id="c1",
        http_client=client,
    )


def _mock_resp(status_code: int, json_body=None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json = MagicMock(return_value=json_body or {})
    return resp


def _mock_client(*, get_resp):
    client = MagicMock()
    client.get = AsyncMock(return_value=get_resp)
    return client


@pytest.mark.asyncio
async def test_happy_path_returns_record_with_citation() -> None:
    client = _mock_client(get_resp=_mock_resp(200, {"Id": "001ABC", "Name": "Acme"}))
    hctx = HandlerContext(_ctx_with_client(client))
    out = await run(Input(entity_type="sf_account", entity_id="001ABC"), hctx)
    assert out["entity_type"] == "sf_account"
    assert out["entity_id"] == "001ABC"
    assert out["record"]["Name"] == "Acme"
    assert hctx.citations == ("sf_account:001ABC",)
    client.get.assert_awaited_once_with("/api/salesforce/accounts/001ABC")


@pytest.mark.asyncio
async def test_404_raises_record_not_found() -> None:
    client = _mock_client(get_resp=_mock_resp(404))
    hctx = HandlerContext(_ctx_with_client(client))
    with pytest.raises(RecordNotFound):
        await run(Input(entity_type="sf_account", entity_id="001MISSING"), hctx)


@pytest.mark.asyncio
async def test_5xx_raises_record_fetch_error() -> None:
    client = _mock_client(get_resp=_mock_resp(503))
    hctx = HandlerContext(_ctx_with_client(client))
    with pytest.raises(RecordFetchError):
        await run(Input(entity_type="sf_account", entity_id="001"), hctx)


def test_rejects_unknown_entity_type() -> None:
    with pytest.raises(ValidationError):
        Input(entity_type="random_type", entity_id="x")  # type: ignore[arg-type]


def test_rejects_empty_entity_id() -> None:
    with pytest.raises(ValidationError):
        Input(entity_type="sf_account", entity_id="")


@pytest.mark.asyncio
async def test_adapter_converts_404_to_ok_false() -> None:
    """End-to-end via build_handler_wrapper: RecordNotFound becomes ToolResult ok=False."""
    client = _mock_client(get_resp=_mock_resp(404))
    wrapped = build_handler_wrapper(
        tool_name="get_record", tool_version="1.0.0",
        input_model=Input, user_run=run,
    )
    res = await wrapped(
        {"entity_type": "sf_account", "entity_id": "001X"},
        _ctx_with_client(client),
    )
    assert res.ok is False
    assert "RecordNotFound" in (res.error or "")
    assert res.tool_version == "1.0.0"
