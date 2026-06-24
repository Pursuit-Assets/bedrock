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


@router.get("/tasks/all")
async def list_all_jobs_tasks(
    status: Optional[str] = Query(None, description="filter to one status; omit for all open (non-Completed)"),
    include_completed: bool = Query(False),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    """Every jobs task across opportunities, prospects, and accounts in one list
    — the data behind the command-center task board. Each row is enriched with
    its parent label (so you can see *what* the task is about) and assignee
    display names (owner_ids → public.org_users). Defaults to open tasks; pass
    include_completed=true or a specific status to widen.
    """
    where = "deleted_at IS NULL"
    if status:
        if status not in VALID_STATUSES:
            raise HTTPException(400, f"Invalid status: {status}")
        where += " AND status = $1"
    elif not include_completed:
        where += " AND status <> 'Completed'"
    params = [status] if status else []

    rows = []
    for tbl in ("bedrock.jobs_task", "bedrock.jobs_account_task"):
        rows += await conn.fetch(f"SELECT {_COLS} FROM {tbl} WHERE {where}", *params)

    tasks = [_serialize(r) for r in rows]

    # ── Resolve parent labels (what the task is about) ──────────────────────
    opp_ids, contact_ids = [], []
    for t in tasks:
        if t["parent_type"] == "opportunity":
            try:
                opp_ids.append(uuid.UUID(t["parent_id"]))
            except (ValueError, AttributeError):
                pass
        elif t["parent_type"] == "prospect":
            try:
                contact_ids.append(int(t["parent_id"]))
            except (ValueError, TypeError):
                pass

    opp_labels: dict = {}
    if opp_ids:
        for r in await conn.fetch(
            "SELECT id, account_name, title, stage FROM bedrock.jobs_opportunity WHERE id = ANY($1::uuid[])",
            opp_ids,
        ):
            opp_labels[str(r["id"])] = {
                "label": r["account_name"] or "(untitled)",
                "sublabel": r["title"], "stage": r["stage"],
            }
    contact_labels: dict = {}
    if contact_ids:
        for r in await conn.fetch(
            "SELECT contact_id, full_name, current_company FROM public.contacts WHERE contact_id = ANY($1::int[])",
            contact_ids,
        ):
            contact_labels[str(r["contact_id"])] = {
                "label": r["full_name"] or "(unnamed)", "sublabel": r["current_company"], "stage": None,
            }

    # ── Resolve assignee names (owner_ids → org_users) ──────────────────────
    all_owner_ids = {oid for t in tasks for oid in t["owner_ids"]}
    owner_names: dict = {}
    if all_owner_ids:
        for r in await conn.fetch(
            "SELECT id, display_name, email FROM public.org_users WHERE id = ANY($1::uuid[])",
            [uuid.UUID(x) for x in all_owner_ids],
        ):
            owner_names[str(r["id"])] = r["display_name"] or r["email"]

    for t in tasks:
        if t["parent_type"] == "opportunity":
            meta = opp_labels.get(t["parent_id"])
        elif t["parent_type"] == "prospect":
            meta = contact_labels.get(t["parent_id"])
        else:  # account — parent_id is the account key (normalized name)
            meta = {"label": t["parent_id"], "sublabel": None, "stage": None}
        t["parent_label"] = (meta or {}).get("label") or t["parent_id"]
        t["parent_sublabel"] = (meta or {}).get("sublabel")
        t["parent_stage"] = (meta or {}).get("stage")
        t["owner_names"] = [owner_names.get(oid, oid) for oid in t["owner_ids"]]

    # Soonest deadline first (nulls last), then newest.
    tasks.sort(key=lambda t: (t["deadline"] or "9999-12-31", t["created_at"] or ""))
    return {"success": True, "data": tasks}


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
