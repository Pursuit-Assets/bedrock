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

# All 19 permission keys — used for validation
PERMISSION_KEYS = [
    "view_opportunities", "edit_own_opportunities", "edit_all_opportunities",
    "create_opportunities", "bulk_update_opportunities", "lock_own_opportunities",
    "view_tasks", "edit_own_tasks", "edit_all_tasks", "create_tasks",
    "view_revenue_dashboard", "view_cashflow_forecasts",
    "view_sage_invoices_payments", "create_sage_invoices",
    "match_invoices", "manage_payment_schedules", "generate_financial_reports",
    "trigger_data_sync", "manage_users_roles",
    "use_pebble_chat",
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


async def get_user_permissions(email: str, db) -> Dict[str, Any]:
    """Get resolved permissions for a user. Auto-provisions if needed."""
    row = await db.fetchrow(
        "SELECT au.id, au.sf_user_id, au.email, au.name, au.is_active, "
        "pp.permissions, pp.name as profile_name "
        "FROM app_user au "
        "LEFT JOIN permission_profile pp ON pp.id = au.profile_id "
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
    user_count = await db.fetchval("SELECT COUNT(*) FROM app_user")
    if user_count == 0:
        # Bootstrap: first user is Admin
        admin_profile = await db.fetchrow(
            "SELECT id, permissions, name FROM permission_profile WHERE name = 'Admin'"
        )
        if admin_profile:
            logger.info(f"Bootstrap: first user {email} auto-assigned Admin profile")
            new_user = await db.fetchrow(
                "INSERT INTO app_user (email, profile_id) VALUES ($1, $2) "
                "RETURNING id, sf_user_id, email, name, is_active",
                email, admin_profile["id"],
            )
            result = dict(new_user)
            result["permissions"] = _parse_perms(admin_profile["permissions"])
            result["profile_name"] = admin_profile["name"]
            return result
    default_profile = await db.fetchrow(
        "SELECT id, permissions, name FROM permission_profile WHERE is_default = true"
    )
    profile_id = default_profile["id"] if default_profile else None
    new_user = await db.fetchrow(
        "INSERT INTO app_user (email, profile_id) VALUES ($1, $2) "
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
            "SELECT locked_by FROM opportunity_lock WHERE sf_opportunity_id = $1", what_id
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
    """Get the current user's resolved permissions. Also backfills name/sf_user_id if missing."""
    user_data = await get_user_permissions(user.get("email", ""), db)
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
            await db.execute(f"UPDATE app_user SET {sets}, updated_at = now() WHERE id = $1", *vals)
            user_data.update(updates)
    perms = user_data.get("permissions") or {}
    return {
        "success": True,
        "data": {
            "user_id": str(user_data.get("id", "")),
            "email": user_data.get("email"),
            "name": user_data.get("name"),
            "sf_user_id": user_data.get("sf_user_id"),
            "profile_name": user_data.get("profile_name"),
            "is_active": user_data.get("is_active", True),
            "permissions": {k: perms.get(k, False) for k in PERMISSION_KEYS},
        },
    }


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
        "FROM permission_profile ORDER BY name"
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str, user=Depends(require_auth), db=Depends(get_db)):
    """Get a single permission profile."""
    pid = uuid.UUID(profile_id)
    row = await db.fetchrow("SELECT * FROM permission_profile WHERE id = $1", pid)
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
        await db.execute("UPDATE permission_profile SET is_default = false WHERE is_default = true")
    row = await db.fetchrow(
        "INSERT INTO permission_profile (name, description, is_default, permissions) "
        "VALUES ($1, $2, $3, $4) RETURNING *",
        body.name, body.description, body.is_default, clean_perms,
    )
    return {"success": True, "data": dict(row)}


@router.put("/profiles/{profile_id}")
async def update_profile(
    profile_id: str, body: ProfileUpdate, user=Depends(require_admin), db=Depends(get_db)
):
    """Update a permission profile."""
    pid = uuid.UUID(profile_id)
    existing = await db.fetchrow("SELECT * FROM permission_profile WHERE id = $1", pid)
    if not existing:
        raise HTTPException(404, "Profile not found")
    updates = {}
    if body.name is not None:
        updates["name"] = body.name
    if body.description is not None:
        updates["description"] = body.description
    if body.is_default is not None:
        if body.is_default:
            await db.execute("UPDATE permission_profile SET is_default = false WHERE is_default = true")
        updates["is_default"] = body.is_default
    if body.permissions is not None:
        clean_perms = {k: body.permissions.get(k, False) for k in PERMISSION_KEYS}
        updates["permissions"] = clean_perms
    if not updates:
        return {"success": True, "data": dict(existing)}
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(updates))
    vals = [pid] + list(updates.values())
    await db.execute(f"UPDATE permission_profile SET {sets}, updated_at = now() WHERE id = $1", *vals)
    row = await db.fetchrow("SELECT * FROM permission_profile WHERE id = $1", pid)
    return {"success": True, "data": dict(row)}


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str, user=Depends(require_admin), db=Depends(get_db)):
    """Delete a permission profile. Fails if users are assigned to it."""
    pid = uuid.UUID(profile_id)
    count = await db.fetchval("SELECT COUNT(*) FROM app_user WHERE profile_id = $1", pid)
    if count > 0:
        raise HTTPException(
            400, f"Cannot delete: {count} user(s) are assigned to this profile. Reassign them first."
        )
    result = await db.execute("DELETE FROM permission_profile WHERE id = $1", pid)
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
        "FROM app_user au "
        "LEFT JOIN permission_profile pp ON pp.id = au.profile_id "
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
    existing = await db.fetchrow("SELECT * FROM app_user WHERE id = $1", uid)
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
    await db.execute(f"UPDATE app_user SET {sets}, updated_at = now() WHERE id = $1", *vals)
    row = await db.fetchrow(
        "SELECT au.*, pp.name as profile_name FROM app_user au "
        "LEFT JOIN permission_profile pp ON pp.id = au.profile_id WHERE au.id = $1", uid
    )
    return {"success": True, "data": dict(row)}


# ── Opportunity Lock ──

opp_router = APIRouter(prefix="/api/opportunities", tags=["opportunity-lock"])


@opp_router.get("/locks")
async def get_all_locks(user=Depends(require_auth), db=Depends(get_db)):
    """Get all locked opportunity IDs."""
    rows = await db.fetch("SELECT sf_opportunity_id, locked_by, locked_at FROM opportunity_lock")
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
        "INSERT INTO opportunity_lock (sf_opportunity_id, locked_by) VALUES ($1, $2) "
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
        "SELECT * FROM opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id
    )
    if not lock:
        raise HTTPException(404, "Opportunity is not locked")
    is_owner = (lock["locked_by"] == sf_user_id)
    is_admin = perms.get("manage_users_roles", False)
    if not is_owner and not is_admin:
        raise HTTPException(403, "Only the owner who locked this or an admin can unlock")
    await db.execute("DELETE FROM opportunity_lock WHERE sf_opportunity_id = $1", opportunity_id)
    return {"success": True, "data": {"message": "Opportunity unlocked"}}
