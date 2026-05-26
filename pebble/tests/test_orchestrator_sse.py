"""Tests for ``pebble.orchestrator.sse`` — the SSE frame encoder."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from uuid import UUID, uuid4

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.chat_orchestrator import OrchestratorEvent
from pebble.orchestrator.sse import encode_error, encode_event, encode_keepalive


def test_encode_event_basic_shape():
    ev = OrchestratorEvent(kind="plan_emitted", payload={"plan_id": "abc"})
    out = encode_event(ev)
    # Frame is bytes with `data: <json>\n\n` shape
    assert out.startswith(b"data: ")
    assert out.endswith(b"\n\n")
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    assert body == {"kind": "plan_emitted", "payload": {"plan_id": "abc"}}


def test_encode_event_handles_missing_payload():
    ev = OrchestratorEvent(kind="done")
    out = encode_event(ev)
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    assert body == {"kind": "done", "payload": {}}


def test_encode_event_uuid_serializes_to_string():
    eid = uuid4()
    ev = OrchestratorEvent(
        kind="tool_call_started",
        payload={"step_id": eid, "tool": "search_crm"},
    )
    out = encode_event(ev)
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    assert body["payload"]["step_id"] == str(eid)


def test_encode_event_datetime_serializes_to_string():
    when = datetime.now(tz=timezone.utc)
    ev = OrchestratorEvent(kind="x", payload={"at": when})
    out = encode_event(ev)
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    # default=str produces "YYYY-MM-DD HH:MM:SS.us+00:00" — has the year + tz marker
    assert isinstance(body["payload"]["at"], str)
    assert str(when.year) in body["payload"]["at"]
    assert "+00:00" in body["payload"]["at"] or "UTC" in body["payload"]["at"]


def test_encode_event_unicode_in_text():
    ev = OrchestratorEvent(
        kind="draft_emitted",
        payload={"draft": {"text": "café — naïve résumé"}},
    )
    out = encode_event(ev)
    # Confirm round-trip via UTF-8 decode
    body = json.loads(out.decode("utf-8")[len("data: "):-2])
    assert body["payload"]["draft"]["text"] == "café — naïve résumé"


def test_encode_event_compact_no_extra_whitespace():
    """Compact JSON saves bytes on the wire — ~10% reduction at scale."""
    ev = OrchestratorEvent(kind="x", payload={"a": 1, "b": 2})
    out = encode_event(ev)
    # Compact separators: no space after `,` or `:`
    serialized = out.decode("utf-8")[len("data: "):-2]
    assert ", " not in serialized
    assert ": " not in serialized


def test_encode_error_phase_and_reason():
    out = encode_error("rate_limited", phase="planner")
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    assert body == {
        "kind": "error",
        "payload": {"phase": "planner", "reason": "rate_limited"},
    }


def test_encode_error_extra_fields_stringified():
    out = encode_error("upstream_500", phase="proxy", status_code=500)
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    assert body["payload"]["status_code"] == "500"


def test_encode_error_default_phase():
    out = encode_error("something")
    body = json.loads(out[len(b"data: "):-len(b"\n\n")])
    assert body["payload"]["phase"] == "transport"


def test_encode_keepalive_is_comment_frame():
    """Keepalive uses SSE comment syntax (`:`-prefix) so clients
    ignore it but proxies don't time out the connection."""
    out = encode_keepalive()
    assert out.startswith(b":")
    assert out.endswith(b"\n\n")


def test_frames_are_independently_parseable():
    """Multiple frames can be concatenated and split on \\n\\n
    boundary — this is what the FE's SSE parser does."""
    e1 = encode_event(OrchestratorEvent(kind="a", payload={"i": 1}))
    e2 = encode_event(OrchestratorEvent(kind="b", payload={"i": 2}))
    e3 = encode_keepalive()
    e4 = encode_event(OrchestratorEvent(kind="c", payload={"i": 3}))
    combined = e1 + e2 + e3 + e4
    frames = combined.decode("utf-8").split("\n\n")
    # Last empty string from trailing \n\n is normal
    assert frames[-1] == ""
    # Each non-empty frame is either data: ... or :keepalive
    payloads = []
    for f in frames[:-1]:
        if f.startswith("data: "):
            payloads.append(json.loads(f[len("data: "):]))
        elif f.startswith(":"):
            payloads.append({"keepalive": True})
    assert payloads == [
        {"kind": "a", "payload": {"i": 1}},
        {"kind": "b", "payload": {"i": 2}},
        {"keepalive": True},
        {"kind": "c", "payload": {"i": 3}},
    ]
