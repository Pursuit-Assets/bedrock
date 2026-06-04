"""Tests for ``pebble.orchestrator.scratchpad`` — the durable state
layer that captures every orchestrator step.

Asserts:
  A. ScratchpadStep auto-mints UUID when not provided.
  B. step_number monotonic per writer instance.
  C. Convenience methods set the correct step_type.
  D. INSERT SQL shape + parameter order.
  E. Insert failure logs but never raises.
  F. JSON dict columns get pre-serialized (asyncpg JSONB ergonomics).
  G. Pool-less init → returns step_id without DB hit (degraded ok).
"""

import json
import os
import sys
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.scratchpad import (
    ScratchpadStep,
    ScratchpadWriter,
    _to_json,
)


def _make_writer(pool=None) -> ScratchpadWriter:
    return ScratchpadWriter(
        pool=pool,
        conversation_id=uuid4(),
        user_email="u@x.org",
        org_id="pursuit",
    )


# ---------------------------------------------------------------------------
# A. Auto-mint UUID
# ---------------------------------------------------------------------------

def test_scratchpad_step_auto_mints_id():
    s = ScratchpadStep(
        conversation_id=uuid4(), step_number=1,
        step_type="plan", user_email="u@x.org",
    )
    assert isinstance(s.step_id, UUID)


def test_scratchpad_step_explicit_id_preserved():
    eid = uuid4()
    s = ScratchpadStep(
        conversation_id=uuid4(), step_number=1,
        step_type="plan", user_email="u@x.org", step_id=eid,
    )
    assert s.step_id == eid


# ---------------------------------------------------------------------------
# B. step_number monotonic
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_step_number_monotonic_within_writer():
    w = _make_writer()
    captured = []

    async def fake_append(step):
        captured.append(step.step_number)
        return step.step_id

    w.append = fake_append    # bypass DB

    await w.write_plan({"plan": "x"})
    await w.write_tool_call("search_crm", {"q": "x"})
    await w.write_tool_result("search_crm", {"items": []})
    await w.write_evaluation({"verdict": "pass"})
    assert captured == [1, 2, 3, 4]


# ---------------------------------------------------------------------------
# C. step_type per convenience method
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_convenience_methods_set_correct_step_type():
    w = _make_writer()
    captured: list[ScratchpadStep] = []

    async def fake_append(step):
        captured.append(step)
        return step.step_id

    w.append = fake_append

    await w.write_plan({})
    await w.write_tool_call("t", {})
    await w.write_tool_result("t", {})
    await w.write_evaluation({})
    await w.write_render({})
    await w.write_conflict({})
    await w.write_checkpoint({})
    await w.write_error({})

    types = [s.step_type for s in captured]
    assert types == [
        "plan", "tool_call", "tool_result", "evaluation",
        "render", "conflict", "checkpoint", "error",
    ]


# ---------------------------------------------------------------------------
# D + F. INSERT SQL + JSON serialization
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_append_inserts_with_correct_param_shape():
    captured = {}
    mock_conn = AsyncMock()

    async def fetchrow(sql, *args):
        captured["sql"] = sql
        captured["args"] = args
        return {"id": args[0]}     # echo back the step_id

    mock_conn.fetchrow = fetchrow

    @asynccontextmanager
    async def _acquire():
        yield mock_conn

    pool = MagicMock()
    pool.acquire = lambda: _acquire()

    w = ScratchpadWriter(
        pool=pool, conversation_id=uuid4(), user_email="u@x.org",
    )
    step = ScratchpadStep(
        conversation_id=w.conversation_id, step_number=1,
        step_type="tool_call", user_email="u@x.org",
        tool_name="search_crm", tool_args={"q": "acme"},
    )
    result_id = await w.append(step)
    assert result_id == step.step_id

    # SQL shape
    assert "INSERT INTO bedrock.pebble_chat_scratchpad" in captured["sql"]
    assert "RETURNING id" in captured["sql"]

    # Parameter order — verify positions match the column order.
    args = captured["args"]
    assert args[0] == step.step_id            # $1 = id
    assert args[1] == w.conversation_id       # $2 = conversation_id
    assert args[3] == 1                        # $4 = step_number
    assert args[4] == "tool_call"             # $5 = step_type
    assert args[5] == "search_crm"            # $6 = tool_name
    # JSONB args pre-serialized to JSON strings.
    assert args[6] == json.dumps({"q": "acme"})


# ---------------------------------------------------------------------------
# E. Failure-soft
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_append_logs_but_does_not_raise_on_db_error(caplog):
    failing_conn = AsyncMock()

    async def boom(*a, **kw):
        raise RuntimeError("DB down mid-conversation")

    failing_conn.fetchrow = boom

    @asynccontextmanager
    async def _acquire():
        yield failing_conn

    pool = MagicMock()
    pool.acquire = lambda: _acquire()

    w = ScratchpadWriter(pool=pool, conversation_id=uuid4(), user_email="u@x.org")
    step = ScratchpadStep(
        conversation_id=w.conversation_id, step_number=1,
        step_type="plan", user_email="u@x.org",
    )

    import logging
    caplog.set_level(logging.ERROR)
    result = await w.append(step)
    assert result is None
    # Logged but no raise.
    assert any("scratchpad_insert_failed" in rec.message for rec in caplog.records)


# ---------------------------------------------------------------------------
# G. Pool-less degraded mode
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pool_none_degraded_mode():
    """Tests / dev environments without a DB still get a step_id back
    so caller logic can proceed. The state just isn't durable."""
    w = ScratchpadWriter(pool=None, conversation_id=uuid4(), user_email="u@x.org")
    step = ScratchpadStep(
        conversation_id=w.conversation_id, step_number=1,
        step_type="plan", user_email="u@x.org",
    )
    result = await w.append(step)
    assert result == step.step_id


# ---------------------------------------------------------------------------
# _to_json helper
# ---------------------------------------------------------------------------

def test_to_json_none():
    assert _to_json(None) is None


def test_to_json_dict():
    assert _to_json({"a": 1}) == '{"a": 1}'


def test_to_json_handles_uuid():
    """asyncpg's JSONB encoder doesn't know UUIDs natively; default=str
    in json.dumps handles them so we don't crash on uuid-bearing dicts."""
    eid = uuid4()
    s = _to_json({"id": eid})
    assert str(eid) in s
