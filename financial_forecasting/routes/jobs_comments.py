"""Generic comments for the jobs pipeline.

Comments hang off a (parent_type, parent_id) pair (opportunity | prospect),
stored in bedrock.jobs_comment. Authors can edit/delete their own comments.

  GET    /api/jobs/jobs-comments?parent_type=&parent_id=   — list (oldest first)
  POST   /api/jobs/jobs-comments                            — create
  PATCH  /api/jobs/jobs-comments/{comment_id}               — author-only edit
  DELETE /api/jobs/jobs-comments/{comment_id}               — author-only delete

Modeled on routes/comments.py.
"""

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import require_auth
from db import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/jobs", tags=["jobs"])

VALID_PARENT_TYPES = {"opportunity", "prospect"}


class JobsCommentCreate(BaseModel):
    parent_type: str
    parent_id: str
    content: str


class JobsCommentUpdate(BaseModel):
    content: str


def _serialize(r) -> dict:
    return {
        "id": str(r["id"]),
        "parent_type": r["parent_type"],
        "parent_id": r["parent_id"],
        "author_id": str(r["author_id"]) if r["author_id"] else None,
        "author_email": r["author_email"],
        "content": r["content"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


_SELECT_SQL = """
    SELECT id, parent_type, parent_id, author_id, author_email, content,
           created_at, updated_at
    FROM bedrock.jobs_comment
"""


def _check_parent_type(parent_type: str) -> None:
    if parent_type not in VALID_PARENT_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid parent_type: {parent_type}")


def _user_email(user) -> str:
    if isinstance(user, dict):
        return (user.get("email") or "").strip()
    return (getattr(user, "email", "") or "").strip()


@router.get("/jobs-comments")
async def list_jobs_comments(
    parent_type: str = Query(...),
    parent_id: str = Query(...),
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    _check_parent_type(parent_type)
    rows = await conn.fetch(
        _SELECT_SQL
        + " WHERE parent_type = $1 AND parent_id = $2 "
        "ORDER BY created_at ASC",
        parent_type, parent_id,
    )
    return {"success": True, "data": [_serialize(r) for r in rows]}


@router.post("/jobs-comments")
async def create_jobs_comment(
    body: JobsCommentCreate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    _check_parent_type(body.parent_type)
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    author_email = _user_email(user)
    author_id = await conn.fetchval(
        "SELECT id FROM public.org_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
        author_email,
    ) if author_email else None

    row = await conn.fetchrow(
        """INSERT INTO bedrock.jobs_comment
               (parent_type, parent_id, author_id, author_email, content)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, parent_type, parent_id, author_id, author_email,
                     content, created_at, updated_at""",
        body.parent_type, body.parent_id, author_id, author_email, content,
    )
    return {"success": True, "data": _serialize(row)}


@router.patch("/jobs-comments/{comment_id}")
async def update_jobs_comment(
    comment_id: str,
    body: JobsCommentUpdate,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    cid = uuid.UUID(comment_id)
    existing = await conn.fetchrow(
        "SELECT author_email FROM bedrock.jobs_comment WHERE id = $1", cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Comment not found")

    if (existing["author_email"] or "").strip().lower() != _user_email(user).lower():
        raise HTTPException(status_code=403, detail="Only the author can edit this comment")

    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    row = await conn.fetchrow(
        "UPDATE bedrock.jobs_comment SET content = $1, updated_at = now() "
        "WHERE id = $2 "
        "RETURNING id, parent_type, parent_id, author_id, author_email, "
        "content, created_at, updated_at",
        content, cid,
    )
    return {"success": True, "data": _serialize(row)}


@router.delete("/jobs-comments/{comment_id}")
async def delete_jobs_comment(
    comment_id: str,
    user=Depends(require_auth),
    conn=Depends(get_db),
):
    cid = uuid.UUID(comment_id)
    existing = await conn.fetchrow(
        "SELECT author_email FROM bedrock.jobs_comment WHERE id = $1", cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Comment not found")

    if (existing["author_email"] or "").strip().lower() != _user_email(user).lower():
        raise HTTPException(status_code=403, detail="Only the author can delete this comment")

    await conn.execute("DELETE FROM bedrock.jobs_comment WHERE id = $1", cid)
    return {"success": True}
