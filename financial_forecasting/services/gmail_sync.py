"""Sync Gmail threads for a single staff member into bedrock.activity.

For each staff email:
  1. Build impersonated DWD credentials
  2. Read watermark → compute 'after:' date
  3. Search threads (skip internal @pursuit.org-only threads)
  4. Resolve participant emails → public.contacts + sf_contact_link
  5. Upsert bedrock.activity (ON CONFLICT source + source_thread_id)
  6. Update sync_watermark

Requires GOOGLE_SERVICE_ACCOUNT_JSON env var (see google_dwd.py).
"""

import logging
from datetime import datetime, timezone, timedelta
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from services.google_dwd import get_dwd_credentials, GMAIL_SCOPES

logger = logging.getLogger(__name__)

PURSUIT_DOMAIN = "@pursuit.org"


def _build_gmail_service(staff_email: str):
    creds = get_dwd_credentials(staff_email, GMAIL_SCOPES)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


async def _get_watermark(conn, staff_email: str) -> datetime | None:
    row = await conn.fetchrow(
        "SELECT last_synced_at FROM bedrock.sync_watermark "
        "WHERE staff_email = $1 AND source = 'gmail'",
        staff_email,
    )
    return row["last_synced_at"] if row else None


async def _set_watermark(conn, staff_email: str, count: int) -> None:
    await conn.execute(
        """
        INSERT INTO bedrock.sync_watermark (staff_email, source, last_synced_at, last_run_count)
        VALUES ($1, 'gmail', now(), $2)
        ON CONFLICT (staff_email, source) DO UPDATE
          SET last_synced_at = now(), last_run_count = $2
        """,
        staff_email,
        count,
    )


async def _resolve_emails_to_contacts(
    conn, emails: list[str]
) -> tuple[list[str], str | None]:
    """Return (contact_ids, sf_account_id) for a list of email addresses.

    contact_ids — list of sf_contact_id strings (used as foreign keys in activity)
    sf_account_id — first non-null SF account found for the resolved contacts
    """
    if not emails:
        return [], None

    external = [e.lower() for e in emails if PURSUIT_DOMAIN not in e.lower()]
    if not external:
        return [], None

    rows = await conn.fetch(
        """
        SELECT scl.sf_contact_id, scl.sf_account_id
        FROM public.contacts c
        JOIN bedrock.sf_contact_link scl ON scl.public_contact_id = c.contact_id
        WHERE lower(c.email) = ANY($1::text[])
          AND scl.public_contact_id IS NOT NULL
        """,
        external,
    )
    contact_ids = [r["sf_contact_id"] for r in rows]
    account_id = next((r["sf_account_id"] for r in rows if r["sf_account_id"]), None)
    return contact_ids, account_id


def _extract_thread_meta(service, thread_id: str) -> dict[str, Any] | None:
    """Pull minimal thread metadata via the Gmail API (one API call)."""
    try:
        thread = service.users().threads().get(
            userId="me",
            id=thread_id,
            format="metadata",
            metadataHeaders=["From", "To", "Cc", "Subject", "Date"],
        ).execute()
    except HttpError as e:
        logger.warning("gmail thread %s fetch error: %s", thread_id, e)
        return None

    messages = thread.get("messages", [])
    if not messages:
        return None

    first = messages[0]
    headers = {h["name"].lower(): h["value"] for h in first.get("payload", {}).get("headers", [])}

    # Collect all participant emails across all messages
    all_emails: set[str] = set()
    for msg in messages:
        for h in msg.get("payload", {}).get("headers", []):
            if h["name"].lower() in ("from", "to", "cc"):
                for part in h["value"].split(","):
                    part = part.strip()
                    if "@" in part:
                        # strip display name: "Name <email>" → "email"
                        email = part.split("<")[-1].strip("> ")
                        if email:
                            all_emails.add(email.lower())

    # Parse date from first message
    date_str = headers.get("date", "")
    try:
        from email.utils import parsedate_to_datetime
        date = parsedate_to_datetime(date_str).astimezone(timezone.utc)
    except Exception:
        date = datetime.now(timezone.utc)

    return {
        "thread_id": thread_id,
        "subject": headers.get("subject", "(no subject)"),
        "email_from": headers.get("from", ""),
        "all_emails": list(all_emails),
        "snippet": first.get("snippet", "")[:500],
        "date": date,
    }


async def sync_gmail_for_staff(
    conn,
    staff_email: str,
    days_back: int = 90,
) -> dict:
    """Sync Gmail threads for one staff member. Returns summary dict."""
    from services.google_dwd import is_dwd_configured

    if not is_dwd_configured():
        return {"skipped": True, "reason": "DWD not configured"}

    service = _build_gmail_service(staff_email)

    watermark = await _get_watermark(conn, staff_email)
    if watermark:
        since = watermark
    else:
        since = datetime.now(timezone.utc) - timedelta(days=days_back)

    # Fetch all threads since watermark; Python-side filtering below keeps only
    # threads with at least one external (non @pursuit.org) participant.
    # We don't filter in the Gmail query because -to:@pursuit.org would drop
    # mixed threads (external person + Pursuit colleague CC'd on the same email).
    date_str = since.strftime("%Y/%m/%d")
    query = f"after:{date_str}"

    upserted = 0
    errors = 0
    page_token = None

    while True:
        try:
            kwargs: dict[str, Any] = {"userId": "me", "q": query, "maxResults": 100}
            if page_token:
                kwargs["pageToken"] = page_token
            result = service.users().threads().list(**kwargs).execute()
        except HttpError as e:
            logger.error("gmail list threads error for %s: %s", staff_email, e)
            errors += 1
            break

        threads = result.get("threads", [])
        for t in threads:
            meta = _extract_thread_meta(service, t["id"])
            if not meta:
                continue

            # Skip purely internal threads
            all_external = [e for e in meta["all_emails"] if PURSUIT_DOMAIN not in e]
            if not all_external:
                continue

            contact_ids, account_id = await _resolve_emails_to_contacts(conn, all_external)

            try:
                await conn.execute(
                    """
                    INSERT INTO bedrock.activity (
                        type, subject, activity_date,
                        source, source_thread_id,
                        email_from, email_to, email_snippet,
                        contact_ids, account_id,
                        logged_by
                    ) VALUES (
                        'email', $1, $2,
                        'gmail-sync', $3,
                        $4, $5, $6,
                        $7, $8,
                        $9
                    )
                    ON CONFLICT (source, source_thread_id)
                    WHERE source_thread_id IS NOT NULL
                    DO UPDATE SET
                        subject        = EXCLUDED.subject,
                        email_snippet  = EXCLUDED.email_snippet,
                        contact_ids    = EXCLUDED.contact_ids,
                        account_id     = COALESCE(EXCLUDED.account_id, bedrock.activity.account_id),
                        synced_at      = now()
                    """,
                    meta["subject"],
                    meta["date"],
                    meta["thread_id"],
                    meta["email_from"],
                    all_external,
                    meta["snippet"],
                    contact_ids,
                    account_id,
                    staff_email,
                )
                upserted += 1
            except Exception as e:
                logger.warning("activity upsert failed for thread %s: %s", meta["thread_id"], e)
                errors += 1

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    await _set_watermark(conn, staff_email, upserted)
    logger.info("gmail sync %s: upserted=%d errors=%d", staff_email, upserted, errors)
    return {"staff_email": staff_email, "upserted": upserted, "errors": errors}
