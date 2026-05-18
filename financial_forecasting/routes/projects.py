"""Projects API router — CRUD for projects, workstreams, milestones, and tasks."""

import uuid
import math
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import require_auth
from db import get_db
from routes.permissions import require_admin, check_permission
from security import validate_salesforce_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["projects"])

# ── Pydantic models ──


class WorkstreamCreate(BaseModel):
    name: str
    description: str = ""
    sort_order: int = 0


class WorkstreamUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None


class MilestoneCreate(BaseModel):
    title: str
    status: str = "On Track"
    priority: str = "Now"
    owner: str = ""
    owner_ids: List[str] = []
    due_date: Optional[str] = None
    description: str = ""
    source_links: List[str] = []
    sort_order: int = 0


class MilestoneUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    priority: Optional[str] = None
    owner: Optional[str] = None
    owner_ids: Optional[List[str]] = None
    due_date: Optional[str] = None
    description: Optional[str] = None
    source_links: Optional[List[str]] = None
    sort_order: Optional[int] = None


class ProjectTaskCreate(BaseModel):
    title: str
    status: str = "Not Started"
    owner: str = ""
    owner_ids: List[str] = []
    deadline: Optional[str] = None
    start_date: Optional[str] = None
    description: str = ""
    updates: str = ""
    links: List[str] = []
    depends_on: List[str] = []
    sort_order: int = 0


class ProjectTaskUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    owner: Optional[str] = None
    owner_ids: Optional[List[str]] = None
    deadline: Optional[str] = None
    start_date: Optional[str] = None
    description: Optional[str] = None
    updates: Optional[str] = None
    links: Optional[List[str]] = None
    depends_on: Optional[List[str]] = None
    sort_order: Optional[int] = None


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    opportunity_id: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    opportunity_id: Optional[str] = None


class ContributorAdd(BaseModel):
    user_email: str


class OwnerTransfer(BaseModel):
    new_owner_email: str


class OpportunityLink(BaseModel):
    opportunity_id: str
    role: str = "linked"


class ProjectImportTask(BaseModel):
    title: str
    status: str = "Not Started"
    owner: str = ""
    owner_ids: List[str] = []
    deadline: Optional[str] = None
    start_date: Optional[str] = None
    description: str = ""


class ProjectImportMilestone(BaseModel):
    title: str
    status: str = "On Track"
    priority: str = "Now"
    owner: str = ""
    owner_ids: List[str] = []
    tasks: List[ProjectImportTask] = []


class ProjectImportWorkstream(BaseModel):
    name: str
    description: str = ""
    milestones: List[ProjectImportMilestone] = []


class ProjectImportPayload(BaseModel):
    workstreams: List[ProjectImportWorkstream]
    replace: bool = False


# ── Ownership helper (M19) ──


async def _check_project_role(
    conn, user: dict, project_id: uuid.UUID,
    *, require_owner: bool = False,
) -> dict:
    """Check user's role on a project. Returns project row or raises 403/404.

    If require_owner=True, only owner + admin can proceed.
    If require_owner=False, owner + editors + admin can proceed.
    """
    project = await conn.fetchrow(
        "SELECT id, name, owner_email FROM bedrock.project "
        "WHERE id = $1 AND deleted_at IS NULL", project_id
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    email = user.get("email", "")
    permissions = user.get("_permissions", {})
    is_admin = permissions.get("manage_users_roles", False)

    if is_admin:
        return dict(project)

    if project["owner_email"] and project["owner_email"] == email:
        return dict(project)

    if require_owner:
        raise HTTPException(
            status_code=403,
            detail="Only the project owner or an admin can perform this action",
        )

    contributor = await conn.fetchrow(
        "SELECT id FROM bedrock.project_contributor "
        "WHERE project_id = $1 AND user_email = $2", project_id, email
    )
    if not contributor:
        raise HTTPException(
            status_code=403, detail="You are not a contributor on this project"
        )

    return dict(project)


# ── Project endpoints ──


@router.get("/projects")
async def list_projects(user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """List all projects (includes the primary opportunity_id so the awards
    page can group projects without an N+1 fetch)."""
    rows = await conn.fetch(
        "SELECT id, name, description, owner_email, opportunity_id, "
        "created_at, updated_at "
        "FROM bedrock.project WHERE deleted_at IS NULL ORDER BY created_at"
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.get("/projects/trash")
async def list_deleted_projects(user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """List soft-deleted projects (trash view)."""
    rows = await conn.fetch(
        "SELECT id, name, description, owner_email, deleted_at, deleted_by "
        "FROM bedrock.project WHERE deleted_at IS NOT NULL "
        "ORDER BY deleted_at DESC"
    )
    return {"success": True, "data": [
        {"id": str(r["id"]), "name": r["name"], "description": r["description"],
         "owner_email": r["owner_email"],
         "deleted_at": r["deleted_at"].isoformat() if r["deleted_at"] else None,
         "deleted_by": r["deleted_by"]}
        for r in rows
    ]}


@router.get("/users/active")
async def list_active_users(user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """List all active staff — used by every picker that selects a person
    (project owner, project contributors, task/milestone owners).

    Covers every active Pursuit teammate, including those without project-edit
    rights: adding them as a contributor grants project view access, but
    mutating endpoints still enforce check_permission("edit_projects")
    separately. Service accounts are excluded by display_name so 'Systems
    Admin' never appears in the picker. Non-SF teammates (sf_user_id IS NULL)
    are surfaced via is_in_sf=false so the UI can visually distinguish them.
    """
    rows = await conn.fetch(
        "SELECT id, email, display_name, sf_user_id "
        "FROM public.org_users "
        "WHERE COALESCE(is_active, true) = true "
        "  AND display_name IS NOT NULL "
        "  AND LOWER(COALESCE(display_name, '')) <> 'systems admin' "
        "ORDER BY display_name, email"
    )
    return {
        "success": True,
        "data": [
            {
                "id": str(r["id"]),
                "email": r["email"],
                "display_name": r["display_name"],
                "sf_user_id": r["sf_user_id"],
                "is_in_sf": bool(r["sf_user_id"]),
            }
            for r in rows
        ],
    }


@router.get("/projects/{project_id}")
async def get_project(project_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get a full project tree: workstreams → milestones → tasks (single query)."""
    pid = uuid.UUID(project_id)

    project = await conn.fetchrow("SELECT * FROM bedrock.project WHERE id = $1 AND deleted_at IS NULL", pid)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    # Check whether the due_date column has been migrated yet.
    has_due_date = await conn.fetchval(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema='bedrock' AND table_name='milestone' AND column_name='due_date'"
    )

    due_date_col = "m.due_date AS m_due_date," if has_due_date else "NULL::date AS m_due_date,"

    rows = await conn.fetch(
        f"""
        SELECT
            w.id AS w_id, w.name AS w_name, w.description AS w_desc, w.sort_order AS w_sort,
            m.id AS m_id, m.title AS m_title, m.status AS m_status, m.priority AS m_priority,
            m.owner AS m_owner, m.owner_ids AS m_owner_ids, {due_date_col}
            m.description AS m_desc, m.source_links AS m_links, m.sort_order AS m_sort,
            t.id AS t_id, t.title AS t_title, t.status AS t_status, t.owner AS t_owner,
            t.owner_ids AS t_owner_ids,
            t.deadline AS t_deadline, t.start_date AS t_start_date, t.description AS t_desc,
            t.updates AS t_updates, t.links AS t_links, t.depends_on AS t_depends, t.sort_order AS t_sort
        FROM bedrock.workstream w
        LEFT JOIN bedrock.milestone m ON m.workstream_id = w.id AND m.deleted_at IS NULL
        LEFT JOIN bedrock.project_task t ON t.milestone_id = m.id AND t.deleted_at IS NULL
        WHERE w.project_id = $1 AND w.deleted_at IS NULL
        ORDER BY w.sort_order, m.sort_order, t.sort_order
        """,
        pid,
    )

    # Build nested dict
    ws_map: dict = {}
    ms_map: dict = {}

    for r in rows:
        wid = str(r["w_id"])
        if wid not in ws_map:
            ws_map[wid] = {
                "id": wid,
                "name": r["w_name"],
                "description": r["w_desc"],
                "sort_order": r["w_sort"],
                "milestones": [],
            }

        mid = str(r["m_id"]) if r["m_id"] else None
        if mid and mid not in ms_map:
            ms_obj = {
                "id": mid,
                "title": r["m_title"],
                "status": r["m_status"],
                "priority": r["m_priority"],
                "owner": r["m_owner"],
                "owner_ids": [str(u) for u in (r["m_owner_ids"] or [])],
                "due_date": r["m_due_date"].isoformat() if r["m_due_date"] else None,
                "description": r["m_desc"],
                "sourceLinks": r["m_links"] or [],
                "sort_order": r["m_sort"],
                "tasks": [],
            }
            ms_map[mid] = ms_obj
            ws_map[wid]["milestones"].append(ms_obj)

        if r["t_id"] and mid:
            ms_map[mid]["tasks"].append({
                "id": str(r["t_id"]),
                "title": r["t_title"],
                "status": r["t_status"],
                "owner": r["t_owner"],
                "owner_ids": [str(u) for u in (r["t_owner_ids"] or [])],
                "deadline": r["t_deadline"].isoformat() if r["t_deadline"] else None,
                "startDate": r["t_start_date"].isoformat() if r["t_start_date"] else None,
                "description": r["t_desc"],
                "updates": r["t_updates"],
                "links": r["t_links"] or [],
                "dependsOn": [str(d) for d in (r["t_depends"] or [])],
                "sort_order": r["t_sort"],
            })

    contributors = await conn.fetch(
        "SELECT user_email, role, added_by, added_at "
        "FROM bedrock.project_contributor WHERE project_id = $1 ORDER BY added_at",
        pid,
    )

    result = {
        "id": str(project["id"]),
        "name": project["name"],
        "description": project["description"],
        "owner_email": project["owner_email"],
        "created_by": project["created_by"],
        "contributors": [
            {"user_email": c["user_email"], "role": c["role"],
             "added_by": c["added_by"],
             "added_at": c["added_at"].isoformat() if c["added_at"] else None}
            for c in contributors
        ],
        "workstreams": list(ws_map.values()),
    }
    return {"success": True, "data": result}


@router.post("/projects")
async def create_project(body: ProjectCreate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Create a new project. The creating user becomes the owner.

    Optional `opportunity_id` lets the awards page create-from-award flow
    seed the primary opportunity link in one round-trip.
    """
    creator_email = user.get("email", "")
    if body.opportunity_id is not None:
        validate_salesforce_id(body.opportunity_id, "opportunity_id")
    row = await conn.fetchrow(
        "INSERT INTO bedrock.project (name, description, owner_email, created_by, opportunity_id) "
        "VALUES ($1, $2, $3, $3, $4) "
        "RETURNING id, name, description, owner_email, created_by, opportunity_id, created_at",
        body.name, body.description, creator_email, body.opportunity_id,
    )
    return {"success": True, "data": {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "owner_email": row["owner_email"],
        "created_by": row["created_by"],
        "opportunity_id": row["opportunity_id"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }}


@router.put("/projects/{project_id}")
async def update_project(project_id: str, body: ProjectUpdate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Update a project (name/description/opportunity_id)."""
    pid = uuid.UUID(project_id)
    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")
    if "opportunity_id" in fields:
        validate_salesforce_id(fields["opportunity_id"], "opportunity_id")
    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields))
    vals = [pid] + list(fields.values())
    await conn.execute(f"UPDATE bedrock.project SET {sets} WHERE id = $1 AND deleted_at IS NULL", *vals)
    return {"success": True, "data": {"message": "Project updated"}}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Soft-delete a project and cascade to all children. Owner or admin only."""
    pid = uuid.UUID(project_id)
    email = user.get("email", "")
    permissions = user.get("_permissions", {})
    is_admin = permissions.get("manage_users_roles", False)

    # Ownership gate: only owner or admin can delete
    owner_row = await conn.fetchrow(
        "SELECT owner_email FROM bedrock.project WHERE id = $1 AND deleted_at IS NULL", pid
    )
    if not owner_row:
        raise HTTPException(status_code=404, detail="Project not found")
    if not is_admin and (not owner_row["owner_email"] or owner_row["owner_email"] != email):
        raise HTTPException(
            status_code=403,
            detail="Only the project owner or an admin can delete this project",
        )

    async with conn.transaction():
        result = await conn.execute(
            "UPDATE bedrock.project SET deleted_at = now(), deleted_by = $2 "
            "WHERE id = $1 AND deleted_at IS NULL",
            pid, email,
        )
        if result == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Project not found")
        await conn.execute(
            "UPDATE bedrock.workstream SET deleted_at = now(), deleted_by = $2 "
            "WHERE project_id = $1 AND deleted_at IS NULL",
            pid, email,
        )
        await conn.execute(
            "UPDATE bedrock.milestone SET deleted_at = now(), deleted_by = $2 "
            "WHERE workstream_id IN (SELECT id FROM bedrock.workstream WHERE project_id = $1) "
            "AND deleted_at IS NULL",
            pid, email,
        )
        await conn.execute(
            "UPDATE bedrock.project_task SET deleted_at = now(), deleted_by = $2 "
            "WHERE milestone_id IN ("
            "  SELECT m.id FROM bedrock.milestone m"
            "  JOIN bedrock.workstream w ON w.id = m.workstream_id"
            "  WHERE w.project_id = $1"
            ") AND deleted_at IS NULL",
            pid, email,
        )
    return {"success": True, "data": {"message": "Project moved to trash"}}


@router.post("/projects/{project_id}/restore")
async def restore_project(project_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Restore a soft-deleted project and its cascade-deleted children. Owner or admin only."""
    pid = uuid.UUID(project_id)
    async with conn.transaction():
        project = await conn.fetchrow(
            "SELECT deleted_at, owner_email FROM bedrock.project "
            "WHERE id = $1 AND deleted_at IS NOT NULL",
            pid,
        )
        if not project:
            raise HTTPException(status_code=404, detail="Deleted project not found")

        # Inline ownership check (can't use helper — project is deleted)
        email = user.get("email", "")
        permissions = user.get("_permissions", {})
        is_admin = permissions.get("manage_users_roles", False)
        if not is_admin and (not project["owner_email"] or project["owner_email"] != email):
            raise HTTPException(
                status_code=403,
                detail="Only the project owner or an admin can restore this project",
            )

        cascade_ts = project["deleted_at"]

        await conn.execute(
            "UPDATE bedrock.project SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", pid
        )
        await conn.execute(
            "UPDATE bedrock.workstream SET deleted_at = NULL, deleted_by = NULL "
            "WHERE project_id = $1 AND deleted_at = $2",
            pid, cascade_ts,
        )
        await conn.execute(
            "UPDATE bedrock.milestone SET deleted_at = NULL, deleted_by = NULL "
            "WHERE workstream_id IN (SELECT id FROM bedrock.workstream WHERE project_id = $1) "
            "AND deleted_at = $2",
            pid, cascade_ts,
        )
        await conn.execute(
            "UPDATE bedrock.project_task SET deleted_at = NULL, deleted_by = NULL "
            "WHERE milestone_id IN ("
            "  SELECT m.id FROM bedrock.milestone m"
            "  JOIN bedrock.workstream w ON w.id = m.workstream_id"
            "  WHERE w.project_id = $1"
            ") AND deleted_at = $2",
            pid, cascade_ts,
        )
    return {"success": True, "data": {"message": "Project restored"}}


@router.delete("/projects/{project_id}/purge")
async def purge_project(project_id: str, user=Depends(require_admin), conn=Depends(get_db)):
    """Permanently delete a soft-deleted project. Admin only, after 60-day retention."""
    pid = uuid.UUID(project_id)
    check = await conn.fetchrow(
        "SELECT id, deleted_at FROM bedrock.project WHERE id = $1 AND deleted_at IS NOT NULL", pid
    )
    if not check:
        raise HTTPException(status_code=404, detail="Deleted project not found")

    # Enforce 60-day retention period
    deleted_at = check["deleted_at"]
    if deleted_at.tzinfo is None:
        deleted_at = deleted_at.replace(tzinfo=timezone.utc)
    retention = timedelta(days=60)
    age = datetime.now(timezone.utc) - deleted_at
    if age < retention:
        days_left = math.ceil((retention - age).total_seconds() / 86400)
        raise HTTPException(
            status_code=400,
            detail=f"Projects must remain in trash for 60 days before permanent deletion. {days_left} day(s) remaining.",
        )

    await conn.execute("DELETE FROM bedrock.project WHERE id = $1", pid)
    return {"success": True, "data": {"message": "Project permanently deleted"}}


# ── Project Contributors & Ownership (M19) ──


@router.post("/projects/{project_id}/contributors")
async def add_contributor(
    project_id: str, body: ContributorAdd,
    user=Depends(check_permission("edit_projects")), conn=Depends(get_db),
):
    """Add an editor to a project. Owner or admin only."""
    pid = uuid.UUID(project_id)
    proj = await _check_project_role(conn, user, pid, require_owner=True)

    if body.user_email == proj["owner_email"]:
        raise HTTPException(status_code=400, detail="Cannot add the owner as a contributor")

    row = await conn.fetchrow(
        "INSERT INTO bedrock.project_contributor (project_id, user_email, added_by) "
        "VALUES ($1, $2, $3) "
        "ON CONFLICT (project_id, user_email) DO NOTHING "
        "RETURNING id, project_id, user_email, role, added_by, added_at",
        pid, body.user_email, user.get("email", ""),
    )
    if not row:
        return {"success": True, "data": None, "message": "User is already a contributor"}
    return {"success": True, "data": {
        "user_email": row["user_email"], "role": row["role"],
        "added_by": row["added_by"],
        "added_at": row["added_at"].isoformat() if row["added_at"] else None,
    }}


@router.delete("/projects/{project_id}/contributors/{user_email}")
async def remove_contributor(
    project_id: str, user_email: str,
    user=Depends(check_permission("edit_projects")), conn=Depends(get_db),
):
    """Remove an editor from a project. Owner or admin only."""
    pid = uuid.UUID(project_id)
    await _check_project_role(conn, user, pid, require_owner=True)

    result = await conn.execute(
        "DELETE FROM bedrock.project_contributor "
        "WHERE project_id = $1 AND user_email = $2",
        pid, user_email,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Contributor not found")
    return {"success": True, "data": {"message": "Contributor removed"}}


@router.put("/projects/{project_id}/owner")
async def transfer_ownership(
    project_id: str, body: OwnerTransfer,
    user=Depends(check_permission("edit_projects")), conn=Depends(get_db),
):
    """Transfer project ownership. Owner or admin only.

    Old owner becomes editor; new owner is removed from contributors.
    """
    pid = uuid.UUID(project_id)
    proj = await _check_project_role(conn, user, pid, require_owner=True)
    old_owner = proj["owner_email"]

    if body.new_owner_email == old_owner:
        raise HTTPException(status_code=400, detail="New owner is already the owner")

    async with conn.transaction():
        # Demote old owner to editor (no-op if already a contributor)
        if old_owner:
            await conn.execute(
                "INSERT INTO bedrock.project_contributor (project_id, user_email, added_by) "
                "VALUES ($1, $2, $3) ON CONFLICT (project_id, user_email) DO NOTHING",
                pid, old_owner, user.get("email", ""),
            )
        # Set new owner
        await conn.execute(
            "UPDATE bedrock.project SET owner_email = $2 WHERE id = $1",
            pid, body.new_owner_email,
        )
        # Remove new owner from contributors (they're now the owner)
        await conn.execute(
            "DELETE FROM bedrock.project_contributor "
            "WHERE project_id = $1 AND user_email = $2",
            pid, body.new_owner_email,
        )
    return {"success": True, "data": {"message": f"Ownership transferred to {body.new_owner_email}"}}


# ── Project ↔ Opportunity Linking ──


@router.post("/projects/{project_id}/opportunities")
async def link_opportunity(project_id: str, body: OpportunityLink, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Link a CRM Opportunity to a Project."""
    pid = uuid.UUID(project_id)
    validate_salesforce_id(body.opportunity_id, "opportunity_id")
    try:
        row = await conn.fetchrow(
            "INSERT INTO bedrock.project_opportunity (project_id, opportunity_id, role) "
            "VALUES ($1, $2, $3) "
            "ON CONFLICT (project_id, opportunity_id) DO UPDATE SET role = $3 "
            "RETURNING id, project_id, opportunity_id, role",
            pid, body.opportunity_id, body.role,
        )
        return {"success": True, "data": {
            "id": str(row["id"]),
            "project_id": str(row["project_id"]),
            "opportunity_id": row["opportunity_id"],
            "role": row["role"],
        }}
    except Exception as e:
        logger.error(f"Error linking opportunity to project: {e}")
        raise HTTPException(status_code=500, detail="Failed to link opportunity")


@router.delete("/projects/{project_id}/opportunities/{opportunity_id}")
async def unlink_opportunity(project_id: str, opportunity_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Remove the link between a Project and an Opportunity."""
    pid = uuid.UUID(project_id)
    validate_salesforce_id(opportunity_id, "opportunity_id")
    result = await conn.execute(
        "DELETE FROM bedrock.project_opportunity WHERE project_id = $1 AND opportunity_id = $2",
        pid, opportunity_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Link not found")
    return {"success": True, "data": {"message": "Opportunity unlinked"}}


@router.get("/projects/{project_id}/opportunities")
async def get_project_opportunities(project_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get all Opportunities linked to a Project."""
    pid = uuid.UUID(project_id)
    rows = await conn.fetch(
        "SELECT id, opportunity_id, role, created_at "
        "FROM bedrock.project_opportunity WHERE project_id = $1 ORDER BY created_at",
        pid,
    )
    return {"success": True, "data": [
        {"id": str(r["id"]), "opportunity_id": r["opportunity_id"],
         "role": r["role"], "created_at": r["created_at"].isoformat() if r["created_at"] else None}
        for r in rows
    ]}


# ── Bulk Import ──


@router.post("/projects/{project_id}/import")
async def import_project_data(project_id: str, body: ProjectImportPayload, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Bulk import workstreams/milestones/tasks into a project.

    Smart merge: matches by name/title (case-insensitive) within hierarchy.
    If replace=True, deletes all existing data first.
    """
    from datetime import date as d

    pid = uuid.UUID(project_id)

    project = await conn.fetchrow("SELECT id FROM bedrock.project WHERE id = $1 AND deleted_at IS NULL", pid)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    summary = {
        "workstreams": {"new": 0, "updated": 0},
        "milestones": {"new": 0, "updated": 0},
        "tasks": {"new": 0, "updated": 0, "unchanged": 0},
    }

    async with conn.transaction():
        if body.replace:
            import_email = user.get("email", "")
            await conn.execute(
                "UPDATE bedrock.project_task SET deleted_at = now(), deleted_by = $2 "
                "WHERE milestone_id IN ("
                "  SELECT m.id FROM bedrock.milestone m"
                "  JOIN bedrock.workstream w ON w.id = m.workstream_id"
                "  WHERE w.project_id = $1"
                ") AND deleted_at IS NULL",
                pid, import_email,
            )
            await conn.execute(
                "UPDATE bedrock.milestone SET deleted_at = now(), deleted_by = $2 "
                "WHERE workstream_id IN (SELECT id FROM bedrock.workstream WHERE project_id = $1) "
                "AND deleted_at IS NULL",
                pid, import_email,
            )
            await conn.execute(
                "UPDATE bedrock.workstream SET deleted_at = now(), deleted_by = $2 "
                "WHERE project_id = $1 AND deleted_at IS NULL",
                pid, import_email,
            )

        existing_ws = await conn.fetch(
            "SELECT id, name FROM bedrock.workstream WHERE project_id = $1 AND deleted_at IS NULL", pid
        )
        ws_by_name = {r["name"].lower(): r for r in existing_ws}

        for ws_idx, ws in enumerate(body.workstreams):
            ws_key = ws.name.lower()
            existing = ws_by_name.get(ws_key)

            if existing:
                wid = existing["id"]
                if ws.description:
                    await conn.execute(
                        "UPDATE bedrock.workstream SET description = $2, sort_order = $3 WHERE id = $1 AND deleted_at IS NULL",
                        wid, ws.description, ws_idx,
                    )
                summary["workstreams"]["updated"] += 1
            else:
                row = await conn.fetchrow(
                    "INSERT INTO bedrock.workstream (project_id, name, description, sort_order) "
                    "VALUES ($1, $2, $3, $4) RETURNING id",
                    pid, ws.name, ws.description, ws_idx,
                )
                wid = row["id"]
                summary["workstreams"]["new"] += 1

            existing_ms = await conn.fetch(
                "SELECT id, title FROM bedrock.milestone WHERE workstream_id = $1 AND deleted_at IS NULL", wid
            )
            ms_by_title = {r["title"].lower(): r for r in existing_ms}

            for ms_idx, ms in enumerate(ws.milestones):
                ms_key = ms.title.lower()
                existing_m = ms_by_title.get(ms_key)

                ms_owner_ids = [uuid.UUID(x) for x in ms.owner_ids]
                if existing_m:
                    mid = existing_m["id"]
                    await conn.execute(
                        "UPDATE bedrock.milestone SET status = $2, priority = $3, owner = $4, owner_ids = $5, sort_order = $6 WHERE id = $1 AND deleted_at IS NULL",
                        mid, ms.status, ms.priority, ms.owner, ms_owner_ids, ms_idx,
                    )
                    summary["milestones"]["updated"] += 1
                else:
                    row = await conn.fetchrow(
                        "INSERT INTO bedrock.milestone (workstream_id, title, status, priority, owner, owner_ids, sort_order) "
                        "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
                        wid, ms.title, ms.status, ms.priority, ms.owner, ms_owner_ids, ms_idx,
                    )
                    mid = row["id"]
                    summary["milestones"]["new"] += 1

                existing_tasks = await conn.fetch(
                    "SELECT id, title, status, owner, owner_ids, deadline, start_date FROM bedrock.project_task WHERE milestone_id = $1 AND deleted_at IS NULL", mid
                )
                task_by_title = {r["title"].lower(): r for r in existing_tasks}

                for t_idx, task in enumerate(ms.tasks):
                    t_key = task.title.lower()
                    existing_t = task_by_title.get(t_key)

                    deadline_val = d.fromisoformat(task.deadline) if task.deadline else None
                    start_val = d.fromisoformat(task.start_date) if task.start_date else None
                    if deadline_val and not start_val:
                        from datetime import timedelta
                        start_val = deadline_val - timedelta(days=7)

                    t_owner_ids = [uuid.UUID(x) for x in task.owner_ids]

                    if existing_t:
                        changed = (
                            existing_t["status"] != task.status
                            or existing_t["owner"] != task.owner
                            or list(existing_t["owner_ids"] or []) != t_owner_ids
                            or existing_t["deadline"] != deadline_val
                            or existing_t["start_date"] != start_val
                        )
                        if changed:
                            await conn.execute(
                                "UPDATE bedrock.project_task SET status = $2, owner = $3, owner_ids = $4, deadline = $5, "
                                "start_date = $6, description = $7, sort_order = $8 WHERE id = $1 AND deleted_at IS NULL",
                                existing_t["id"], task.status, task.owner, t_owner_ids,
                                deadline_val, start_val, task.description, t_idx,
                            )
                            summary["tasks"]["updated"] += 1
                        else:
                            summary["tasks"]["unchanged"] += 1
                    else:
                        await conn.execute(
                            "INSERT INTO bedrock.project_task (milestone_id, title, status, owner, owner_ids, deadline, "
                            "start_date, description, sort_order) "
                            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                            mid, task.title, task.status, task.owner, t_owner_ids,
                            deadline_val, start_val, task.description, t_idx,
                        )
                        summary["tasks"]["new"] += 1

    return {"success": True, "data": summary}


# ── Workstream CRUD ──


@router.post("/projects/{project_id}/workstreams")
async def create_workstream(project_id: str, body: WorkstreamCreate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    row = await conn.fetchrow(
        """INSERT INTO bedrock.workstream (project_id, name, description, sort_order)
           VALUES ($1, $2, $3, $4) RETURNING id""",
        pid, body.name, body.description, body.sort_order,
    )
    return {"success": True, "data": {"id": str(row["id"])}}


@router.put("/workstreams/{workstream_id}")
async def update_workstream(workstream_id: str, body: WorkstreamUpdate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    wid = uuid.UUID(workstream_id)
    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields))
    vals = [wid] + list(fields.values())
    await conn.execute(f"UPDATE bedrock.workstream SET {sets} WHERE id = $1 AND deleted_at IS NULL", *vals)
    return {"success": True, "data": {"message": "Workstream updated"}}


@router.delete("/workstreams/{workstream_id}")
async def delete_workstream(workstream_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Soft-delete a workstream and cascade to milestones + tasks."""
    wid = uuid.UUID(workstream_id)
    email = user.get("email", "")
    async with conn.transaction():
        result = await conn.execute(
            "UPDATE bedrock.workstream SET deleted_at = now(), deleted_by = $2 "
            "WHERE id = $1 AND deleted_at IS NULL",
            wid, email,
        )
        if result == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Workstream not found")
        await conn.execute(
            "UPDATE bedrock.milestone SET deleted_at = now(), deleted_by = $2 "
            "WHERE workstream_id = $1 AND deleted_at IS NULL",
            wid, email,
        )
        await conn.execute(
            "UPDATE bedrock.project_task SET deleted_at = now(), deleted_by = $2 "
            "WHERE milestone_id IN (SELECT id FROM bedrock.milestone WHERE workstream_id = $1) "
            "AND deleted_at IS NULL",
            wid, email,
        )
    return {"success": True, "data": {"message": "Workstream moved to trash"}}


# ── Milestone CRUD ──


@router.post("/workstreams/{workstream_id}/milestones")
async def create_milestone(workstream_id: str, body: MilestoneCreate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    from datetime import date as d
    wid = uuid.UUID(workstream_id)
    owner_ids = [uuid.UUID(x) for x in body.owner_ids]
    has_due_date_col = await conn.fetchval(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_schema='bedrock' AND table_name='milestone' AND column_name='due_date'"
    )
    if has_due_date_col:
        due_date_val = d.fromisoformat(body.due_date) if body.due_date else None
        row = await conn.fetchrow(
            """INSERT INTO bedrock.milestone (workstream_id, title, status, priority, owner, owner_ids, due_date, description, source_links, sort_order)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id""",
            wid, body.title, body.status, body.priority, body.owner, owner_ids, due_date_val,
            body.description, body.source_links, body.sort_order,
        )
    else:
        row = await conn.fetchrow(
            """INSERT INTO bedrock.milestone (workstream_id, title, status, priority, owner, owner_ids, description, source_links, sort_order)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id""",
            wid, body.title, body.status, body.priority, body.owner, owner_ids,
            body.description, body.source_links, body.sort_order,
        )
    return {"success": True, "data": {"id": str(row["id"])}}


@router.put("/milestones/{milestone_id}")
async def update_milestone(milestone_id: str, body: MilestoneUpdate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    from datetime import date as d
    mid = uuid.UUID(milestone_id)
    # Use exclude_unset so explicit nulls flow through (e.g. clearing
    # due_date). exclude_none would silently drop them.
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "owner_ids" in fields and fields["owner_ids"] is not None:
        fields["owner_ids"] = [uuid.UUID(x) for x in fields["owner_ids"]]
    if "due_date" in fields:
        # Drop silently if migration hasn't run yet
        has_col = await conn.fetchval(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema='bedrock' AND table_name='milestone' AND column_name='due_date'"
        )
        if has_col:
            fields["due_date"] = d.fromisoformat(fields["due_date"]) if fields["due_date"] else None
        else:
            del fields["due_date"]

    if not fields:
        return {"success": True, "data": {"message": "Nothing to update (migration pending)"}}

    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields))
    vals = [mid] + list(fields.values())
    await conn.execute(f"UPDATE bedrock.milestone SET {sets} WHERE id = $1 AND deleted_at IS NULL", *vals)
    return {"success": True, "data": {"message": "Milestone updated"}}


@router.delete("/milestones/{milestone_id}")
async def delete_milestone(milestone_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Soft-delete a milestone and cascade to tasks."""
    mid = uuid.UUID(milestone_id)
    email = user.get("email", "")
    async with conn.transaction():
        result = await conn.execute(
            "UPDATE bedrock.milestone SET deleted_at = now(), deleted_by = $2 "
            "WHERE id = $1 AND deleted_at IS NULL",
            mid, email,
        )
        if result == "UPDATE 0":
            raise HTTPException(status_code=404, detail="Milestone not found")
        await conn.execute(
            "UPDATE bedrock.project_task SET deleted_at = now(), deleted_by = $2 "
            "WHERE milestone_id = $1 AND deleted_at IS NULL",
            mid, email,
        )
    return {"success": True, "data": {"message": "Milestone moved to trash"}}


# ── Project Task CRUD ──


@router.post("/milestones/{milestone_id}/tasks")
async def create_project_task(milestone_id: str, body: ProjectTaskCreate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    mid = uuid.UUID(milestone_id)
    deadline = None
    if body.deadline:
        from datetime import date as d
        deadline = d.fromisoformat(body.deadline)

    start_date_val = None
    if body.start_date:
        from datetime import date as d
        start_date_val = d.fromisoformat(body.start_date)

    depends = [uuid.UUID(x) for x in body.depends_on] if body.depends_on else []
    owner_ids = [uuid.UUID(x) for x in body.owner_ids]

    row = await conn.fetchrow(
        """INSERT INTO bedrock.project_task (milestone_id, title, status, owner, owner_ids, deadline, start_date, description, updates, links, depends_on, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id""",
        mid, body.title, body.status, body.owner, owner_ids, deadline, start_date_val,
        body.description, body.updates, body.links, depends, body.sort_order,
    )
    return {"success": True, "data": {"id": str(row["id"])}}


@router.put("/project-tasks/{task_id}")
async def update_project_task(task_id: str, body: ProjectTaskUpdate, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    tid = uuid.UUID(task_id)
    fields = body.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    # Convert special fields
    if "deadline" in fields:
        if fields["deadline"]:
            from datetime import date as d
            fields["deadline"] = d.fromisoformat(fields["deadline"])
        else:
            fields["deadline"] = None
    if "start_date" in fields:
        if fields["start_date"]:
            from datetime import date as d
            fields["start_date"] = d.fromisoformat(fields["start_date"])
        else:
            fields["start_date"] = None
    if "depends_on" in fields:
        fields["depends_on"] = [uuid.UUID(x) for x in fields["depends_on"]]
    if "owner_ids" in fields:
        fields["owner_ids"] = [uuid.UUID(x) for x in fields["owner_ids"]]

    sets = ", ".join(f"{k} = ${i+2}" for i, k in enumerate(fields))
    vals = [tid] + list(fields.values())
    await conn.execute(f"UPDATE bedrock.project_task SET {sets} WHERE id = $1 AND deleted_at IS NULL", *vals)
    return {"success": True, "data": {"message": "Task updated"}}


@router.delete("/project-tasks/{task_id}")
async def delete_project_task(task_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Soft-delete a task."""
    tid = uuid.UUID(task_id)
    email = user.get("email", "")
    result = await conn.execute(
        "UPDATE bedrock.project_task SET deleted_at = now(), deleted_by = $2 "
        "WHERE id = $1 AND deleted_at IS NULL",
        tid, email,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="Task not found")
    return {"success": True, "data": {"message": "Task moved to trash"}}


# ── Salesforce Task ↔ Project Bridge ──


class SfTaskProjectLink(BaseModel):
    sf_task_id: str
    milestone_id: Optional[str] = None
    sort_order: int = 0


@router.post("/projects/{project_id}/sf-tasks")
async def link_sf_task_to_project(
    project_id: str, body: SfTaskProjectLink, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)
):
    """Link a Salesforce task to a project (and optionally a milestone)."""
    pid = uuid.UUID(project_id)
    validate_salesforce_id(body.sf_task_id, "sf_task_id")
    mid = uuid.UUID(body.milestone_id) if body.milestone_id else None
    try:
        row = await conn.fetchrow(
            "INSERT INTO bedrock.sf_task_project (sf_task_id, project_id, milestone_id, sort_order) "
            "VALUES ($1, $2, $3, $4) "
            "ON CONFLICT (sf_task_id) DO UPDATE SET project_id = $2, milestone_id = $3, sort_order = $4, updated_at = now() "
            "RETURNING id, sf_task_id, project_id, milestone_id, sort_order",
            body.sf_task_id, pid, mid, body.sort_order,
        )
        return {"success": True, "data": dict(row)}
    except Exception as e:
        logger.error(f"Error linking SF task to project: {e}")
        raise HTTPException(status_code=500, detail="Failed to link task to project")


@router.delete("/sf-task-project/{link_id}")
async def unlink_sf_task_from_project(link_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Remove a Salesforce task ↔ project link."""
    lid = uuid.UUID(link_id)
    result = await conn.execute("DELETE FROM bedrock.sf_task_project WHERE id = $1", lid)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Link not found")
    return {"success": True, "data": {"message": "Task unlinked from project"}}


@router.get("/projects/{project_id}/sf-tasks")
async def get_project_sf_tasks(project_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get all Salesforce task IDs linked to a project."""
    pid = uuid.UUID(project_id)
    rows = await conn.fetch(
        "SELECT id, sf_task_id, milestone_id, sort_order, created_at "
        "FROM bedrock.sf_task_project WHERE project_id = $1 ORDER BY sort_order, created_at",
        pid,
    )
    return {"success": True, "data": [dict(r) for r in rows]}


@router.get("/projects/by-opportunity/{opportunity_id}")
async def get_project_by_opportunity(opportunity_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Check if a project exists for the given opportunity."""
    validate_salesforce_id(opportunity_id, "opportunity_id")
    row = await conn.fetchrow(
        "SELECT id, name, description, opportunity_id FROM bedrock.project WHERE opportunity_id = $1 AND deleted_at IS NULL",
        opportunity_id,
    )
    if not row:
        return {"success": True, "data": None}
    return {"success": True, "data": dict(row)}


@router.get("/sf-task-project/by-task/{sf_task_id}")
async def get_sf_task_project_link(sf_task_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get the project link for a specific Salesforce task (if any)."""
    validate_salesforce_id(sf_task_id, "sf_task_id")
    row = await conn.fetchrow(
        "SELECT stp.id, stp.sf_task_id, stp.project_id, stp.milestone_id, p.name as project_name "
        "FROM bedrock.sf_task_project stp JOIN bedrock.project p ON p.id = stp.project_id AND p.deleted_at IS NULL "
        "WHERE stp.sf_task_id = $1",
        sf_task_id,
    )
    if not row:
        return {"success": True, "data": None}
    return {"success": True, "data": dict(row)}


# ── Project ↔ Account M2M ───────────────────────────────────────────────


class EntityLink(BaseModel):
    entity_id: str


@router.post("/projects/{project_id}/accounts")
async def link_account(project_id: str, body: EntityLink, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    """Link a CRM Account to a Project."""
    pid = uuid.UUID(project_id)
    validate_salesforce_id(body.entity_id, "account_id")
    row = await conn.fetchrow(
        "INSERT INTO bedrock.project_account (project_id, account_id) "
        "VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        pid, body.entity_id,
    )
    return {"success": True, "data": {"linked": row is not None}}


@router.delete("/projects/{project_id}/accounts/{account_id}")
async def unlink_account(project_id: str, account_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    validate_salesforce_id(account_id, "account_id")
    result = await conn.execute(
        "DELETE FROM bedrock.project_account WHERE project_id = $1 AND account_id = $2", pid, account_id,
    )
    if result == "DELETE 0":
        raise HTTPException(404, "Link not found")
    return {"success": True}


@router.get("/projects/{project_id}/accounts")
async def get_project_accounts(project_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    rows = await conn.fetch(
        "SELECT id, account_id, created_at FROM bedrock.project_account WHERE project_id = $1 ORDER BY created_at", pid,
    )
    return {"success": True, "data": [{"id": str(r["id"]), "account_id": r["account_id"]} for r in rows]}


@router.get("/accounts/{account_id}/projects")
async def get_account_projects(account_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get all Projects linked to an Account (reverse lookup)."""
    validate_salesforce_id(account_id, "account_id")
    rows = await conn.fetch(
        "SELECT p.id, p.name, p.description, p.owner_email, p.created_at "
        "FROM bedrock.project p "
        "JOIN bedrock.project_account pa ON pa.project_id = p.id "
        "WHERE pa.account_id = $1 AND p.deleted_at IS NULL "
        "ORDER BY p.name",
        account_id,
    )
    return {"success": True, "data": [dict(r) for r in rows]}


# ── Project ↔ Contact M2M ───────────────────────────────────────────────


@router.post("/projects/{project_id}/contacts")
async def link_contact(project_id: str, body: EntityLink, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    validate_salesforce_id(body.entity_id, "contact_id")
    row = await conn.fetchrow(
        "INSERT INTO bedrock.project_contact (project_id, contact_id) "
        "VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        pid, body.entity_id,
    )
    return {"success": True, "data": {"linked": row is not None}}


@router.delete("/projects/{project_id}/contacts/{contact_id}")
async def unlink_contact(project_id: str, contact_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    validate_salesforce_id(contact_id, "contact_id")
    result = await conn.execute(
        "DELETE FROM bedrock.project_contact WHERE project_id = $1 AND contact_id = $2", pid, contact_id,
    )
    if result == "DELETE 0":
        raise HTTPException(404, "Link not found")
    return {"success": True}


@router.get("/projects/{project_id}/contacts")
async def get_project_contacts(project_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    rows = await conn.fetch(
        "SELECT id, contact_id, created_at FROM bedrock.project_contact WHERE project_id = $1 ORDER BY created_at", pid,
    )
    return {"success": True, "data": [{"id": str(r["id"]), "contact_id": r["contact_id"]} for r in rows]}


# ── Project ↔ Award M2M ────────────────────────────────────────────────


@router.post("/projects/{project_id}/awards")
async def link_award(project_id: str, body: EntityLink, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    aid = uuid.UUID(body.entity_id)
    row = await conn.fetchrow(
        "INSERT INTO bedrock.project_award (project_id, award_id) "
        "VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
        pid, aid,
    )
    return {"success": True, "data": {"linked": row is not None}}


@router.delete("/projects/{project_id}/awards/{award_id}")
async def unlink_award(project_id: str, award_id: str, user=Depends(check_permission("edit_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    aid = uuid.UUID(award_id)
    result = await conn.execute(
        "DELETE FROM bedrock.project_award WHERE project_id = $1 AND award_id = $2", pid, aid,
    )
    if result == "DELETE 0":
        raise HTTPException(404, "Link not found")
    return {"success": True}


@router.get("/projects/{project_id}/awards")
async def get_project_awards(project_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    pid = uuid.UUID(project_id)
    rows = await conn.fetch(
        "SELECT pa.id, pa.award_id, a.opportunity_id, a.award_status, a.award_date, a.period_end_date "
        "FROM bedrock.project_award pa "
        "JOIN bedrock.award a ON a.id = pa.award_id "
        "WHERE pa.project_id = $1 ORDER BY pa.created_at",
        pid,
    )
    return {"success": True, "data": [dict(r) for r in rows]}


# ── Reverse lookup: Award → Projects ────────────────────────────────────

@router.get("/awards/{award_id}/projects")
async def get_award_projects(award_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get all Projects linked to an Award (reverse lookup via project_award)."""
    aid = uuid.UUID(award_id)
    rows = await conn.fetch(
        "SELECT p.id, p.name, p.description, p.owner_email, p.created_at "
        "FROM bedrock.project p "
        "JOIN bedrock.project_award pa ON pa.project_id = p.id "
        "WHERE pa.award_id = $1 AND p.deleted_at IS NULL "
        "ORDER BY p.name",
        aid,
    )
    return {"success": True, "data": [dict(r) for r in rows]}


# ── Reverse lookup: Contact → Projects ──────────────────────────────────

@router.get("/contacts/{contact_id}/projects")
async def get_contact_projects(contact_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get all Projects linked to a Contact (reverse lookup via project_contact)."""
    validate_salesforce_id(contact_id, "contact_id")
    rows = await conn.fetch(
        "SELECT p.id, p.name, p.description, p.owner_email, p.created_at "
        "FROM bedrock.project p "
        "JOIN bedrock.project_contact pc ON pc.project_id = p.id "
        "WHERE pc.contact_id = $1 AND p.deleted_at IS NULL "
        "ORDER BY p.name",
        contact_id,
    )
    return {"success": True, "data": [dict(r) for r in rows]}


# ── Reverse lookup: Opportunity → Projects (M2M + legacy column union) ──

@router.get("/opportunities/{opportunity_id}/projects")
async def get_opportunity_projects(opportunity_id: str, user=Depends(check_permission("view_projects")), conn=Depends(get_db)):
    """Get all Projects linked to an Opportunity.

    Unions two sources so callers don't have to know about the migration:
      1. project.opportunity_id  (legacy single-link column, still populated)
      2. project_opportunity     (M2M junction; canonical going forward)
    """
    validate_salesforce_id(opportunity_id, "opportunity_id")
    rows = await conn.fetch(
        "SELECT DISTINCT p.id, p.name, p.description, p.owner_email, p.created_at "
        "FROM bedrock.project p "
        "LEFT JOIN bedrock.project_opportunity po ON po.project_id = p.id "
        "WHERE p.deleted_at IS NULL "
        "  AND (p.opportunity_id = $1 OR po.opportunity_id = $1) "
        "ORDER BY p.name",
        opportunity_id,
    )
    return {"success": True, "data": [dict(r) for r in rows]}
