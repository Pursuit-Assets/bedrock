"""Bedrock intake API — bug/feature submission endpoint.

Writes rows into `public.pd_tickets`, the canonical Pursuit Product
Development ticket table. The older `public.platform_intake` capture
table is deprecated; Pursuit now uses `pd_tickets` directly for every
product surface, Bedrock (Revenue Hub) included.

Submissions from this app are tagged with:
    * `source = 'bedrock'` — partitions Bedrock rows from the existing
      `source='app'` traffic coming from the Pursuit learning platform.
    * `surface_id = BEDROCK_SURFACE_ID` — points at the single
      `pd_surface_registry` row registered for the Bedrock CRM
      (product_area: 'Revenue Hub'). The fine-grained component the
      reporter picked in the form (priorities / accounts / tasks / ...)
      is preserved as a `**Component:** ...` header at the top of the
      ticket `description`, which keeps the field visible on the ticket
      without polluting the shared surface registry with 10 bedrock-
      specific rows.

Key allocation:
    `pd_tickets.key_number` has no sequence or trigger — the Pursuit
    app allocates it client-side. We do the same, but wrap the MAX+1
    read and the INSERT in a single transaction protected by a
    Postgres advisory lock (`pg_advisory_xact_lock`) so concurrent
    submissions can't produce duplicate keys. Under real traffic the
    lock is effectively uncontended, so the cost is negligible.

Auth: any logged-in user (no permission check). Reporter email comes
from the session cookie (`user["email"]`) — the form's reporter_name
field is a display-only convenience that can be overridden
client-side but is never trusted server-side.
"""

import logging
import os
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from auth import require_auth
from db import get_db
from services.gcs_intake import (
    GCSUploadError,
    MAX_UPLOAD_BYTES,
    resolve_user_folder,
    upload_intake_file,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/platform-intake", tags=["platform-intake"])

ALLOWED_TYPES = {"bug", "feature"}
ALLOWED_PRIORITIES = {"urgent", "high", "medium", "low"}

# Bedrock-specific component taxonomy. Intentionally narrower than the
# Pursuit platform's list — we don't ask Bedrock users "is this a Platform
# Intake bug?" because it always is, from their perspective.
ALLOWED_COMPONENTS = {
    "dashboard",
    "cash_flow",
    "accounts",
    "contacts",
    "pipeline",
    "awards",
    "projects",
    "cleanup",
    "settings",
    "other",
}

# Form `type` values → the canonical pd_tickets.type vocabulary already
# in use ("bug" / "feature_request"). Kept as an explicit map so a future
# form option (e.g. "question", "incident") has an obvious place to land
# without silently widening what we write to the shared table.
TYPE_TO_PD_TICKET_TYPE = {
    "bug": "bug",
    "feature": "feature_request",
}

# Pre-registered row in public.pd_surface_registry for Bedrock CRM.
# Overridable via env for non-prod databases that seeded a different UUID.
# Keep in sync with db/migrations/2026-04-22-bedrock-surface-registry.sql.
BEDROCK_SURFACE_ID = os.environ.get(
    "BEDROCK_SURFACE_ID", "95226ef9-a8cb-46ac-b1bb-8c5a45957092"
)

# Presentational labels so the ticket `description` preamble reads like
# something a human wrote, not the internal dropdown value.
COMPONENT_LABELS = {
    "priorities": "Priorities",
    "details": "Details (tables)",
    "progress": "Progress",
    "opportunities": "Opportunities",
    "accounts": "Accounts",
    "contacts": "Contacts",
    "leads": "Leads",
    "tasks": "Tasks",
    "salesforce_sync": "Salesforce sync",
    "other": "Other",
}

# Stable advisory-lock key used to serialize concurrent key_number
# allocations. The integer is arbitrary but must be constant across
# callers — we use a hash of a mnemonic string so collisions with
# unrelated advisory locks in the database are vanishingly unlikely.
_KEY_ALLOC_ADVISORY_LOCK_SQL = (
    "SELECT pg_advisory_xact_lock(hashtext('pd_tickets_key_allocator'))"
)


def _clean(value: Optional[str], max_len: int) -> str:
    return (value or "").strip()[:max_len]


@router.post("")
async def submit_platform_intake(
    type: str = Form(..., description="bug | feature"),
    title: str = Form(..., min_length=1),
    description: str = Form(..., min_length=1),
    platform_component: str = Form(...),
    recommended_prioritization: str = Form(...),
    prioritization_justification: str = Form(""),
    reporter_name: str = Form(""),
    attachment: Optional[UploadFile] = File(None),
    user=Depends(require_auth),
    db=Depends(get_db),
):
    """Submit a Bedrock bug or feature request.

    Accepts `multipart/form-data` so the form can carry an optional file
    attachment (screenshot, screen recording, PDF, etc.). On success the
    response is `{id, key, upload_url, source}` — `key` is the
    human-readable identifier (e.g. `TKT-49`) the ticket will surface
    as in any UI that consumes `pd_tickets`.
    """
    # --- Validate the basic form fields -------------------------------
    type_norm = _clean(type, 16).lower()
    if type_norm not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"type must be one of: {sorted(ALLOWED_TYPES)}",
        )
    pd_type = TYPE_TO_PD_TICKET_TYPE[type_norm]

    priority_norm = _clean(recommended_prioritization, 16).lower()
    if priority_norm not in ALLOWED_PRIORITIES:
        raise HTTPException(
            status_code=400,
            detail=f"recommended_prioritization must be one of: "
                   f"{sorted(ALLOWED_PRIORITIES)}",
        )

    component_norm = _clean(platform_component, 64).lower()
    if component_norm not in ALLOWED_COMPONENTS:
        raise HTTPException(
            status_code=400,
            detail=f"platform_component must be one of: "
                   f"{sorted(ALLOWED_COMPONENTS)}",
        )

    title_clean = _clean(title, 200)
    description_clean = _clean(description, 5000)
    justification_clean = _clean(prioritization_justification, 2000)
    if not title_clean or not description_clean:
        raise HTTPException(
            status_code=400,
            detail="title and description are required.",
        )

    # --- Resolve the reporter identity from the auth cookie ----------
    reporter_email = (user.get("email") or "").strip().lower()
    if not reporter_email:
        # Extremely unlikely given require_auth, but guard anyway so we
        # never write an empty reporter_email to the shared table.
        raise HTTPException(
            status_code=401, detail="Session has no email claim."
        )
    reporter_display = _clean(reporter_name, 200) or user.get("name") or reporter_email

    # --- Optional attachment: upload to GCS first --------------------
    upload_url: Optional[str] = None
    if attachment is not None and attachment.filename:
        content = await attachment.read()
        if len(content) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"Attachment exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} "
                    f"MB limit."
                ),
            )
        folder, org_user_id = await resolve_user_folder(db, email=reporter_email)
        try:
            upload_url = upload_intake_file(
                folder=folder,
                filename=attachment.filename,
                content=content,
                content_type=attachment.content_type or "application/octet-stream",
            )
        except GCSUploadError as exc:
            # Surface the user-friendly message; the underlying error is
            # already logged inside upload_intake_file.
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        logger.info(
            "Bedrock intake upload stored: %s (org_user_id=%s)",
            upload_url,
            org_user_id,
        )

    # --- Build the ticket body --------------------------------------
    # Preserve the fine-grained component the reporter picked as a
    # visible header at the top of the ticket description. Downstream
    # triage is reading pd_tickets.description in Slack/Linear views,
    # not pd_surface_registry, so this is where it needs to show up.
    component_label = COMPONENT_LABELS.get(component_norm, component_norm)
    description_with_preamble = (
        f"**Component:** {component_label}\n"
        f"**Priority:** {priority_norm} — {justification_clean or '(no justification provided)'}\n"
        f"**Reporter:** {reporter_display} <{reporter_email}>\n"
        f"\n"
        f"{description_clean}"
    )

    # --- Persist the ticket -----------------------------------------
    # pd_tickets has no sequence/trigger for key_number, so we allocate
    # MAX+1 ourselves. The advisory lock (released at transaction end)
    # serializes concurrent allocations without holding a row lock on
    # the table, so triage queries still run freely during an insert.
    try:
        async with db.transaction():
            await db.execute(_KEY_ALLOC_ADVISORY_LOCK_SQL)
            next_key_number = await db.fetchval(
                "SELECT COALESCE(MAX(key_number), 0) + 1 FROM public.pd_tickets"
            )
            ticket_key = f"TKT-{next_key_number}"

            row = await db.fetchrow(
                """
                INSERT INTO public.pd_tickets
                    (key, key_number, type, title, description,
                     reporter_name, reporter_email,
                     priority, priority_justification,
                     upload_url, surface_id, source)
                VALUES ($1, $2, $3, $4, $5,
                        $6, $7,
                        $8, $9,
                        $10, $11::uuid, 'bedrock')
                RETURNING id, key, key_number, created_at
                """,
                ticket_key,
                next_key_number,
                pd_type,
                title_clean,
                description_with_preamble,
                reporter_display,
                reporter_email,
                priority_norm,
                justification_clean or None,
                upload_url,
                BEDROCK_SURFACE_ID,
            )
    except Exception as exc:
        logger.exception("Failed to insert pd_tickets row from bedrock intake")
        raise HTTPException(
            status_code=500,
            detail="Could not save your submission. Please try again.",
        ) from exc

    logger.info(
        "Bedrock intake submitted: key=%s id=%s type=%s component=%s "
        "priority=%s reporter=%s has_upload=%s",
        row["key"], row["id"], pd_type, component_norm, priority_norm,
        reporter_email, upload_url is not None,
    )
    return {
        "success": True,
        "id": str(row["id"]),
        "key": row["key"],
        "key_number": row["key_number"],
        "source": "bedrock",
        "upload_url": upload_url,
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }
