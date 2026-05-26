"""Tests for search_crm (chisel-migrated)."""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))

from pebble.chisel.handler_adapter import HandlerContext, build_handler_wrapper
from pebble.chisel.tools.search_crm.handler import Input, SearchHTTPError, run
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
async def test_happy_path_collects_citations_and_passes_params() -> None:
    body = {
        "items": [
            {"entity_type": "sf_account", "entity_id": "001A", "name": "Acme"},
            {"entity_type": "sf_account", "entity_id": "001B", "name": "Acme Inc"},
        ],
        "total_count": 2,
        "backend_used": "postgres_fts",
        "took_ms": 14,
    }
    client = _mock_client(get_resp=_mock_resp(200, body))
    hctx = HandlerContext(_ctx_with_client(client))
    out = await run(
        Input(query="acme", types=("sf_account",), limit=10),
        hctx,
    )
    assert out["total_count"] == 2
    assert out["backend_used"] == "postgres_fts"
    assert out["query"] == "acme"
    assert hctx.citations == ("sf_account:001A", "sf_account:001B")
    client.get.assert_awaited_once_with(
        "/api/search", params={"q": "acme", "limit": 10, "types": "sf_account"},
    )


@pytest.mark.asyncio
async def test_5xx_raises() -> None:
    client = _mock_client(get_resp=_mock_resp(500))
    hctx = HandlerContext(_ctx_with_client(client))
    with pytest.raises(SearchHTTPError):
        await run(Input(query="x"), hctx)


def test_rejects_empty_query() -> None:
    with pytest.raises(ValidationError):
        Input(query="")


def test_rejects_too_long_query() -> None:
    with pytest.raises(ValidationError):
        Input(query="a" * 257)


def test_clamps_limit_via_validation() -> None:
    with pytest.raises(ValidationError):
        Input(query="x", limit=0)
    with pytest.raises(ValidationError):
        Input(query="x", limit=101)


@pytest.mark.asyncio
async def test_adapter_wraps_validation_error() -> None:
    wrapped = build_handler_wrapper(
        tool_name="search_crm", tool_version="1.0.0",
        input_model=Input, user_run=run,
    )
    res = await wrapped({"query": ""}, _ctx_with_client(_mock_client(get_resp=_mock_resp(200, {}))))
    assert res.ok is False
    assert "input_validation" in (res.error or "")
