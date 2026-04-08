"""Permission Profiles, User Roles & Opportunity Locking API."""

import json
import uuid
import logging
from typing import Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from auth import require_auth, require_auth_or_internal, decrypt_tokens
from db import get_db
from security import validate_salesforce_id, escape_soql_string

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/permissions", tags=["permissions"])

# All permission keys — used for validation
PERMISSION_KEYS = [
    "view_opportunities", "edit_own_opportunities", "edit_all_opportunities",
    "create_opportunities", "bulk_update_opportunities", "lock_own_opportunities",
    "reassign_opportunities",
    "view_tasks", "edit_own_tasks", "edit_all_tasks", "create_tasks",
    "edit_accounts", "create_accounts",
    "edit_contacts", "create_contacts",
    "edit_payments", "create_payments",
    "view_projects", "edit_projects",
    "view_revenue_dashboard", "view_cashflow_forecasts",
    "view_sage_invoices_payments", "create_sage_invoices",
    "match_invoices", "manage_payment_schedules", "generate_financial_reports",
    "use_pebble_chat", "use_pebble_research", "pebble_crm_write",
    "trigger_data_sync", "manage_users_roles", "edit_permission_profiles",
    "manage_owner_goals",
]


# ── Helpers ──


def _parse_perms(val) -> dict:
    """Safely parse permissions from JSONB — asyncpg may return str or dict."""
    if isinstance(val, dict):
        return val
    if isinstance(val, str):
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning(f"Failed to parse permissions JSONB: {e}")
            return {}
    return {}


async def _try_link_org_user(email: str, app_user_id, current_org_user_id, db) -> Optional[Dict[str, Any]]:
    """Lazily link a bedrock.app_user row to its public.org_users counterpart by email.

    Phase B-2 of Claim 3 (staff identity unification). Other Pursuit internal tools
    use public.org_users as the canonical staff identity table. We backfill the FK
    on every login where it's missing so the join is always fresh.

    Returns the platform org_users row dict if a link was found (or already existed),
    or None if no match. Tolerates the case where public.org_users does not exist
    (local-dev databases without the learning platform schema).
    """
    if current_org_user_id is not None:
        # Already linked. Fetch the current platform row for backfill (display_name, etc.)
        try:
            return dict(await db.fetchrow(
                "SELECT id, email, display_name, avatar_url, slack_user_id "
                "FROM public.org_users WHERE id = $1",
                current_org_user_id,
            ) or {}) or None
        except Exception as e:
            logger.debug(f"Could not refetch public.org_users for {email}: {e}")
            return None

    try:
        org_user = await db.fetchrow(
            "SELECT id, email, display_name, avatar_url, slack_user_id "
            "FROM public.org_users WHERE LOWER(email) = LOWER($1)",
            email,
        )
    except Exception as e:
        # public.org_users may not exist on local dev DB, or the role may not have
        # SELECT on public schema. Either way, we can't link — log and continue.
        logger.debug(f"Could not query public.org_users for {email}: {e}")
        return None

    if not org_user:
        return None

    try:
        await db.execute(
            "UPDATE bedrock.app_user SET org_user_id = $1, updated_at = now() "
            "WHERE id = $2",
            org_user["id"], app_user_id,
        )
        logger.info(
            f"Linked bedrock.app_user {app_user_id} → public.org_users {org_user['id']} for {email}"
        )
    except Exception as e:
        logger.warning(f"Failed to write back org_user_id link for {email}: {e}")

    return dict(org_user)


async def get_user_permissions(email: str, db) -> Dict[str, Any]:
    """Get resolved permissions for a user. Auto-provisions if needed.

    Note: this is on the hot path — called by every permission check on every
    request. It deliberately does NOT do the lazy public.org_users backfill;
    that happens once per session in the /me endpoint instead. The org_user_id
    column is read here so callers can check it, but the link backfill is
    deferred to avoid extra DB round-trips per request.
    """
    row = await db.fetchrow(
        "SELECT au.id, au.sf_user_id, au.email, au.name, au.is_active, "
        "au.org_user_id, "
        "pp.permissions, pp.name as profile_name "
        "FROM bedrock.app_user au "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = au.profile_id "
        "WHERE au.email = $1",
        email,
    )
    if row:
        result = dict(row)
        perms = _parse_perms(result.get("permissions"))
        # Admin profiles get all permissions by default — new keys are
        # automatically granted without requiring a DB update.
        if result.get("profile_name") == "Admin":
            for key in PERMISSION_KEYS:
                perms.setdefault(key, True)
        result["permissions"] = perms
        return result
    # Auto-provision: first user ever gets Admin, everyone else gets default profile
    user_count = await db.fetchval("SELECT COUNT(*) FROM bedrock.app_user")
    if user_count == 0:
        # Bootstrap: first user is Admin
        admin_profile = await db.fetchrow(
            "SELECT id, permissions, name FROM bedrock.permission_profile WHERE name = 'Admin'"
        )
        if admin_profile:
            logger.info(f"Bootstrap: first user {email} auto-assigned Admin profile")
            new_user = await db.fetchrow(
                "INSERT INTO bedrock.app_user (email, profile_id) VALUES ($1, $2) "
                "RETURNING id, sf_user_id, email, name, is_active",
                email, admin_profile["id"],
            )
            result = dict(new_user)
            result["permissions"] = _parse_perms(admin_profile["permissions"])
            result["profile_name"] = admin_profile["name"]
            return result
    default_profile = await db.fetchrow(
        "SELECT id, permissions, name FROM bedrock.permission_profile WHERE is_default = true"
    )
    profile_id = default_profile["id"] if default_profile else None
    new_user = await db.fetchrow(
        "INSERT INTO bedrock.app_user (email, profile_id) VALUES ($1, $2) "
        "RETURNING id, sf_user_id, email, name, is_active",
        email, profile_id,
    )
    result = dict(new_user)
    result["permissions"] = _parse_perms(default_profile["permissions"]) if default_profile else {}
    result["profile_name"] = default_profile["name"] if default_profile else None
    return result


async def require_admin(user=Depends(require_auth), db=Depends(get_db)):
    """Require the user to have manage_users_roles permission."""
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    if not perms.get("manage_users_roles", False):
        raise HTTPException(403, "Admin access required")
    return user


# System-level keys that only admins can toggle (escalation guard)
SYSTEM_KEYS = frozenset([
    "manage_users_roles", "edit_permission_profiles",
    "trigger_data_sync", "pebble_crm_write",
])


async def require_profile_editor(user=Depends(require_auth), db=Depends(get_db)):
    """Require edit_permission_profiles OR manage_users_roles."""
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    if not (perms.get("edit_permission_profiles") or perms.get("manage_users_roles")):
        raise HTTPException(403, "Permission denied: edit_permission_profiles")
    user["_permissions"] = perms
    user["_app_user"] = user_data
    return user


def check_permission(permission_key: str):
    """FastAPI dependency factory — checks a specific permission."""
    async def _check(user=Depends(require_auth), db=Depends(get_db)):
        email = user.get("email", "")
        user_data = await get_user_permissions(email, db)
        perms = user_data.get("permissions") or {}
        if not perms.get(permission_key, False):
            raise HTTPException(403, f"Permission denied: {permission_key}")
        # Attach resolved permissions and user data to the user dict
        user["_permissions"] = perms
        user["_app_user"] = user_data
        return user
    return _check


def check_permission_or_internal(permission_key: str):
    """Like check_permission but also accepts internal API key (service-to-service).

    Used for endpoints that Pebble calls via X-Internal-Key header.
    Service accounts bypass the per-user permission check.
    User-initiated requests (JWT) still go through full permission resolution.
    """
    async def _check(user=Depends(require_auth_or_internal), db=Depends(get_db)):
        # Service accounts (internal API key) bypass permission checks
        if user.get("is_service"):
            return user
        email = user.get("email", "")
        user_data = await get_user_permissions(email, db)
        perms = user_data.get("permissions") or {}
        if not perms.get(permission_key, False):
            raise HTTPException(403, f"Permission denied: {permission_key}")
        user["_permissions"] = perms
        user["_app_user"] = user_data
        return user
    return _check


async def resolve_task_lock(task_id: str, user: dict, db, salesforce) -> dict:
    """Fetch task from Salesforce, check if its opportunity is locked, return decision.

    Queries Salesforce for the task's WhatId and OwnerId, then checks the
    opportunity_lock table. Fails closed (503) if Salesforce is unreachable.
    """
    try:
        safe_id = escape_soql_string(task_id)
        result = await salesforce.query(
            f"SELECT WhatId, OwnerId FROM Task WHERE Id = '{safe_id}'"
        )
    except Exception as e:
        logger.error(f"Cannot verify task lock status — Salesforce query failed: {e}")
        raise HTTPException(503, "Cannot verify lock status — try again later")

    records = result.get("records", [])
    what_id = records[0].get("WhatId") if records else None
    task_owner_id = records[0].get("OwnerId") if records else None

    if what_id:
        lock = await db.fetchrow(
            "SELECT locked_by FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", what_id
        )
        if lock:
            perms = user.get("_permissions", {})
            sf_user_id = (user.get("_app_user") or {}).get("sf_user_id")
            return {
                "what_id": what_id,
                "task_owner_id": task_owner_id,
                "is_locked": True,
                "is_lock_owner": lock["locked_by"] == sf_user_id,
                "is_admin": perms.get("manage_users_roles", False),
                "is_task_owner": task_owner_id == sf_user_id,
            }

    return {
        "what_id": what_id,
        "task_owner_id": task_owner_id,
        "is_locked": False,
        "is_lock_owner": False,
        "is_admin": False,
        "is_task_owner": False,
    }


# ── My Permissions ──


@router.get("/me")
async def get_my_permissions(request: Request, user=Depends(require_auth), db=Depends(get_db)):
    """Get the current user's resolved permissions.

    Also backfills name/sf_user_id if missing AND lazily links bedrock.app_user
    to public.org_users by email (Phase B-2 of Claim 3 — staff identity unification).
    The link backfill lives here, not in get_user_permissions(), because /me is
    the natural once-per-session entrypoint and we don't want extra DB calls on
    every permission check.
    """
    email = user.get("email", "")
    user_data = await get_user_permissions(email, db)
    uid = user_data.get("id")
    if uid:
        updates = {}
        # Backfill name from auth JWT
        auth_name = user.get("name", "")
        if not user_data.get("name") and auth_name:
            updates["name"] = auth_name
        # Backfill sf_user_id from Salesforce OAuth cookie
        if not user_data.get("sf_user_id"):
            sf_cookie = request.cookies.get("sf_tokens")
            if sf_cookie:
                tokens = decrypt_tokens(sf_cookie)
                if tokens and tokens.get("user_id"):
                    updates["sf_user_id"] = tokens["user_id"]
        # Apply backfill updates
        if updates:
            sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
            vals = [uid] + list(updates.values())
            await db.execute(f"UPDATE bedrock.app_user SET {sets}, updated_at = now() WHERE id = $1", *vals)
            user_data.update(updates)

        # Phase B-2: lazy link to public.org_users (once per session, here only)
        org_user = await _try_link_org_user(
            email, uid, user_data.get("org_user_id"), db,
        )
        if org_user:
            user_data["org_user_id"] = org_user.get("id") or user_data.get("org_user_id")
            # Backfill display name from platform if Bedrock has none
            if not user_data.get("name") and org_user.get("display_name"):
                try:
                    await db.execute(
                        "UPDATE bedrock.app_user SET name = $1 WHERE id = $2",
                        org_user["display_name"], uid,
                    )
                    user_data["name"] = org_user["display_name"]
                except Exception as e:
                    logger.debug(f"Failed to backfill display name for {email}: {e}")
    perms = user_data.get("permissions") or {}
    org_user_id_raw = user_data.get("org_user_id")
    return {
        "success": True,
        "data": {
            "user_id": str(user_data.get("id", "")),
            "email": user_data.get("email"),
            "name": user_data.get("name"),
            "sf_user_id": user_data.get("sf_user_id"),
            "profile_name": user_data.get("profile_name"),
            "is_active": user_data.get("is_active", True),
            # Phase B-2: platform staff identity link. None means the user
            # exists in Bedrock but isn't yet in public.org_users — frontend
            # surfaces a soft-block banner so they know to contact platform admin.
            "org_user_id": str(org_user_id_raw) if org_user_id_raw else None,
            "permissions": {k: perms.get(k, False) for k in PERMISSION_KEYS},
        },
    }


# ── Identity audit (Phase B-4 of Claim 3) ──


@router.get("/admin/identity-audit")
async def identity_audit(user=Depends(require_admin), db=Depends(get_db)):
    """Audit the bedrock.app_user → public.org_users link health.

    Returns:
        - summary: total / linked / unlinked / name_drift counts
        - unlinked: rows in bedrock.app_user with no public.org_users match
        - name_drift: rows where bedrock.app_user.name differs from
                      public.org_users.display_name (potential staleness)

    Admin-only. Use after Phase B-3 backfill to confirm coverage and
    after deploy to monitor identity drift over time.
    """
    try:
        rows = await db.fetch("""
            SELECT
                au.id AS bedrock_id,
                au.email,
                au.name AS bedrock_name,
                au.is_active,
                au.org_user_id,
                ou.display_name AS org_name,
                ou.created_at AS org_created
            FROM bedrock.app_user au
            LEFT JOIN public.org_users ou ON ou.id = au.org_user_id
            ORDER BY (au.org_user_id IS NULL) DESC, au.email
        """)
    except Exception as e:
        # public.org_users may not exist on local-dev DB
        logger.warning(f"identity_audit: cross-schema query failed: {e}")
        rows = await db.fetch("""
            SELECT
                au.id AS bedrock_id,
                au.email,
                au.name AS bedrock_name,
                au.is_active,
                au.org_user_id,
                NULL::text AS org_name,
                NULL::timestamptz AS org_created
            FROM bedrock.app_user au
            ORDER BY au.email
        """)

    def _serialize(r):
        d = dict(r)
        # Convert UUIDs and timestamps to strings for JSON
        if d.get("bedrock_id") is not None:
            d["bedrock_id"] = str(d["bedrock_id"])
        if d.get("org_user_id") is not None:
            d["org_user_id"] = str(d["org_user_id"])
        if d.get("org_created") is not None:
            d["org_created"] = d["org_created"].isoformat()
        return d

    serialized = [_serialize(r) for r in rows]
    unlinked = [r for r in serialized if r.get("org_user_id") is None]
    linked = [r for r in serialized if r.get("org_user_id") is not None]
    name_drift = [
        r for r in linked
        if r.get("bedrock_name")
        and r.get("org_name")
        and r["bedrock_name"] != r["org_name"]
    ]

    return {
        "success": True,
        "data": {
            "summary": {
                "total": len(serialized),
                "linked": len(linked),
                "unlinked": len(unlinked),
                "name_drift_count": len(name_drift),
            },
            "unlinked": unlinked,
            "name_drift": name_drift,
        },
    }


# ── Internal (service-to-service) ──


@router.get("/internal/{email}")
async def internal_get_permissions(
    email: str, user=Depends(require_auth_or_internal), db=Depends(get_db)
):
    """Internal endpoint for Pebble to check user permissions.

    Protected by X-Internal-Key (service-to-service auth).
    User-initiated requests (JWT) also work for debugging.
    """
    user_data = await get_user_permissions(email, db)
    perms = user_data.get("permissions") or {}
    return {"email": email, "permissions": {k: perms.get(k, False) for k in PERMISSION_KEYS}}


# ── Profile CRUD ──


class ProfileCreate(BaseModel):
    name: str
    description: str = ""
    is_default: bool = False
    permissions: Dict[str, bool] = {}


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_default: Optional[bool] = None
    permissions: Optional[Dict[str, bool]] = None


@router.get("/profiles")
async def list_profiles(user=Depends(require_auth), db=Depends(get_db)):
    """List all permission profiles."""
    rows = await db.fetch(
        "SELECT id, name, description, is_default, permissions, created_at "
        "FROM bedrock.permission_profile ORDER BY name"
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str, user=Depends(require_auth), db=Depends(get_db)):
    """Get a single permission profile."""
    pid = uuid.UUID(profile_id)
    row = await db.fetchrow("SELECT * FROM bedrock.permission_profile WHERE id = $1", pid)
    if not row:
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": dict(row)}


@router.post("/profiles")
async def create_profile(body: ProfileCreate, user=Depends(require_admin), db=Depends(get_db)):
    """Create a new permission profile."""
    # Validate permission keys
    clean_perms = {k: body.permissions.get(k, False) for k in PERMISSION_KEYS}
    # If setting as default, unset other defaults
    if body.is_default:
        await db.execute("UPDATE bedrock.permission_profile SET is_default = false WHERE is_default = true")
    row = await db.fetchrow(
        "INSERT INTO bedrock.permission_profile (name, description, is_default, permissions) "
        "VALUES ($1, $2, $3, $4) RETURNING *",
        body.name, body.description, body.is_default, clean_perms,
    )
    return {"success": True, "data": dict(row)}


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: str, body: ProfileUpdate, user=Depends(require_profile_editor), db=Depends(get_db)
):
    """Update a permission profile. Admins can edit all keys; profile editors cannot toggle system keys."""
    pid = uuid.UUID(profile_id)
    existing = await db.fetchrow("SELECT * FROM bedrock.permission_profile WHERE id = $1", pid)
    if not existing:
        raise HTTPException(404, "Profile not found")
    updates = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.is_default is not None:
        if body.is_default:
            await db.execute("UPDATE bedrock.permission_profile SET is_default = false WHERE is_default = true")
        updates["is_default"] = body.is_default
    if body.permissions is not None:
        clean_perms = {k: body.permissions.get(k, False) for k in PERMISSION_KEYS}
        # Escalation guard: non-admins cannot toggle system-level keys.
        # Preserve existing DB values for those keys regardless of what the client sends.
        caller_perms = user.get("_permissions", {})
        if not caller_perms.get("manage_users_roles"):
            existing_perms = _parse_perms(existing["permissions"])
            for key in SYSTEM_KEYS:
                clean_perms[key] = existing_perms.get(key, False)
        updates["permissions"] = clean_perms
    if not updates:
        return {"success": True, "data": dict(existing)}
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    vals = [pid] + list(updates.values())
    await db.execute(f"UPDATE bedrock.permission_profile SET {sets}, updated_at = now() WHERE id = $1", *vals)
    row = await db.fetchrow("SELECT * FROM bedrock.permission_profile WHERE id = $1", pid)
    return {"success": True, "data": dict(row)}


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str, user=Depends(require_admin), db=Depends(get_db)):
    """Delete a permission profile. Fails if users are assigned to it."""
    pid = uuid.UUID(profile_id)
    count = await db.fetchval("SELECT COUNT(*) FROM bedrock.app_user WHERE profile_id = $1", pid)
    if count > 0:
        raise HTTPException(
            400, f"Cannot delete: {count} user(s) are assigned to this profile. Reassign them first."
        )
    result = await db.execute("DELETE FROM bedrock.permission_profile WHERE id = $1", pid)
    if result == "DELETE 0":
        raise HTTPException(404, "Profile not found")
    return {"success": True, "data": {"message": "Profile deleted"}}


# ── User Management ──


@router.get("/users")
async def list_users(user=Depends(require_admin), db=Depends(get_db)):
    """List all app users with their profiles."""
    rows = await db.fetch(
        "SELECT au.id, au.sf_user_id, au.email, au.name, au.is_active, au.profile_id, "
        "pp.name as profile_name "
        "FROM bedrock.app_user au "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = au.profile_id "
        "ORDER BY au.name, au.email"
    )
    return {"success": True, "data": [dict(r) for r in rows]}


class UserUpdate(BaseModel):
    profile_id: Optional[str] = None
    sf_user_id: Optional[str] = None
    name: Optional[str] = None
    is_active: Optional[bool] = None


@router.put("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, user=Depends(require_admin), db=Depends(get_db)):
    """Update a user's profile, SF user ID, name, or active status."""
    uid = uuid.UUID(user_id)
    existing = await db.fetchrow("SELECT * FROM bedrock.app_user WHERE id = $1", uid)
    if not existing:
        raise HTTPException(404, "User not found")
    updates = {}
    if body.profile_id is not None:
        updates["profile_id"] = uuid.UUID(body.profile_id)
    if body.sf_user_id is not None:
        updates["sf_user_id"] = body.sf_user_id
    if body.name is not None:
        updates["name"] = body.name
    if body.is_active is not None:
        updates["is_active"] = body.is_active
    if not updates:
        return {"success": True, "data": dict(existing)}
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    vals = [uid] + list(updates.values())
    await db.execute(f"UPDATE bedrock.app_user SET {sets}, updated_at = now() WHERE id = $1", *vals)
    row = await db.fetchrow(
        "SELECT au.*, pp.name as profile_name FROM bedrock.app_user au "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = au.profile_id WHERE au.id = $1", uid
    )
    return {"success": True, "data": dict(row)}


# ── Permission Unlock Requests ──


class UnlockRequestCreate(BaseModel):
    profile_id: str
    permission_key: str


class UnlockRequestResolve(BaseModel):
    admin_note: str = ""


@router.post("/unlock-requests")
async def create_unlock_request(
    body: UnlockRequestCreate, user=Depends(require_profile_editor), db=Depends(get_db)
):
    """Create a permission unlock request for a system-level key."""
    if body.permission_key not in SYSTEM_KEYS:
        raise HTTPException(400, f"Key '{body.permission_key}' is not a system-level key")
    # Check for duplicate pending request
    existing = await db.fetchrow(
        "SELECT id FROM bedrock.permission_unlock_request "
        "WHERE profile_id = $1 AND permission_key = $2 AND status = 'pending'",
        uuid.UUID(body.profile_id), body.permission_key,
    )
    if existing:
        raise HTTPException(409, "A pending request already exists for this key")
    row = await db.fetchrow(
        "INSERT INTO bedrock.permission_unlock_request "
        "(profile_id, permission_key, requester_email) "
        "VALUES ($1, $2, $3) RETURNING *",
        uuid.UUID(body.profile_id), body.permission_key, user.get("email"),
    )
    return {"success": True, "data": dict(row)}


@router.get("/unlock-requests")
async def list_unlock_requests(
    request: Request, status: Optional[str] = None,
    user=Depends(require_auth), db=Depends(get_db),
):
    """List unlock requests. Admins see all; profile editors see only their own."""
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}

    base_query = (
        "SELECT ur.*, pp.name as profile_name "
        "FROM bedrock.permission_unlock_request ur "
        "LEFT JOIN bedrock.permission_profile pp ON pp.id = ur.profile_id"
    )
    conditions = []
    params: list = []

    if perms.get("manage_users_roles"):
        # Admin: see all requests, optionally filtered by status
        if status:
            conditions.append(f"ur.status = ${len(params) + 1}")
            params.append(status)
    elif perms.get("edit_permission_profiles"):
        # Profile editor: only own requests
        conditions.append(f"ur.requester_email = ${len(params) + 1}")
        params.append(user.get("email"))
        if status:
            conditions.append(f"ur.status = ${len(params) + 1}")
            params.append(status)
    else:
        raise HTTPException(403, "Permission denied")

    if conditions:
        base_query += " WHERE " + " AND ".join(conditions)
    base_query += " ORDER BY ur.created_at DESC"

    rows = await db.fetch(base_query, *params)
    return {"success": True, "data": [dict(r) for r in rows]}


@router.post("/unlock-requests/{request_id}/approve")
async def approve_unlock_request(
    request_id: str, user=Depends(require_admin), db=Depends(get_db)
):
    """Approve an unlock request and auto-toggle the permission on the profile."""
    rid = uuid.UUID(request_id)
    req = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    if not req:
        raise HTTPException(404, "Unlock request not found")
    if req["status"] != "pending":
        raise HTTPException(400, f"Request is already {req['status']}")
    # Mark as approved
    await db.execute(
        "UPDATE bedrock.permission_unlock_request "
        "SET status = 'approved', resolved_at = now(), resolved_by = $1 "
        "WHERE id = $2",
        user.get("email"), rid,
    )
    # Auto-toggle: set the permission key to true on the profile
    perm_patch = json.dumps({req["permission_key"]: True})
    await db.execute(
        "UPDATE bedrock.permission_profile "
        "SET permissions = permissions || $1::jsonb, updated_at = now() "
        "WHERE id = $2",
        perm_patch, req["profile_id"],
    )
    updated = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    return {"success": True, "data": dict(updated)}


@router.post("/unlock-requests/{request_id}/reject")
async def reject_unlock_request(
    request_id: str, body: UnlockRequestResolve,
    user=Depends(require_admin), db=Depends(get_db),
):
    """Reject an unlock request with an optional admin note."""
    rid = uuid.UUID(request_id)
    req = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    if not req:
        raise HTTPException(404, "Unlock request not found")
    if req["status"] != "pending":
        raise HTTPException(400, f"Request is already {req['status']}")
    await db.execute(
        "UPDATE bedrock.permission_unlock_request "
        "SET status = 'rejected', resolved_at = now(), resolved_by = $1, admin_note = $2 "
        "WHERE id = $3",
        user.get("email"), body.admin_note, rid,
    )
    updated = await db.fetchrow(
        "SELECT * FROM bedrock.permission_unlock_request WHERE id = $1", rid
    )
    return {"success": True, "data": dict(updated)}


# ── Opportunity Lock ──

opp_router = APIRouter(prefix="/api/opportunities", tags=["opportunity-lock"])


@opp_router.get("/locks")
async def get_all_locks(user=Depends(require_auth), db=Depends(get_db)):
    """Get all locked opportunity IDs."""
    rows = await db.fetch("SELECT sf_opportunity_id, locked_by, locked_at FROM bedrock.opportunity_lock")
    return {"success": True, "data": [dict(r) for r in rows]}


class LockRequest(BaseModel):
    """Frontend must pass the opportunity's OwnerId so we can verify ownership."""
    owner_id: str  # The opportunity's OwnerId from Salesforce data


@opp_router.post("/{opportunity_id}/lock")
async def lock_opportunity(
    opportunity_id: str, body: LockRequest, user=Depends(require_auth), db=Depends(get_db)
):
    """Lock an opportunity. Only the actual owner can lock (must have lock_own_opportunities)."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    if not perms.get("lock_own_opportunities", False):
        raise HTTPException(403, "You don't have permission to lock opportunities")
    sf_user_id = user_data.get("sf_user_id")
    if not sf_user_id:
        raise HTTPException(400, "Your account is not linked to a Salesforce user. Contact an admin.")
    # Verify the user is the actual owner of this opportunity
    if body.owner_id != sf_user_id:
        raise HTTPException(403, "You can only lock opportunities you own")
    row = await db.fetchrow(
        "INSERT INTO bedrock.opportunity_lock (sf_opportunity_id, locked_by) VALUES ($1, $2) "
        "ON CONFLICT (sf_opportunity_id) DO NOTHING RETURNING *",
        opportunity_id, sf_user_id,
    )
    if not row:
        return {"success": True, "data": None, "message": "Opportunity is already locked"}
    return {"success": True, "data": dict(row)}


@opp_router.delete("/{opportunity_id}/lock")
async def unlock_opportunity(opportunity_id: str, user=Depends(require_auth), db=Depends(get_db)):
    """Unlock an opportunity. Only the owner who locked it or an admin can unlock."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    user_data = await get_user_permissions(user.get("email", ""), db)
    perms = user_data.get("permissions") or {}
    sf_user_id = user_data.get("sf_user_id")
    lock = await db.fetchrow(
        "SELECT * FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
    )
    if not lock:
        raise HTTPException(404, "Opportunity is not locked")
    is_owner = (lock["locked_by"] == sf_user_id)
    is_admin = perms.get("manage_users_roles", False)
    if not is_owner and not is_admin:
        raise HTTPException(403, "Only the owner who locked this or an admin can unlock")
    await db.execute("DELETE FROM bedrock.opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id)
    return {"success": True, "data": {"message": "Opportunity unlocked"}}
