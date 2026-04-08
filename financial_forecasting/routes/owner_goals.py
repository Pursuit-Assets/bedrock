"""Owner goals API — per-Salesforce-User annual revenue targets.

Powers the Wall of Progress dashboard. Goals are scoped by (sf_user_id,
fiscal_year). For Pursuit, fiscal_year is the calendar year.

View: anyone with view_revenue_dashboard.
Edit: anyone with manage_owner_goals (defaults to Admin only).
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from db import get_db
from routes.permissions import check_permission
from security import validate_salesforce_id
from services.cache import cache

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/owner-goals", tags=["owner-goals"])

_CACHE_PREFIX = "owner_goals:"
_CACHE_TTL = 60  # seconds — short, since edits should propagate quickly


class OwnerGoalUpsert(BaseModel):
    fiscal_year: int = Field(..., ge=2000, le=2100)
    goal_amount: float = Field(..., ge=0, le=100_000_000)
    notes: str = ""


def _row_to_dict(row) -> dict:
    return {
        "sf_user_id": row["sf_user_id"],
        "fiscal_year": row["fiscal_year"],
        "goal_amount": float(row["goal_amount"]),
        "notes": row["notes"] or "",
        "created_by": row["created_by"],
        "updated_by": row["updated_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


@router.get("")
async def list_owner_goals(
    fiscal_year: int = Query(..., ge=2000, le=2100),
    user=Depends(check_permission("view_revenue_dashboard")),
    db=Depends(get_db),
):
    """List all owner goals for a fiscal year, keyed by sf_user_id."""
    cache_key = f"{_CACHE_PREFIX}list:{fiscal_year}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        rows = await db.fetch(
            "SELECT sf_user_id, fiscal_year, goal_amount, notes, "
            "created_by, updated_by, created_at, updated_at "
            "FROM bedrock.owner_goal "
            "WHERE fiscal_year = $1",
            fiscal_year,
        )
        goals = {row["sf_user_id"]: _row_to_dict(row) for row in rows}
        result = {"success": True, "data": goals}
        cache.set(cache_key, result, _CACHE_TTL)
        return result
    except Exception as e:
        logger.exception("Failed to list owner goals")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{sf_user_id}")
async def get_owner_goal(
    sf_user_id: str,
    fiscal_year: int = Query(..., ge=2000, le=2100),
    user=Depends(check_permission("view_revenue_dashboard")),
    db=Depends(get_db),
):
    """Get a single owner's goal for a fiscal year."""
    validate_salesforce_id(sf_user_id, "sf_user_id")
    try:
        row = await db.fetchrow(
            "SELECT sf_user_id, fiscal_year, goal_amount, notes, "
            "created_by, updated_by, created_at, updated_at "
            "FROM bedrock.owner_goal "
            "WHERE sf_user_id = $1 AND fiscal_year = $2",
            sf_user_id, fiscal_year,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Owner goal not found")
        return {"success": True, "data": _row_to_dict(row)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get owner goal")
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{sf_user_id}")
async def upsert_owner_goal(
    sf_user_id: str,
    payload: OwnerGoalUpsert,
    user=Depends(check_permission("manage_owner_goals")),
    db=Depends(get_db),
):
    """Create or update an owner's goal for a fiscal year."""
    validate_salesforce_id(sf_user_id, "sf_user_id")
    editor_email = user.get("email", "")
    try:
        row = await db.fetchrow(
            """
            INSERT INTO bedrock.owner_goal
                (sf_user_id, fiscal_year, goal_amount, notes, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $5, $5)
            ON CONFLICT (sf_user_id, fiscal_year) DO UPDATE SET
                goal_amount = EXCLUDED.goal_amount,
                notes       = EXCLUDED.notes,
                updated_by  = EXCLUDED.updated_by,
                updated_at  = now()
            RETURNING sf_user_id, fiscal_year, goal_amount, notes,
                      created_by, updated_by, created_at, updated_at
            """,
            sf_user_id,
            payload.fiscal_year,
            payload.goal_amount,
            payload.notes,
            editor_email,
        )
        cache.invalidate_prefix(_CACHE_PREFIX)
        logger.info(
            f"Owner goal upserted: sf_user_id={sf_user_id} fy={payload.fiscal_year} "
            f"amount={payload.goal_amount} by={editor_email}"
        )
        return {"success": True, "data": _row_to_dict(row)}
    except Exception as e:
        logger.exception("Failed to upsert owner goal")
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{sf_user_id}")
async def delete_owner_goal(
    sf_user_id: str,
    fiscal_year: int = Query(..., ge=2000, le=2100),
    user=Depends(check_permission("manage_owner_goals")),
    db=Depends(get_db),
):
    """Delete an owner's goal for a fiscal year (frontend treats as 'revert to default')."""
    validate_salesforce_id(sf_user_id, "sf_user_id")
    try:
        result = await db.execute(
            "DELETE FROM bedrock.owner_goal WHERE sf_user_id = $1 AND fiscal_year = $2",
            sf_user_id, fiscal_year,
        )
        deleted = result.endswith("1") if isinstance(result, str) else False
        if not deleted:
            raise HTTPException(status_code=404, detail="Owner goal not found")
        cache.invalidate_prefix(_CACHE_PREFIX)
        logger.info(
            f"Owner goal deleted: sf_user_id={sf_user_id} fy={fiscal_year} "
            f"by={user.get('email', '')}"
        )
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to delete owner goal")
        raise HTTPException(status_code=500, detail=str(e))
