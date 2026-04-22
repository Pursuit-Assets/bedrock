"""GCS upload helper for Platform Intake file attachments.

Mirrors the convention the old Pursuit platform uses for attendance photos
(bucket: builder-attendance-photos, project: pursuit-ops). We namespace
Bedrock uploads under a separate prefix so the two products never collide
on the same object path.

Path convention:
    {GCS_INTAKE_PREFIX}/{user_folder}/{YYYYMMDDTHHMMSSZ}_{safe_filename}

Where `user_folder` is:
    * `public.org_users.id` (UUID) when the reporter has been linked
      through the shared identity table, OR
    * an email-slug fallback (`foo_at_bar_com`) when no org_users row
      exists yet. The learning-platform team backfills org_users rows
      over time, so older uploads stay discoverable either way.

The caller is responsible for supplying `reporter_email` — we never look
at cookies or auth state in here, that's the route's job.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Optional

import asyncpg
from google.cloud import storage
from google.cloud.exceptions import GoogleCloudError

logger = logging.getLogger(__name__)

DEFAULT_BUCKET = "builder-attendance-photos"
DEFAULT_PREFIX = "platform-intake"
DEFAULT_PROJECT = "pursuit-ops"

# Belt-and-braces limits. FastAPI's UploadFile streams, so the route also
# enforces size by rejecting payloads larger than MAX_UPLOAD_BYTES. We keep
# the whitelist narrow on purpose — anything outside this list is almost
# certainly not the kind of evidence the intake form is after.
ALLOWED_MIME_TYPES = {
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "video/quicktime",  # .mov
    "video/mp4",        # .mp4
    "application/pdf",
}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB

_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")


class GCSUploadError(RuntimeError):
    """Raised when the intake file upload cannot be completed."""


def _sanitize_filename(filename: str) -> str:
    """Strip path components and collapse unsafe characters.

    Keeps the extension readable (e.g. `my photo.png` → `my_photo.png`).
    """
    base = PurePosixPath(filename).name or "upload"
    safe = _UNSAFE_FILENAME.sub("_", base).strip("._") or "upload"
    # Cap length so we don't produce 4kb object keys when someone pastes
    # a screenshot URL as a filename.
    return safe[:120]


def _email_slug(email: str) -> str:
    """Derive a filesystem-safe folder name from an email address."""
    cleaned = _UNSAFE_FILENAME.sub("_", email.strip().lower()).strip("._")
    return cleaned or "anonymous"


async def resolve_user_folder(
    db: asyncpg.Connection, *, email: str
) -> tuple[str, Optional[str]]:
    """Return `(folder_name, org_user_id)` for the reporter.

    Prefers the canonical `public.org_users.id` UUID (stable across systems,
    future-proof for when Pebble backfills `bedrock.app_user.org_user_id`).
    Falls back to an email slug when no org_users row exists yet — that
    way local-dev databases and brand-new users still get a predictable
    folder.
    """
    try:
        row = await db.fetchrow(
            "SELECT id FROM public.org_users WHERE lower(email) = lower($1) "
            "LIMIT 1",
            email,
        )
    except Exception as exc:  # schema missing in local dev
        logger.warning(
            "org_users lookup failed (falling back to email slug): %s", exc
        )
        return _email_slug(email), None

    if row and row["id"]:
        return str(row["id"]), str(row["id"])
    return _email_slug(email), None


def _build_object_name(folder: str, filename: str) -> str:
    prefix = os.getenv("GCS_INTAKE_PREFIX", DEFAULT_PREFIX).strip("/")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_name = _sanitize_filename(filename)
    return f"{prefix}/{folder}/{timestamp}_{safe_name}"


def upload_intake_file(
    *,
    folder: str,
    filename: str,
    content: bytes,
    content_type: str,
) -> str:
    """Upload `content` to GCS and return a `gs://bucket/path` URI.

    Raises `GCSUploadError` on any failure — the route handler maps this
    to a 500 with a helpful message rather than leaking Google SDK
    internals to the client.
    """
    if len(content) == 0:
        raise GCSUploadError("Attached file is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise GCSUploadError(
            f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit."
        )

    mime = (content_type or "application/octet-stream").lower()
    if mime not in ALLOWED_MIME_TYPES:
        raise GCSUploadError(
            f"Unsupported file type: {mime}. Allowed: "
            f"{', '.join(sorted(ALLOWED_MIME_TYPES))}"
        )

    bucket_name = os.getenv("GCS_INTAKE_BUCKET", DEFAULT_BUCKET)
    project = os.getenv("GCS_PROJECT", DEFAULT_PROJECT)

    try:
        client = storage.Client(project=project)
        bucket = client.bucket(bucket_name)
        object_name = _build_object_name(folder, filename)
        blob = bucket.blob(object_name)
        blob.upload_from_string(content, content_type=mime)
    except GoogleCloudError as exc:
        logger.exception("GCS upload failed")
        raise GCSUploadError(f"Google Cloud Storage upload failed: {exc}") from exc
    except Exception as exc:  # credentials missing, network, etc.
        logger.exception("GCS upload failed (generic)")
        raise GCSUploadError(f"Upload failed: {exc}") from exc

    return f"gs://{bucket_name}/{object_name}"
