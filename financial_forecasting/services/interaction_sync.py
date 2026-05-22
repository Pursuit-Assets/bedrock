"""Orchestrator: run Gmail + Calendar sync for all enabled sync_staff members."""

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def run_interaction_sync(conn, days_back: int = 90) -> dict[str, Any]:
    """Sync Gmail and Calendar for all enabled staff. Returns per-staff summary."""
    from services.gmail_sync import sync_gmail_for_staff
    from services.calendar_sync import sync_calendar_for_staff
    from services.google_dwd import is_dwd_configured

    if not is_dwd_configured():
        logger.warning("interaction sync skipped — GOOGLE_SERVICE_ACCOUNT_JSON not set")
        return {"skipped": True, "reason": "DWD not configured"}

    staff_rows = await conn.fetch(
        "SELECT email FROM bedrock.sync_staff WHERE enabled = true ORDER BY email"
    )
    if not staff_rows:
        return {"skipped": True, "reason": "no enabled staff in sync_staff table"}

    results = []
    for row in staff_rows:
        email = row["email"]
        try:
            gmail_result = await sync_gmail_for_staff(conn, email, days_back=days_back)
        except Exception as e:
            logger.error("gmail sync failed for %s: %s", email, e)
            gmail_result = {"staff_email": email, "error": str(e)}

        try:
            cal_result = await sync_calendar_for_staff(conn, email, days_back=days_back)
        except Exception as e:
            logger.error("calendar sync failed for %s: %s", email, e)
            cal_result = {"staff_email": email, "error": str(e)}

        results.append({"email": email, "gmail": gmail_result, "calendar": cal_result})

    total_gmail = sum(r["gmail"].get("upserted", 0) for r in results)
    total_cal = sum(r["calendar"].get("upserted", 0) for r in results)
    logger.info(
        "interaction sync complete: %d staff, %d gmail, %d calendar",
        len(results),
        total_gmail,
        total_cal,
    )
    return {
        "staff_count": len(results),
        "gmail_upserted": total_gmail,
        "calendar_upserted": total_cal,
        "by_staff": results,
    }
