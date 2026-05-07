"""Tests for ``pebble.orchestrator.builtin_tools`` — the concrete
search_crm / get_record / request_human_review tools.

Every tool covered for happy path + 4xx + 5xx + timeout + bad-input.
"""

import os
import sys
from uuid import uuid4

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from pebble.orchestrator.builtin_tools import (
    GET_RECORD_SPEC,
    REQUEST_HUMAN_REVIEW_SPEC,
    SEARCH_CRM_SPEC,
    register_builtin_tools,
)
from pebble.orchestrator.tools import (
    ToolContext, ToolRegistry,
)


def _ctx_with_client(client) -> ToolContext:
    return ToolContext(
        user_email="rm@pursuit.org",
        conversation_id=str(uuid4()),
        http_client=client,
    )


class _MockResponse:
    def __init__(self, status_code, json_body=None):
        self.status_code = status_code
        self._body = json_body or {}
    def json(self):
        return self._body


class _MockClient:
    def __init__(self, response=None, raise_exc=None, capture=None):
        self._response = response
        self._raise = raise_exc
        self.capture = capture if capture is not None else {}
    async def get(self, url, **kwargs):
        self.capture["url"] = url
        self.capture["params"] = kwargs.get("params")
        if self._raise:
            raise self._raise
        return self._response


# ---------------------------------------------------------------------------
# search_crm
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_crm_happy_path():
    body = {
        "items": [
            {"entity_type": "sf_account", "entity_id": "001ABC",
             "title": "Acme Corp", "subtitle": "Customer", "href": "/accounts/001ABC",
             "rank": 0.95, "indexed_at": "2026-05-07", "group": "Accounts",
             "activity_at": None},
        ],
        "grouped": {"Accounts": [{"entity_type": "sf_account", "entity_id": "001ABC"}]},
        "total_count": 1,
        "backend_used": "postgres_fts",
        "took_ms": 12,
    }
    client = _MockClient(response=_MockResponse(200, body))
    result = await SEARCH_CRM_SPEC.handler({"query": "acme"}, _ctx_with_client(client))
    assert result.ok is True
    assert result.data["total_count"] == 1
    assert result.citations == ("sf_account:001ABC",)
    assert client.capture["url"] == "/api/search"
    assert client.capture["params"]["q"] == "acme"


@pytest.mark.asyncio
async def test_search_crm_passes_types_filter():
    capture: dict = {}
    client = _MockClient(
        response=_MockResponse(200, {"items": [], "grouped": {}, "total_count": 0}),
        capture=capture,
    )
    await SEARCH_CRM_SPEC.handler(
        {"query": "x", "types": ["sf_account", "pebble_profile"]},
        _ctx_with_client(client),
    )
    assert capture["params"]["types"] == "sf_account,pebble_profile"


@pytest.mark.asyncio
async def test_search_crm_empty_query_fails_fast():
    """Empty/whitespace query short-circuits before HTTP — saves a call."""
    client = _MockClient(response=_MockResponse(200, {}))
    result = await SEARCH_CRM_SPEC.handler({"query": "   "}, _ctx_with_client(client))
    assert result.ok is False
    assert "non-empty" in result.error
    assert "url" not in client.capture   # never called


@pytest.mark.asyncio
async def test_search_crm_http_404_returns_failure():
    client = _MockClient(response=_MockResponse(404))
    result = await SEARCH_CRM_SPEC.handler({"query": "acme"}, _ctx_with_client(client))
    assert result.ok is False
    assert "HTTP 404" in result.error


@pytest.mark.asyncio
async def test_search_crm_timeout_returns_failure():
    client = _MockClient(raise_exc=httpx.TimeoutException("upstream slow"))
    result = await SEARCH_CRM_SPEC.handler({"query": "acme"}, _ctx_with_client(client))
    assert result.ok is False
    assert "timeout" in result.error.lower()


@pytest.mark.asyncio
async def test_search_crm_other_http_error():
    client = _MockClient(raise_exc=httpx.ConnectError("no route"))
    result = await SEARCH_CRM_SPEC.handler({"query": "acme"}, _ctx_with_client(client))
    assert result.ok is False
    assert "ConnectError" in result.error


@pytest.mark.asyncio
async def test_search_crm_no_http_client_in_context():
    """Misconfigured ToolContext (no http_client) returns ok=False
    rather than crashing the executor."""
    ctx = ToolContext(
        user_email="x@y.org", conversation_id=str(uuid4()), http_client=None,
    )
    result = await SEARCH_CRM_SPEC.handler({"query": "x"}, ctx)
    assert result.ok is False
    assert "http_client" in result.error


@pytest.mark.asyncio
async def test_search_crm_clamps_limit():
    capture: dict = {}
    client = _MockClient(
        response=_MockResponse(200, {"items": [], "grouped": {}, "total_count": 0}),
        capture=capture,
    )
    await SEARCH_CRM_SPEC.handler({"query": "x", "limit": 9999}, _ctx_with_client(client))
    assert capture["params"]["limit"] == 100   # clamped to MAX


# ---------------------------------------------------------------------------
# get_record
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_record_happy_path():
    capture: dict = {}
    body = {"id": "001ABC", "Name": "Acme Corp"}
    client = _MockClient(response=_MockResponse(200, body), capture=capture)
    result = await GET_RECORD_SPEC.handler(
        {"entity_type": "sf_account", "entity_id": "001ABC"},
        _ctx_with_client(client),
    )
    assert result.ok is True
    assert result.data["entity_type"] == "sf_account"
    assert result.data["record"]["Name"] == "Acme Corp"
    assert result.citations == ("sf_account:001ABC",)
    assert capture["url"] == "/api/salesforce/accounts/001ABC"


@pytest.mark.asyncio
async def test_get_record_unsupported_entity_type():
    """Strict allowlist — planner can't smuggle an arbitrary URL by
    inventing an entity_type."""
    client = _MockClient(response=_MockResponse(200, {}))
    result = await GET_RECORD_SPEC.handler(
        {"entity_type": "evil", "entity_id": "../etc/passwd"},
        _ctx_with_client(client),
    )
    assert result.ok is False
    assert "unsupported entity_type" in result.error


@pytest.mark.asyncio
async def test_get_record_404_returns_not_found():
    client = _MockClient(response=_MockResponse(404))
    result = await GET_RECORD_SPEC.handler(
        {"entity_type": "sf_account", "entity_id": "001MISSING"},
        _ctx_with_client(client),
    )
    assert result.ok is False
    assert "not found" in result.error


@pytest.mark.asyncio
async def test_get_record_empty_id_fails():
    client = _MockClient(response=_MockResponse(200, {}))
    result = await GET_RECORD_SPEC.handler(
        {"entity_type": "sf_account", "entity_id": ""},
        _ctx_with_client(client),
    )
    assert result.ok is False
    assert "non-empty" in result.error


# ---------------------------------------------------------------------------
# request_human_review
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_request_human_review_emits_checkpoint_flag():
    """The executor detects checkpoint=True in the result data and
    halts. This locks in the contract."""
    result = await REQUEST_HUMAN_REVIEW_SPEC.handler(
        {"reason": "Multiple Acme matches; please pick one.",
         "options": ["Acme Corp", "Acme Foundation", "Acme Inc."]},
        ToolContext(user_email="u@x.org", conversation_id=str(uuid4())),
    )
    assert result.ok is True
    assert result.data["checkpoint"] is True
    assert "Multiple Acme" in result.data["reason"]
    assert len(result.data["options"]) == 3


@pytest.mark.asyncio
async def test_request_human_review_default_reason():
    result = await REQUEST_HUMAN_REVIEW_SPEC.handler(
        {"reason": ""}, ToolContext(user_email="u@x.org", conversation_id=str(uuid4())),
    )
    assert result.ok is True
    assert result.data["reason"] == "Pebble requested confirmation."


@pytest.mark.asyncio
async def test_request_human_review_rejects_non_list_options():
    result = await REQUEST_HUMAN_REVIEW_SPEC.handler(
        {"reason": "x", "options": "not-a-list"},
        ToolContext(user_email="u@x.org", conversation_id=str(uuid4())),
    )
    assert result.ok is False
    assert "list" in result.error


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def test_register_on_isolated_registry():
    """Test against a fresh registry to avoid touching DEFAULT_REGISTRY."""
    reg = ToolRegistry()
    register_builtin_tools(reg)
    assert "search_crm" in reg
    assert "get_record" in reg
    assert "request_human_review" in reg
    # Idempotent: second call doesn't double-register or raise.
    register_builtin_tools(reg)
    assert len(reg) == 3


def test_default_registry_has_builtins_at_import_time():
    """Auto-registration on import lets the planner see tools without
    explicit setup."""
    from pebble.orchestrator.tools import DEFAULT_REGISTRY
    assert "search_crm" in DEFAULT_REGISTRY
    assert "get_record" in DEFAULT_REGISTRY
    assert "request_human_review" in DEFAULT_REGISTRY


def test_get_record_input_schema_uses_strict_enum():
    """The enum on entity_type defends against the planner inventing
    types — JSON-schema strict mode rejects unknown values before the
    handler even runs."""
    schema = GET_RECORD_SPEC.input_schema
    enum = schema["properties"]["entity_type"]["enum"]
    # Must include the entity types we actually route, no more.
    assert "sf_account" in enum
    assert "sf_opportunity" in enum
    assert "pebble_profile" in enum
    assert "evil" not in enum
