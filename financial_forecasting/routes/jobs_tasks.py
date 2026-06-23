"""Generic tasks for the jobs pipeline.

Tasks hang off a (parent_type, parent_id) pair so the same table serves
both opportunities and prospects without per-entity tables.

  GET    /api/jobs/jobs-tasks?parent_type=&parent_id=   — list non-deleted
  POST   /api/jobs/jobs-tasks                            — create
  PATCH  /api/jobs/jobs-tasks/{task_id}                  — partial update
  DELETE /api/jobs/jobs-tasks/{task_id}                  — soft delete

Shapes mirror the project-task endpoints in routes/projects.py (minus
milestone_id, plus parent_type/parent_id).
"""

import logging
import uuid
from datetime import date as _date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])

VALID_PARENT_TYPES = {"opportunity", "prospect", "account"}
VALID_STATUSES = {"Not Started", "In Progress", "Completed", "Blocked", "On Hold"}


class JobsTaskCreate(BaseModel):
    parent_type: str
    parent_id: str
    title: str
    owner_ids: List[str] = []
    deadline: Optional[str] = None
    start_date: Optional[str] = None
    description: str = ""


class JobsTaskUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    owner: Optional[str] = None
    owner_ids: Optional[List[str]] = None
    deadline: Optional[str] = None
    start_date: Optional[str] = None
    description: Optional[str] = None
    links: Optional[List[str]] = None
    sort_order: Optional[int] = None


def _serialize(r) -> dict:
    return {
        "id": str(r["id"]),
        "parent_type": r["parent_type"],
        "parent_id": r["parent_id"],
        "title": r["title"],
        "status": r["status"],
        "owner": r["owner"],
        "owner_ids": [str(x) for x in (r["owner_ids"] or [])],
        "deadline": r["deadline"].isoformat() if r["deadline"] else None,
        "start_date": r["start_date"].isoformat() if r["start_date"] else None,
        "description": r["description"],
        "links": list(r["links"] or []),
        "sort_order": r["sort_order"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


_COLS = """id, parent_type, parent_id, title, status, owner, owner_ids,
           deadline, start_date, description, links, sort_order,
           created_at, updated_at"""

# Account-level tasks live in a bedrock_user-owned mirror table (no parent_type
# CHECK), since the original jobs_task is postgres-owned and locked to
# opportunity|prospect. Everything else stays in jobs_task.
def _table(parent_type: str) -> str:
    return "bedrock.jobs_account_task" if parent_type == "account" else "bedrock.jobs_task"


def _check_parent_type(parent_type: str) -> None:
    if parent_type not in VALID_PARENT_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid parent_type: {parent_type}")


@router.get("/jobs-tasks")
async def list_jobs_tasks(
    parent_type: str = Query(...),
    parent_id: str = Query(...),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    _check_parent_type(parent_type)
    rows = await conn.fetch(
        f"SELECT {_COLS} FROM {_table(parent_type)}"
        " WHERE parent_type = $1 AND parent_id = $2 AND deleted_at IS NULL "
        "ORDER BY sort_order ASC, created_at ASC",
        parent_type, parent_id,
    )
    return {"success": True, "data": [_serialize(r) for r in rows]}


@router.post("/jobs-tasks")
async def create_jobs_task(
    body: JobsTaskCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    _check_parent_type(body.parent_type)
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="title is required")

    deadline = _date.fromisoformat(body.deadline) if body.deadline else None
    start_date_val = _date.fromisoformat(body.start_date) if body.start_date else None
    owner_ids = [uuid.UUID(x) for x in body.owner_ids]

    row = await conn.fetchrow(
        f"""INSERT INTO {_table(body.parent_type)}
               (parent_type, parent_id, title, owner_ids, deadline, start_date, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING {_COLS}""",
        body.parent_type, body.parent_id, title, owner_ids, deadline,
        start_date_val, body.description,
    )
    return {"success": True, "data": _serialize(row)}


@router.patch("/jobs-tasks/{task_id}")
async def update_jobs_task(
    task_id: str,
    body: JobsTaskUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    tid = uuid.UUID(task_id)
    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "status" in fields and fields["status"] not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"Invalid status: {fields['status']}")

    if "deadline" in fields:
        fields["deadline"] = _date.fromisoformat(fields["deadline"]) if fields["deadline"] else None
    if "start_date" in fields:
        fields["start_date"] = _date.fromisoformat(fields["start_date"]) if fields["start_date"] else None
    if "owner_ids" in fields:
        fields["owner_ids"] = [uuid.UUID(x) for x in fields["owner_ids"]]

    sets = ", ".join(f"{k} = ${i + 2}" for i, k in enumerate(fields))
    vals = [tid] + list(fields.values())
    # task_id alone doesn't say which table; try the main one, then the
    # account mirror.
    row = None
    for tbl in ("bedrock.jobs_task", "bedrock.jobs_account_task"):
        row = await conn.fetchrow(
            f"UPDATE {tbl} SET {sets}, updated_at = now() "
            f"WHERE id = $1 AND deleted_at IS NULL RETURNING {_COLS}",
            *vals,
        )
        if row:
            break
    if not row:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"success": True, "data": _serialize(row)}


@router.delete("/jobs-tasks/{task_id}")
async def delete_jobs_task(
    task_id: str,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    tid = uuid.UUID(task_id)
    email = user.get("email", "") if isinstance(user, dict) else ""
    for tbl in ("bedrock.jobs_task", "bedrock.jobs_account_task"):
        result = await conn.execute(
            f"UPDATE {tbl} SET deleted_at = now(), deleted_by = $2 "
            "WHERE id = $1 AND deleted_at IS NULL",
            tid, email,
        )
        if result != "UPDATE 0":
            return {"success": True, "data": {"message": "Task deleted"}}
    raise HTTPException(status_code=404, detail="Task not found")
