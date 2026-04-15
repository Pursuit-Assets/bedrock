"""Progress-page visibility override.

Admins use this to control which Salesforce users appear on the Progress
page Individual Progress table. Typical use: hide service accounts
(Slackbot, Automated Process, Integration User) and ex-employees still
marked IsActive=true in Salesforce.

The override is Bedrock-owned (lives in bedrock.progress_tracked_override
keyed by sf_user_id) so it works for SF service accounts that never log
into Bedrock — no dependency on public.org_users. Absence of a row for a
given sf_user_id is equivalent to is_tracked=true (default visible).

Endpoints:

    GET  /api/progress-tracking/users
        Auth: any authenticated user (Progress page is not admin-only).
        Returns [{ sf_user_id, name, email, is_active, is_tracked }] for
        every SF user with IsActive=true, enriched with the override flag.

    PUT  /api/progress-tracking/overrides/{sf_user_id}
        Auth: admin only (manage_users_roles).
        Body: { "is_tracked": bool }. Upserts the override row, logs the
        change with actor email, and invalidates the users cache.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_auth
from db import get_db
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient
from security import validate_salesforce_id
from routes.permissions import require_admin
from services.cache import cache, CACHE_TTL_USERS

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/progress-tracking", tags=["progress-tracking"])

# Single cache key — the list is small (~dozens of rows), identical for
# every caller, and invalidated whenever an override changes.
_CACHE_KEY_USERS = "progress-tracking:users"


class OverrideUpdate(BaseModel):
    is_tracked: bool


@router.get("/users")
async def get_progress_tracked_users(
    client: UnifiedMCPClient = Depends(get_mcp_client),
    db=Depends(get_db),
    user=Depends(require_auth),
):
    """List active Salesforce users enriched with the Bedrock override flag.

    Used by both the Settings panel (admin toggles) and the Progress page
    (client-side filter to hide users where is_tracked=false). Does NOT
    require admin — non-admin users call this to render the filtered
    Progress page.

    Returns an empty list if Salesforce isn't connected, so the Progress
    page degrades gracefully instead of 500ing.
    """
    cached = cache.get(_CACHE_KEY_USERS)
    if cached is not None:
        return cached

    if "salesforce" not in (client.connected_services or []):
        return []

    try:
        result = await client.salesforce.query(
            "SELECT Id, Name, Email, IsActive "
            "FROM User "
            "WHERE IsActive = true "
            "ORDER BY Name ASC"
        )
    except Exception as e:
        logger.error(f"Failed to fetch SF users for progress-tracking: {e}")
        raise HTTPException(status_code=500, detail="Failed to load user list")

    sf_users = result.get("records", [])

    rows = await db.fetch(
        "SELECT sf_user_id, is_tracked FROM bedrock.progress_tracked_override"
    )
    override_map = {r["sf_user_id"]: r["is_tracked"] for r in rows}

    enriched = [
        {
            "sf_user_id": u.get("Id"),
            "name": u.get("Name"),
            "email": u.get("Email"),
            "is_active": u.get("IsActive", True),
            # Absence of a row = tracked (default visible).
            "is_tracked": override_map.get(u.get("Id"), True),
        }
        for u in sf_users
    ]

    cache.set(_CACHE_KEY_USERS, enriched, CACHE_TTL_USERS)
    return enriched


@router.put("/overrides/{sf_user_id}")
async def set_progress_tracked_override(
    sf_user_id: str,
    body: OverrideUpdate,
    user=Depends(require_admin),
    db=Depends(get_db),
):
    """Toggle whether a single SF user appears on the Progress page.

    Upsert semantics — writes a row for first-time toggles, updates
    existing rows on subsequent changes. We never DELETE so the
    `updated_by_email` + `updated_at` audit trail persists even when a
    user is toggled back to the default (tracked).
    """
    validate_salesforce_id(sf_user_id, "sf_user_id")
    actor_email = user.get("email") or "unknown"

    await db.execute(
        "INSERT INTO bedrock.progress_tracked_override "
        "    (sf_user_id, is_tracked, updated_by_email) "
        "VALUES ($1, $2, $3) "
        "ON CONFLICT (sf_user_id) DO UPDATE "
        "    SET is_tracked = EXCLUDED.is_tracked, "
        "        updated_by_email = EXCLUDED.updated_by_email, "
        "        updated_at = now()",
        sf_user_id, body.is_tracked, actor_email,
    )

    logger.info(
        "Progress-tracking override: %s set %s.is_tracked=%s",
        actor_email, sf_user_id, body.is_tracked,
    )

    # Drop the cached user list so the next GET picks up the new state.
    cache.invalidate(_CACHE_KEY_USERS)

    return {
        "sf_user_id": sf_user_id,
        "is_tracked": body.is_tracked,
        "updated_by_email": actor_email,
    }
