"""SSE (Server-Sent Events) frame encoding for the Pebble chat
orchestrator.

The orchestrator yields ``OrchestratorEvent {kind, payload}`` records.
The wire format is canonical SSE: each event becomes one
``data: <json>\\n\\n`` frame. This module is the encoder.

Why a separate module: the encoder is tiny but used in two places
(the chat endpoint streams events to the FE, the proxy relays them).
Keeping the encoding contract in one file means the wire format is
auditable in one place — change once, both surfaces match.

Wire format
-----------

Each ``OrchestratorEvent`` becomes:

    data: {"kind": "<kind>", "payload": <payload-as-json>}\\n\\n

Notes:
  * ``payload`` is always a JSON object; ``kind`` is always a string.
  * No SSE ``event:`` field — the FE switches on ``kind`` inside the
    JSON body. Simpler client code; one parser path.
  * No ``id:`` field — we don't need ``Last-Event-ID`` reconnection
    semantics for v1.0. Conversations resume by re-running the query;
    SSE-replay correctness is a v1.1 concern.
  * Trailing ``\\n\\n`` is the SSE message terminator. Single
    newlines within ``data:`` would split the frame across messages.
  * Encoded as UTF-8 bytes — FastAPI's ``StreamingResponse`` expects
    bytes for ``media_type='text/event-stream'``.

Errors
------

Tools may return non-JSON-serializable values (datetime, UUID) inside
``payload``. We use ``default=str`` so those serialize to their
string representation rather than raising during the hot path. The
trade-off: the FE sees stringified UUIDs, which it expects (we
already stringify UUIDs in the orchestrator's payload construction).
"""

from __future__ import annotations

import json
from typing import Iterable

from .chat_orchestrator import OrchestratorEvent


def encode_event(event: OrchestratorEvent) -> bytes:
    """Encode one ``OrchestratorEvent`` as an SSE frame ready for the wire.

    Returns bytes suitable for yielding from a FastAPI
    ``StreamingResponse(media_type='text/event-stream')`` body.
    """
    body = {
        "kind": event.kind,
        "payload": event.payload or {},
    }
    serialized = json.dumps(body, default=str, separators=(",", ":"))
    return f"data: {serialized}\n\n".encode("utf-8")


def encode_error(reason: str, *, phase: str = "transport", **extra: str) -> bytes:
    """Convenience: emit an error frame from non-orchestrator code
    (proxy, route layer). Same shape as
    ``OrchestratorEvent(kind='error', payload={'phase': ..., 'reason': ...})``
    so the FE has one error-handling path.
    """
    payload: dict[str, str] = {"phase": phase, "reason": reason}
    payload.update({k: str(v) for k, v in extra.items()})
    body = {"kind": "error", "payload": payload}
    return f"data: {json.dumps(body, separators=(',', ':'))}\n\n".encode("utf-8")


def encode_keepalive() -> bytes:
    """SSE comment frame — keeps proxies / load balancers from
    closing the connection during long planner waits. Comment frames
    start with ``:`` and are ignored by clients.

    Useful inside long-running streams where the orchestrator's
    planner LLM call may take 5-15 seconds with no events emitted.
    Send a keepalive every ~10s during that wait.
    """
    return b": keepalive\n\n"
