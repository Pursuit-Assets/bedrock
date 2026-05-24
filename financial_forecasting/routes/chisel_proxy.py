"""Chisel proxy — Bedrock-side passthrough to ``/api/chisel/*`` on Pebble.

The frontend hits Bedrock at ``/api/chisel/*``; this module forwards
each call to the Pebble service (port 8001 in dev) with the user's
identity propagated through ``X-User-Email``. Single auth boundary,
single CORS surface — mirrors ``routes/pebble_proxy.py``.

Surface (read-only for Phase C.1):
  * GET    /api/chisel/health
  * GET    /api/chisel/tools
  * GET    /api/chisel/tools/{name}
  * GET    /api/chisel/workflows
  * GET    /api/chisel/workflows/{name}
  * POST   /api/chisel/validate
  * POST   /api/chisel/reload
  * POST   /api/chisel/eval

Permission gate: ``check_permission_or_internal("use_pebble_chat")``.
Phase C.2 will add a dedicated ``chisel_write`` permission for
manifest-save endpoints once Sprint-12 ships.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from routes.permissions import check_permission_or_internal

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/chisel", tags=["chisel"])

_require_chisel_perm = check_permission_or_internal("use_pebble_chat")

_PEBBLE_URL = os.getenv("PEBBLE_API_URL", "http://localhost:8001")
_PEBBLE_API_KEY = os.getenv("PEBBLE_API_KEY", "")
_HTTP_TIMEOUT = httpx.Timeout(30.0, connect=3.0, read=30.0)

_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        headers: dict[str, str] = {}
        if _PEBBLE_API_KEY:
            headers["X-Api-Key"] = _PEBBLE_API_KEY
        _client = httpx.AsyncClient(
            base_url=_PEBBLE_URL,
            headers=headers,
            timeout=_HTTP_TIMEOUT,
        )
    return _client


async def close() -> None:
    """Close the proxy's httpx client. Call from app lifespan shutdown."""
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


def _user_headers(request: Request) -> dict[str, str]:
    """Forward identity headers to Pebble. The user_email is set on
    request.state by the permission dep."""
    email = getattr(request.state, "user_email", None) or request.headers.get("X-User-Email", "")
    headers: dict[str, str] = {}
    if email:
        headers["X-User-Email"] = email
    trace = request.headers.get("X-Trace-Id")
    if trace:
        headers["X-Trace-Id"] = trace
    return headers


async def _proxy(
    request: Request,
    method: str,
    pebble_path: str,
    *,
    json_body: Optional[dict] = None,
) -> JSONResponse:
    client = _get_client()
    try:
        resp = await client.request(
            method,
            pebble_path,
            headers=_user_headers(request),
            json=json_body,
        )
    except httpx.HTTPError as e:
        logger.warning("chisel_proxy: %s %s failed: %s", method, pebble_path, e)
        raise HTTPException(status_code=502, detail=f"pebble unreachable: {type(e).__name__}") from e
    try:
        body = resp.json()
    except ValueError:
        body = {"detail": resp.text}
    return JSONResponse(status_code=resp.status_code, content=body)


# ---------------------------------------------------------------------------
# GET endpoints
# ---------------------------------------------------------------------------

@router.get("/health", dependencies=[Depends(_require_chisel_perm)])
async def get_health(request: Request) -> JSONResponse:
    return await _proxy(request, "GET", "/api/chisel/health")


@router.get("/tools", dependencies=[Depends(_require_chisel_perm)])
async def list_tools(request: Request) -> JSONResponse:
    return await _proxy(request, "GET", "/api/chisel/tools")


@router.get("/tools/{name}", dependencies=[Depends(_require_chisel_perm)])
async def get_tool(name: str, request: Request) -> JSONResponse:
    return await _proxy(request, "GET", f"/api/chisel/tools/{name}")


@router.get("/workflows", dependencies=[Depends(_require_chisel_perm)])
async def list_workflows(request: Request) -> JSONResponse:
    return await _proxy(request, "GET", "/api/chisel/workflows")


@router.get("/workflows/{name}", dependencies=[Depends(_require_chisel_perm)])
async def get_workflow(name: str, request: Request) -> JSONResponse:
    return await _proxy(request, "GET", f"/api/chisel/workflows/{name}")


# ---------------------------------------------------------------------------
# POST endpoints
# ---------------------------------------------------------------------------

@router.post("/validate", dependencies=[Depends(_require_chisel_perm)])
async def validate(request: Request) -> JSONResponse:
    body = await request.json()
    return await _proxy(request, "POST", "/api/chisel/validate", json_body=body)


@router.post("/reload", dependencies=[Depends(_require_chisel_perm)])
async def reload(request: Request) -> JSONResponse:
    return await _proxy(request, "POST", "/api/chisel/reload")


@router.post("/eval", dependencies=[Depends(_require_chisel_perm)])
async def eval_run(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    return await _proxy(request, "POST", "/api/chisel/eval", json_body=body)
