"""Search API — Layer 1.8 of the Pebble 1.0 plan.

Endpoints:
    GET  /api/search                    — cross-entity find against bedrock.search_doc
    POST /api/search/click              — click attribution for ranking quality

The route layer is deliberately thin: it parses + validates input,
calls ``services/search_service.py`` for the heavy lifting, emits an
audit row to ``bedrock.search_audit`` via FastAPI BackgroundTask, and
serializes the response.

Permission semantics:
    * Auth via ``check_permission_or_internal("view_opportunities")`` —
      the lightest read perm that's gated for the search-eligible
      profiles. The actual record-level filter happens INSIDE the
      service, against the resolved SearchPrincipal.
    * Service callers (Pebble, ``is_service=True``) carry an
      ``X-Originating-User`` and the filter resolves against THAT
      user's permissions, not the service account's.

Observability:
    * Every search attempt writes one row to bedrock.search_audit.
    * Audit row write is a BackgroundTask — never blocks the response.
    * Click endpoint UPDATEs the same row on click, fenced on the
      caller matching the original user_email.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from db import get_db
from routes.permissions import check_permission_or_internal
from services import search_service as ss

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/search", tags=["search"])

# Module-level stable reference so tests can override via
# ``app.dependency_overrides[require_search_perm]``. Without this, the
# ``check_permission_or_internal("view_opportunities")`` closure is
# unique per call and the override key never matches.
require_search_perm = check_permission_or_internal("view_opportunities")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class SearchHitOut(BaseModel):
    entity_type: str
    entity_id: str
    title: str
    subtitle: Optional[str] = None
    href: str
    rank: float
    activity_at: Optional[str] = None
    indexed_at: str
    group: str


class SearchResponseOut(BaseModel):
    query_id: str
    items: list[SearchHitOut]
    grouped: dict[str, list[SearchHitOut]]
    total_count: int
    backend_used: str
    took_ms: int


class SearchClickIn(BaseModel):
    query_id: str = Field(..., description="UUID returned from the original /api/search response")
    position: int = Field(..., ge=0, description="0-based rank position of clicked hit")
    entity_type: str
    entity_id: str


class SearchClickOut(BaseModel):
    ok: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_types(types: Optional[str]) -> Optional[list[str]]:
    """Comma-separated query-string list → list. None / empty → None
    (= all types per ``SearchRequest`` default).
    """
    if not types:
        return None
    parts = [t.strip() for t in types.split(",") if t.strip()]
    return parts or None


def _request_uuid(request: Request) -> str:
    """X-Request-Id is mandatory on internal-key calls (set by
    require_auth_or_internal). Direct human callers may not send it;
    we mint one in that case so audit rows always have a UUID.
    """
    raw = request.headers.get("X-Request-Id", "").strip()
    if raw:
        try:
            uuid.UUID(raw)
            return raw
        except ValueError:
            # Malformed header: log and replace; never let a bad client
            # poison the audit log.
            logger.warning("Malformed X-Request-Id %r; minting fresh", raw)
    return str(uuid.uuid4())


def _truncate_query(query: str, max_len: int = 256) -> str:
    """Per security spec §2: query_text length-capped at 256 chars
    server-side. Anything longer is rejected at the request layer to
    avoid DoS via long queries; this is a defensive truncate for the
    audit row in case validation is ever loosened."""
    return query[:max_len] if query else ""


async def _emit_search_audit(
    pool,
    *,
    query_id: uuid.UUID,
    request_id: str,
    user_email: str,
    originating_user_email: Optional[str],
    org_id: str,
    mode: str,
    query: str,
    types_requested: list[str],
    backend_used: str,
    perm_resolution_ms: int,
    backend_latency_ms: int,
    latency_ms: int,
    result_count: int,
    response_status: int,
    error_class: Optional[str] = None,
) -> None:
    """Insert the audit row. Called from a BackgroundTask so it never
    blocks the response. Uses ON CONFLICT DO NOTHING on the
    UNIQUE(request_id) so retried requests don't duplicate.
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO bedrock.search_audit (
                    query_id, request_id, user_email,
                    originating_user_email, org_id, mode,
                    query_text, query_text_hash, types_requested,
                    backend_used, perm_resolution_ms, backend_latency_ms,
                    latency_ms, result_count, response_status, error_class
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    $10, $11, $12, $13, $14, $15, $16
                )
                ON CONFLICT (request_id) DO NOTHING
                """,
                query_id, uuid.UUID(request_id), user_email,
                originating_user_email, org_id, mode,
                _truncate_query(query), ss.query_text_hash(query),
                types_requested,
                backend_used, perm_resolution_ms, backend_latency_ms,
                latency_ms, result_count, response_status, error_class,
            )
    except Exception:
        # Audit-row failures must NEVER affect the user response.
        # Log loudly — alerting will catch sustained failure.
        logger.exception(
            "search_audit_insert_failed query_id=%s request_id=%s",
            query_id, request_id,
        )


# ---------------------------------------------------------------------------
# GET /api/search
# ---------------------------------------------------------------------------

@router.get("", response_model=SearchResponseOut)
async def search_endpoint(
    request: Request,
    background_tasks: BackgroundTasks,
    q: str = Query(..., min_length=1, max_length=256, description="Search query text"),
    types: Optional[str] = Query(None, description="Comma-separated entity_type filter"),
    limit: int = Query(ss.DEFAULT_LIMIT, ge=1, le=ss.MAX_LIMIT),
    pool=Depends(get_db),
    user=Depends(require_search_perm),
):
    """Cross-entity search. Returns ranked hits plus a UI grouping.

    The grouping is computed server-side so the frontend doesn't have
    to know the entity_type → group label map.
    """
    started = time.perf_counter()
    request_id = _request_uuid(request)

    # Resolve principal — service callers fall through to their
    # originating user, humans are themselves.
    perm_started = time.perf_counter()
    async with pool.acquire() as conn:
        try:
            principal = await ss.resolve_principal(conn, user)
        except ValueError as e:
            logger.warning("Principal resolution failed: %s", e)
            raise HTTPException(status_code=400, detail=str(e))
    perm_ms = int((time.perf_counter() - perm_started) * 1000)

    # Normalize the request.
    try:
        type_list = _normalize_types(types)
        req = ss.SearchRequest(
            query=q.strip(),
            types=type_list,
            limit=limit,
            org_id=principal.org_id,
        )
        # Trigger the type-validation (raises ValueError on bad input).
        req.normalized_types()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Run the search.
    backend_started = time.perf_counter()
    error_class: Optional[str] = None
    response_status = 200
    try:
        async with pool.acquire() as conn:
            result = await ss.search(conn, principal, req)
    except Exception as e:
        error_class = type(e).__name__
        response_status = 500
        logger.exception("search_failed query=%s", q)
        raise HTTPException(status_code=500, detail="search_failed")
    finally:
        backend_ms = int((time.perf_counter() - backend_started) * 1000)
        total_ms = int((time.perf_counter() - started) * 1000)

        # Background audit emission — never blocks the response.
        background_tasks.add_task(
            _emit_search_audit,
            pool,
            query_id=result.query_id if response_status == 200 else uuid.uuid4(),
            request_id=request_id,
            user_email=user.get("email", "unknown"),
            originating_user_email=user.get("originating_user_email"),
            org_id=principal.org_id,
            mode="find",
            query=q,
            types_requested=list(req.normalized_types()),
            backend_used=getattr(result, "backend_used", "postgres_fts") if response_status == 200 else "degraded_empty",
            perm_resolution_ms=perm_ms,
            backend_latency_ms=backend_ms,
            latency_ms=total_ms,
            result_count=len(result.items) if response_status == 200 else 0,
            response_status=response_status,
            error_class=error_class,
        )

    # Pack the response with both flat + grouped views so the frontend
    # can pick the shape it wants.
    items_out = [
        SearchHitOut(
            entity_type=h.entity_type,
            entity_id=h.entity_id,
            title=h.title,
            subtitle=h.subtitle,
            href=h.href,
            rank=h.rank,
            activity_at=h.activity_at,
            indexed_at=h.indexed_at,
            group=h.group,
        )
        for h in result.items
    ]
    grouped: dict[str, list[SearchHitOut]] = {}
    for hit in items_out:
        grouped.setdefault(hit.group, []).append(hit)

    return SearchResponseOut(
        query_id=str(result.query_id),
        items=items_out,
        grouped=grouped,
        total_count=len(items_out),
        backend_used=result.backend_used,
        took_ms=result.took_ms,
    )


# ---------------------------------------------------------------------------
# POST /api/search/click
# ---------------------------------------------------------------------------

@router.post("/click", response_model=SearchClickOut)
async def search_click_endpoint(
    request: Request,
    body: SearchClickIn,
    pool=Depends(get_db),
    user=Depends(require_search_perm),
):
    """Attribute a click to a prior search query for ranking-quality
    analysis. Fenced on the caller matching the original audit row's
    user_email so a user can't poison someone else's search history.
    """
    try:
        query_uuid = uuid.UUID(body.query_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid query_id")

    user_email = user.get("email", "")

    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE bedrock.search_audit
               SET click_position = $1,
                   click_entity_type = $2,
                   click_record_id = $3,
                   click_at = now()
             WHERE query_id = $4
               AND user_email = $5
               AND click_position IS NULL
            """,
            body.position, body.entity_type, body.entity_id,
            query_uuid, user_email,
        )

    # asyncpg returns "UPDATE n" — n = 0 means no matching audit row,
    # which we don't surface to the caller (silent no-op).
    return SearchClickOut(ok=True)
