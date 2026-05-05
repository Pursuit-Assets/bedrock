"""Saved filter views — personal + global.

Backed by `bedrock.saved_view`. The `filters` payload is opaque JSONB —
the frontend serializes a per-page filter shape into it (chip rules,
search query, sort, scope, column visibility, column widths) and
re-applies on load.

Visibility rules:
  - A user sees their own saved views (owner_email matches their JWT email)
    AND every global view (is_global=true) for the requested scope.
  - Anyone can create a personal view (is_global=false).
  - Only admins can create / mutate / delete a global view.
  - A user can only mutate / delete their own personal views.

Endpoints:
  GET    /api/saved-views?scope_key=pipeline       — list visible
  POST   /api/saved-views                          — create
  PATCH  /api/saved-views/{id}                     — update name / filters / is_global
  DELETE /api/saved-views/{id}                     — delete
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from auth import require_auth
from db import get_db
from routes.permissions import get_user_permissions

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/saved-views", tags=["saved-views"])


class SavedViewCreate(BaseModel):
    scope_key: str = Field(..., min_length=1, max_length=64)
    name: str = Field(..., min_length=1, max_length=120)
    filters: dict[str, Any]
    is_global: bool = False


class SavedViewUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    filters: Optional[dict[str, Any]] = None
    is_global: Optional[bool] = None


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["id"] = str(out["id"])
    if out.get("created_at") is not None:
        out["created_at"] = out["created_at"].isoformat()
    if out.get("updated_at") is not None:
        out["updated_at"] = out["updated_at"].isoformat()
    # asyncpg returns JSONB columns as strings by default. Parse to a
    # dict before sending so the frontend doesn't have to JSON.parse
    # `view.filters` itself — and so `useSavedViews<F>()` callers can
    # treat the field as the typed shape, not `string`.
    f = out.get("filters")
    if isinstance(f, str):
        try:
            out["filters"] = json.loads(f)
        except json.JSONDecodeError:
            out["filters"] = {}
    return out


async def _is_admin(user: dict, conn) -> bool:
    """Helper — only `manage_users_roles` can mutate global views."""
    info = await get_user_permissions(user.get("email", ""), conn)
    perms = info.get("permissions") or {}
    return bool(perms.get("manage_users_roles"))


@router.get("")
async def list_saved_views(
    scope_key: str = Query(..., min_length=1, max_length=64),
    user=Depends(require_auth),
    conn=Depends(get_db),
) -> list[dict[str, Any]]:
    """Returns every personal view owned by the caller PLUS every
    global view for the requested scope. Sorted by `is_global ASC`
    (personal first), then `name ASC`."""
    email = user.get("email") or ""
    rows = await conn.fetch(
        """
        SELECT id, scope_key, name, owner_email, is_global,
               filters, created_at, updated_at
        FROM bedrock.saved_view
        WHERE scope_key = $1
          AND (is_global = true OR owner_email = $2)
        ORDER BY is_global ASC, name ASC
        """,
        scope_key,
        email,
    )
    return [_serialize(dict(r)) for r in rows]


@router.post("")
async def create_saved_view(
    body: SavedViewCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
) -> dict[str, Any]:
    email = user.get("email") or ""
    if body.is_global and not await _is_admin(user, conn):
        raise HTTPException(
            status_code=403,
            detail="Only admins can create global saved views.",
        )
    # Personal views are owned by the creator; global views have no owner
    # (so they survive the creator leaving the org).
    owner_email = None if body.is_global else email
    row = await conn.fetchrow(
        """
        INSERT INTO bedrock.saved_view
            (scope_key, name, owner_email, is_global, filters)
        VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING id, scope_key, name, owner_email, is_global,
                  filters, created_at, updated_at
        """,
        body.scope_key,
        body.name,
        owner_email,
        body.is_global,
        # asyncpg auto-encodes dicts to JSON via the ::jsonb cast.
        json.dumps(body.filters),
    )
    return _serialize(dict(row))


@router.patch("/{view_id}")
async def update_saved_view(
    view_id: str,
    body: SavedViewUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
) -> dict[str, Any]:
    email = user.get("email") or ""
    existing = await conn.fetchrow(
        "SELECT owner_email, is_global FROM bedrock.saved_view WHERE id = $1",
        view_id,
    )
    if existing is None:
        raise HTTPException(404, "Saved view not found")

    is_admin = await _is_admin(user, conn)
    # Authorization: a global view requires admin; a personal view
    # requires being the owner OR admin (admins can clean up).
    if existing["is_global"] and not is_admin:
        raise HTTPException(403, "Only admins can edit global saved views.")
    if not existing["is_global"] and existing["owner_email"] != email and not is_admin:
        raise HTTPException(403, "You can only edit your own saved views.")
    # Promoting a personal view to global is also admin-gated.
    if body.is_global is True and not existing["is_global"] and not is_admin:
        raise HTTPException(
            403,
            "Only admins can promote a personal view to a global view.",
        )

    # Build the SET clause dynamically so unset fields keep their value.
    sets: list[str] = []
    args: list[Any] = []
    if body.name is not None:
        args.append(body.name)
        sets.append(f"name = ${len(args)}")
    if body.filters is not None:
        args.append(json.dumps(body.filters))
        sets.append(f"filters = ${len(args)}::jsonb")
    if body.is_global is not None:
        args.append(body.is_global)
        sets.append(f"is_global = ${len(args)}")
        # If demoting a global view, set owner = caller; if promoting,
        # clear owner (no individual owner for shared views).
        if body.is_global is True:
            args.append(None)
        else:
            args.append(email)
        sets.append(f"owner_email = ${len(args)}")
    sets.append("updated_at = now()")

    if not sets:
        # Nothing to update — return the existing row unchanged.
        row = await conn.fetchrow(
            """
            SELECT id, scope_key, name, owner_email, is_global,
                   filters, created_at, updated_at
            FROM bedrock.saved_view WHERE id = $1
            """,
            view_id,
        )
        return _serialize(dict(row))

    args.append(view_id)
    row = await conn.fetchrow(
        f"""
        UPDATE bedrock.saved_view
        SET {", ".join(sets)}
        WHERE id = ${len(args)}
        RETURNING id, scope_key, name, owner_email, is_global,
                  filters, created_at, updated_at
        """,
        *args,
    )
    return _serialize(dict(row))


@router.delete("/{view_id}")
async def delete_saved_view(
    view_id: str,
    user=Depends(require_auth),
    conn=Depends(get_db),
) -> dict[str, Any]:
    email = user.get("email") or ""
    existing = await conn.fetchrow(
        "SELECT owner_email, is_global FROM bedrock.saved_view WHERE id = $1",
        view_id,
    )
    if existing is None:
        raise HTTPException(404, "Saved view not found")

    is_admin = await _is_admin(user, conn)
    if existing["is_global"] and not is_admin:
        raise HTTPException(403, "Only admins can delete global saved views.")
    if not existing["is_global"] and existing["owner_email"] != email and not is_admin:
        raise HTTPException(403, "You can only delete your own saved views.")

    await conn.execute("DELETE FROM bedrock.saved_view WHERE id = $1", view_id)
    return {"success": True, "data": {"id": view_id, "deleted": True}}
