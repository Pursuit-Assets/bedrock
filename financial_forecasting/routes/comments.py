"""Entity-agnostic comments on top of public.org_comments (the same
table factory writes to). The first entity_type Bedrock cares about is
'project_task', but the routes are generic so future entities (e.g.
opportunities, awards) can hook in without a new table.

Read: signed-in users with `view_projects`.
Mutate: `edit_projects`; authors can edit/delete their own comments.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from db import get_db
from routes.permissions import check_permission
from services.notifications import (
    TYPE_COMMENT_MENTION,
    enqueue_notification,
    resolve_mentions,
)

router = APIRouter(prefix="/api/comments", tags=["comments"])

# Entity types we currently accept. Anything else is rejected at the
# route layer — keep this list explicit so we don't accidentally expose
# unrelated tables.
ALLOWED_ENTITY_TYPES = {"project_task"}


class CommentCreate(BaseModel):
    content: str


class CommentUpdate(BaseModel):
    content: str


_AUTHOR_JOIN_SQL = """
    SELECT c.id, c.entity_type, c.entity_id, c.author_id, c.content,
           c.created_at, c.updated_at,
           u.email AS author_email, u.display_name AS author_display_name
    FROM public.org_comments c
    LEFT JOIN public.org_users u ON u.id = c.author_id
"""


def _serialize_comment(r) -> dict:
    return {
        "id": str(r["id"]),
        "entity_type": r["entity_type"],
        "entity_id": str(r["entity_id"]),
        "author_id": str(r["author_id"]) if r["author_id"] else None,
        "author": (
            {
                "id": str(r["author_id"]),
                "email": r["author_email"],
                "display_name": r["author_display_name"],
            }
            if r["author_id"]
            else None
        ),
        "content": r["content"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


def _check_entity_type(entity_type: str) -> None:
    if entity_type not in ALLOWED_ENTITY_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported entity_type: {entity_type}")


async def _resolve_author_id(conn, email: str):
    if not email:
        return None
    return await conn.fetchval(
        "SELECT id FROM public.org_users WHERE email = $1", email
    )


@router.get("/{entity_type}/{entity_id}")
async def list_comments(
    entity_type: str,
    entity_id: str,
    user=Depends(check_permission("view_projects")),
    conn=Depends(get_db),
):
    _check_entity_type(entity_type)
    eid = uuid.UUID(entity_id)
    rows = await conn.fetch(
        _AUTHOR_JOIN_SQL + " WHERE c.entity_type = $1 AND c.entity_id = $2::uuid "
        "ORDER BY c.created_at ASC",
        entity_type, eid,
    )
    return {"success": True, "data": [_serialize_comment(r) for r in rows]}


@router.post("/{entity_type}/{entity_id}")
async def create_comment(
    entity_type: str,
    entity_id: str,
    body: CommentCreate,
    user=Depends(check_permission("edit_projects")),
    conn=Depends(get_db),
):
    _check_entity_type(entity_type)
    eid = uuid.UUID(entity_id)
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    author_id = await _resolve_author_id(conn, user.get("email", ""))
    new_id = await conn.fetchval(
        """
        INSERT INTO public.org_comments (entity_type, entity_id, author_id, content)
        VALUES ($1, $2::uuid, $3, $4) RETURNING id
        """,
        entity_type, eid, author_id, content,
    )

    # Fan-out @-mention notifications. Parser is conservative: only
    # tokens that resolve to an org_users row trigger a notification,
    # so a stray `@everyone` or `@here` is silently ignored. Self-
    # mentions are allowed (useful as a note-to-self and necessary for
    # solo testing of the pipeline).
    actor_email = (user.get("email") or "").strip()
    mentioned = await resolve_mentions(conn, content)
    if mentioned:
        snippet = content if len(content) <= 280 else content[:277] + "…"
        ctx = await _resolve_comment_context(conn, entity_type, eid)
        actor_display = await _lookup_display_name(conn, actor_email)
        for m in mentioned:
            email = (m.get("email") or "").strip()
            if not email:
                continue
            await enqueue_notification(
                conn,
                recipient_email=email,
                type=TYPE_COMMENT_MENTION,
                payload={
                    "title": "You were mentioned in a comment",
                    "subtitle": snippet,
                    "comment_body": content,
                    "comment_id": str(new_id),
                    "entity_type": entity_type,
                    "entity_id": str(eid),
                    "project_id": ctx.get("project_id"),
                    "project_name": ctx.get("project_name"),
                    "task_title": ctx.get("task_title"),
                    "workstream_name": ctx.get("workstream_name"),
                    "milestone_title": ctx.get("milestone_title"),
                    "actor_display_name": actor_display,
                    "target_url": ctx.get("target_url"),
                },
                actor_email=actor_email or None,
            )

    row = await conn.fetchrow(_AUTHOR_JOIN_SQL + " WHERE c.id = $1", new_id)
    return {"success": True, "data": _serialize_comment(row)}


async def _lookup_display_name(conn, email):
    """email -> display_name on org_users (fallback to the email itself)."""
    if not email:
        return None
    row = await conn.fetchval(
        "SELECT display_name FROM public.org_users WHERE LOWER(email) = LOWER($1) LIMIT 1",
        email,
    )
    return row or email


async def _resolve_comment_context(conn, entity_type, entity_id):
    """Look up the project / workstream / milestone / task hierarchy for
    a comment so the notification message can read like:

        Jac mentioned you in a comment:
        Project: …
        Task: …
        Comment: …

    Returns a dict with project_id, project_name, task_title,
    workstream_name, milestone_title, target_url. Falls back to empty
    keys (None) for unknown entity types."""
    out = {
        "project_id": None,
        "project_name": None,
        "task_title": None,
        "workstream_name": None,
        "milestone_title": None,
        "target_url": None,
    }
    if entity_type == "project_task":
        row = await conn.fetchrow(
            """SELECT t.title AS task_title,
                      m.title AS milestone_title,
                      w.name  AS workstream_name,
                      p.id    AS project_id,
                      p.name  AS project_name
               FROM bedrock.project_task t
               JOIN bedrock.milestone m  ON m.id = t.milestone_id
               JOIN bedrock.workstream w ON w.id = m.workstream_id
               JOIN bedrock.project   p  ON p.id = w.project_id
               WHERE t.id = $1""",
            entity_id,
        )
        if row:
            pid = str(row["project_id"])
            out.update({
                "project_id": pid,
                "project_name": row["project_name"],
                "task_title": row["task_title"],
                "workstream_name": row["workstream_name"],
                "milestone_title": row["milestone_title"],
                "target_url": f"/projects/{pid}?task={entity_id}",
            })
    return out


@router.put("/{comment_id}")
async def update_comment(
    comment_id: str,
    body: CommentUpdate,
    user=Depends(check_permission("edit_projects")),
    conn=Depends(get_db),
):
    cid = uuid.UUID(comment_id)
    existing = await conn.fetchrow(
        "SELECT author_id FROM public.org_comments WHERE id = $1", cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Comment not found")

    author_id = await _resolve_author_id(conn, user.get("email", ""))
    if existing["author_id"] != author_id:
        raise HTTPException(status_code=403, detail="Only the author can edit this comment")

    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content is required")

    await conn.execute(
        "UPDATE public.org_comments SET content = $1, updated_at = now() WHERE id = $2",
        content, cid,
    )
    row = await conn.fetchrow(_AUTHOR_JOIN_SQL + " WHERE c.id = $1", cid)
    return {"success": True, "data": _serialize_comment(row)}


@router.delete("/{comment_id}")
async def delete_comment(
    comment_id: str,
    user=Depends(check_permission("edit_projects")),
    conn=Depends(get_db),
):
    cid = uuid.UUID(comment_id)
    existing = await conn.fetchrow(
        "SELECT author_id FROM public.org_comments WHERE id = $1", cid,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Comment not found")

    author_id = await _resolve_author_id(conn, user.get("email", ""))
    if existing["author_id"] != author_id:
        raise HTTPException(status_code=403, detail="Only the author can delete this comment")

    await conn.execute("DELETE FROM public.org_comments WHERE id = $1", cid)
    return {"success": True}
