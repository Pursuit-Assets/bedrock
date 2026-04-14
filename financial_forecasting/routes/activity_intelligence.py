"""Activity Intelligence routes.

Aggregates activity data from Slack, Fireflies, Gmail, Google Calendar,
and Google Drive into a unified timeline per account.  Also exposes
per-service health checks, account-activity endpoints, and the
Fireflies debug/cache helpers.
"""

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import require_auth
from dependencies import get_mcp_client
from mcp_client import UnifiedMCPClient
from models import ApiResponse

logger = logging.getLogger(__name__)

router = APIRouter(tags=["activity-intelligence"])

PBD_CALENDAR_ID = os.getenv(
    "PBD_CALENDAR_ID",
    "c_f06065f4e4551cee88f8d465a6a77a24c8333c66a0077770a3e60b8d26251e98@group.calendar.google.com",
)


# Slack health + account-activity live in routes/slack_routes.py

# ---------------------------------------------------------------------------
# Fireflies integration endpoints
# ---------------------------------------------------------------------------

@router.get("/api/fireflies/health")
async def fireflies_health_check(
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Check Fireflies service health."""
    if "fireflies" not in getattr(client, "_connected_services", set()):
        return ApiResponse(
            success=True,
            data={"status": "not_configured", "message": "Fireflies service not connected"},
        )
    try:
        ff_service = client.services.get("fireflies")
        if ff_service and ff_service.is_authenticated:
            info = await ff_service.get_service_info()
            return ApiResponse(
                success=True,
                data={"status": "healthy", "config": info.get("config", {})},
            )
        return ApiResponse(
            success=True,
            data={"status": "unhealthy", "message": "Not authenticated"},
        )
    except Exception as e:
        return ApiResponse(
            success=True,
            data={"status": "error", "message": str(e)},
        )


@router.get("/api/fireflies/account-meetings/{account_name}")
async def get_fireflies_account_meetings(
    account_name: str,
    limit: int = Query(20, le=100),
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Get Fireflies meeting transcripts mentioning an account."""
    ff_service = client.services.get("fireflies")
    if not ff_service:
        raise HTTPException(status_code=503, detail="Fireflies service not connected")
    try:
        meetings = await ff_service.get_account_meetings(account_name, limit=limit)
        return ApiResponse(
            success=True,
            data=meetings,
            meta={"count": len(meetings), "account": account_name},
        )
    except Exception as e:
        logger.error(f"Error fetching Fireflies meetings for {account_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/fireflies/recent-meetings")
async def get_recent_fireflies_meetings(
    limit: int = Query(10, le=100),
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Get recent Fireflies meetings to help identify test accounts.

    Ported from simple_server.py — uses the Fireflies MCP service when
    available; returns a stub otherwise.
    """
    ff_service = client.services.get("fireflies")
    if not ff_service:
        raise HTTPException(
            status_code=503,
            detail="Fireflies service not connected via MCP",
        )
    try:
        meetings = await ff_service.get_account_meetings("", limit=limit)

        # Extract unique organisations from attendee email domains
        domains: set = set()
        for meeting in meetings or []:
            for attendee in meeting.get("participants", meeting.get("meeting_attendees", [])) or []:
                email = (attendee.get("email") or "")
                if email and "@" in email:
                    domain = email.split("@")[1]
                    if domain not in {"gmail.com", "outlook.com", "yahoo.com", "hotmail.com"}:
                        domains.add(domain)

        return {
            "meetings": meetings,
            "total": len(meetings) if meetings else 0,
            "unique_domains": sorted(domains),
            "suggestion": "Look for account names in your Salesforce that match these domains or meeting titles",
        }
    except Exception as e:
        logger.error(f"Error fetching recent Fireflies meetings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/fireflies/refresh-cache")
async def refresh_fireflies_cache(
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Manually refresh the Fireflies cache.

    Ported from simple_server.py.  The MCP-based Fireflies service
    manages its own cache; this endpoint signals it to invalidate.
    """
    ff_service = client.services.get("fireflies")
    if not ff_service:
        return {
            "success": True,
            "message": "Fireflies service not connected — nothing to refresh.",
        }
    try:
        # If the service exposes a cache-clear method, call it
        if hasattr(ff_service, "clear_cache"):
            await ff_service.clear_cache()

        return {
            "success": True,
            "message": "Cache cleared. Next account request will fetch fresh data from Fireflies.",
            "note": "This may take 10-15 seconds for the first request after refresh.",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/fireflies/debug-account/{account_name}")
async def debug_account_matching(
    account_name: str,
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Debug endpoint — show all meetings and their match scores for an account.

    Ported from simple_server.py.  The original used raw Salesforce +
    direct Fireflies GraphQL calls.  This version delegates to the MCP
    services and reproduces the same scoring logic.
    """
    # --- Gather account context from Salesforce via MCP ---
    sf_service = client.services.get("salesforce")
    if not sf_service:
        raise HTTPException(status_code=503, detail="Salesforce service not available")

    ff_service = client.services.get("fireflies")
    if not ff_service:
        raise HTTPException(status_code=503, detail="Fireflies service not connected")

    try:
        # Query Salesforce for account + contacts
        from security import escape_soql_string

        escaped_account_name = escape_soql_string(account_name)
        account_query = (
            f"SELECT Id, Name, Website, "
            f"(SELECT Id, Name, Email FROM Contacts) "
            f"FROM Account "
            f"WHERE Name = '{escaped_account_name}' "
            f"LIMIT 1"
        )
        account_result = await sf_service.query(account_query)

        if account_result.get("totalSize", 0) == 0:
            return {"error": f"Account '{account_name}' not found in Salesforce"}

        account = account_result["records"][0]
        account_website = account.get("Website", "") or ""
        if account_website:
            account_website = (
                account_website
                .replace("http://", "")
                .replace("https://", "")
                .replace("www.", "")
                .split("/")[0]
            )

        contact_emails: List[str] = []
        contact_names: List[str] = []
        if account.get("Contacts"):
            for contact in account["Contacts"]["records"]:
                if contact.get("Email"):
                    contact_emails.append(contact["Email"].lower())
                if contact.get("Name"):
                    contact_names.append(contact["Name"].lower())

        # --- Fetch meetings from Fireflies ---
        meetings = await ff_service.get_account_meetings("", limit=50)

        # --- Score all meetings (reproduces simple_server scoring) ---
        all_meetings: List[Dict[str, Any]] = []
        account_name_lower = account_name.lower()
        account_terms = [
            term.lower()
            for term in account_name.split()
            if len(term) > 3
        ]

        for transcript in meetings or []:
            match_score = 0
            match_reasons: List[str] = []

            title = (transcript.get("title") or "").lower()

            # Title matching
            if account_name_lower in title:
                match_score += 10
                match_reasons.append("title_exact")
            elif any(term in title for term in account_terms):
                match_score += 5
                match_reasons.append("title_partial")

            # Attendee matching
            attendee_details: List[Dict[str, Any]] = []
            attendees = transcript.get("participants", transcript.get("meeting_attendees", [])) or []
            for attendee in attendees:
                email = (attendee.get("email") or "").lower()
                name = (attendee.get("displayName") or attendee.get("name") or "").lower()

                attendee_info: Dict[str, Any] = {"name": name, "email": email, "matches": []}

                if account_website and email.endswith(account_website):
                    match_score += 15
                    match_reasons.append(f"email_domain:{email}")
                    attendee_info["matches"].append("domain_match")

                # Smart match: extract company from email domain
                if email and "@" in email:
                    email_domain = email.split("@")[1]
                    company_from_email = email_domain.split(".")[0]

                    if company_from_email in account_name_lower or account_name_lower in company_from_email:
                        match_score += 18
                        match_reasons.append(f"smart_domain:{email}")
                        attendee_info["matches"].append(f"smart_domain_match({company_from_email})")
                    elif any(term == company_from_email for term in account_terms):
                        match_score += 18
                        match_reasons.append(f"smart_domain:{email}")
                        attendee_info["matches"].append(f"smart_domain_match({company_from_email})")

                if email in contact_emails:
                    match_score += 20
                    match_reasons.append(f"contact_email:{email}")
                    attendee_info["matches"].append("contact_match")

                if any(
                    contact_name in name or name in contact_name
                    for contact_name in contact_names
                    if contact_name
                ):
                    match_score += 10
                    match_reasons.append(f"contact_name:{name}")
                    attendee_info["matches"].append("name_match")

                attendee_details.append(attendee_info)

            all_meetings.append(
                {
                    "id": transcript.get("id"),
                    "title": transcript.get("title"),
                    "date": transcript.get("date"),
                    "match_score": match_score,
                    "match_reasons": match_reasons,
                    "attendees": attendee_details,
                    "would_show": match_score >= 15,
                }
            )

        all_meetings.sort(key=lambda x: x["match_score"], reverse=True)

        return {
            "account_name": account_name,
            "account_website": account_website,
            "contact_emails": contact_emails,
            "contact_names": contact_names,
            "account_terms": account_terms,
            "total_meetings_checked": len(all_meetings),
            "meetings_that_would_show": len([m for m in all_meetings if m["would_show"]]),
            "all_meetings": all_meetings[:20],
            "threshold": 15,
            "explanation": (
                "Only meetings with score >= 15 are shown. "
                "Domain match = 25pts, Contact email = 15pts, "
                "Title exact = 15pts, Content/Summary mention = 10pts each"
            ),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in debug-account for {account_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Gmail integration endpoints
# ---------------------------------------------------------------------------

@router.get("/api/gmail/health")
async def gmail_health_check(
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Check Gmail service health."""
    if "gmail" not in getattr(client, "_connected_services", set()):
        return ApiResponse(
            success=True,
            data={"status": "not_configured", "message": "Gmail service not connected"},
        )
    try:
        gmail_service = client.services.get("gmail")
        if gmail_service and gmail_service.is_authenticated:
            info = await gmail_service.get_service_info()
            return ApiResponse(
                success=True,
                data={"status": "healthy", "config": info.get("config", {})},
            )
        return ApiResponse(
            success=True,
            data={"status": "unhealthy", "message": "Not authenticated"},
        )
    except Exception as e:
        return ApiResponse(
            success=True,
            data={"status": "error", "message": str(e)},
        )


@router.get("/api/gmail/account-activity/{account_name}")
async def get_gmail_account_activity(
    account_name: str,
    limit: int = Query(20, le=100),
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Get Gmail emails related to an account."""
    gmail_service = client.services.get("gmail")
    if not gmail_service:
        raise HTTPException(status_code=503, detail="Gmail service not connected")
    try:
        activity = await gmail_service.get_account_activity(account_name, limit=limit)
        return ApiResponse(
            success=True,
            data=activity,
            meta={"count": len(activity), "account": account_name},
        )
    except Exception as e:
        logger.error(f"Error fetching Gmail activity for {account_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Google Calendar integration endpoints
# ---------------------------------------------------------------------------

@router.get("/api/calendar/health")
async def calendar_health_check(
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Check Google Calendar service health."""
    if "google_calendar" not in getattr(client, "_connected_services", set()):
        return ApiResponse(
            success=True,
            data={"status": "not_configured", "message": "Calendar service not connected"},
        )
    try:
        cal_service = client.services.get("google_calendar")
        if cal_service and cal_service.is_authenticated:
            info = await cal_service.get_service_info()
            return ApiResponse(
                success=True,
                data={"status": "healthy", "config": info.get("config", {})},
            )
        return ApiResponse(
            success=True,
            data={"status": "unhealthy", "message": "Not authenticated"},
        )
    except Exception as e:
        return ApiResponse(
            success=True,
            data={"status": "error", "message": str(e)},
        )


@router.get("/api/calendar/config")
async def get_calendar_config():
    """Return calendar configuration (PBD calendar ID and available calendars).

    Ported from simple_server.py.
    """
    return {
        "pbd_calendar_id": PBD_CALENDAR_ID,
        "available_calendars": [],  # Placeholder for future user calendar selection
    }


@router.get("/api/calendar/account-activity/{account_name}")
async def get_calendar_account_activity(
    account_name: str,
    limit: int = Query(20, le=100),
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Get Google Calendar events related to an account."""
    cal_service = client.services.get("google_calendar")
    if not cal_service:
        raise HTTPException(status_code=503, detail="Calendar service not connected")
    try:
        activity = await cal_service.get_account_activity(account_name, limit=limit)
        return ApiResponse(
            success=True,
            data=activity,
            meta={"count": len(activity), "account": account_name},
        )
    except Exception as e:
        logger.error(f"Error fetching Calendar activity for {account_name}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Google Drive integration endpoints
# ---------------------------------------------------------------------------

@router.get("/api/drive/health")
async def drive_health_check(
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Check Drive integration status.

    Ported from simple_server.py.  Uses the Google Drive MCP service to
    determine connectivity rather than raw token inspection.
    """
    if "google_drive" not in getattr(client, "_connected_services", set()):
        return {
            "configured": False,
            "has_refresh_token": False,
            "user_email": user.get("email") if isinstance(user, dict) else None,
        }
    drive_service = client.services.get("google_drive")
    return {
        "configured": bool(drive_service and drive_service.is_authenticated),
        "has_refresh_token": bool(drive_service and drive_service.is_authenticated),
        "user_email": user.get("email") if isinstance(user, dict) else None,
    }


@router.get("/api/drive/account-activity/{account_name}")
async def get_account_drive_activity(
    account_name: str,
    limit: int = Query(20, le=100),
    opportunity_name: Optional[str] = None,
    user=Depends(require_auth),
    client: UnifiedMCPClient = Depends(get_mcp_client),
):
    """Search Google Drive for files related to an account.

    Ported from simple_server.py.  Uses the Google Drive MCP service
    instead of raw googleapiclient calls.
    """
    drive_service = client.services.get("google_drive")
    if not drive_service:
        return {
            "account_name": account_name,
            "files": [],
            "total": 0,
            "error": "Google Drive service not connected via MCP.",
        }

    try:
        # Build search query — same strategy as simple_server: name contains
        query = f"name contains '{account_name}'"
        if opportunity_name and opportunity_name != account_name:
            query += f" or name contains '{opportunity_name}'"

        result = await drive_service.list_files(query=query, page_size=limit)
        raw_files = result.get("files", []) if isinstance(result, dict) else []

        # Format and score (mirrors simple_server scoring)
        account_name_lower = account_name.lower()
        opp_name_lower = (opportunity_name or "").lower()
        account_terms = [
            t
            for t in account_name.split()
            if len(t) > 3
            and t.lower()
            not in {
                "the", "inc", "llc", "corp", "foundation",
                "fund", "group", "household",
            }
        ]

        formatted_files: List[Dict[str, Any]] = []
        for f in raw_files:
            mime = f.get("mimeType", "")
            file_type = "file"
            if "spreadsheet" in mime:
                file_type = "spreadsheet"
            elif "document" in mime:
                file_type = "document"
            elif "presentation" in mime:
                file_type = "presentation"
            elif "folder" in mime:
                file_type = "folder"
            elif "pdf" in mime:
                file_type = "pdf"
            elif "image" in mime:
                file_type = "image"

            owners = f.get("owners", [])
            last_modifier = f.get("lastModifyingUser", {})
            name_lower = f.get("name", "").lower()

            # Relevance scoring
            score = 0
            if account_name_lower in name_lower:
                score += 20
            elif any(t.lower() in name_lower for t in account_terms):
                score += 10
            if opp_name_lower and opp_name_lower in name_lower:
                score += 15
            if f.get("shared"):
                score += 3

            formatted_files.append(
                {
                    "id": f.get("id"),
                    "name": f.get("name"),
                    "mimeType": mime,
                    "fileType": file_type,
                    "modifiedTime": f.get("modifiedTime"),
                    "createdTime": f.get("createdTime"),
                    "webViewLink": f.get("webViewLink"),
                    "iconLink": f.get("iconLink"),
                    "ownerName": owners[0].get("displayName") if owners else None,
                    "lastModifiedBy": (last_modifier or {}).get("displayName"),
                    "size": f.get("size"),
                    "shared": f.get("shared", False),
                    "relevanceScore": score,
                }
            )

        # Sort by relevance then recency
        formatted_files.sort(
            key=lambda x: (x["relevanceScore"], x.get("modifiedTime") or ""),
            reverse=True,
        )
        formatted_files = formatted_files[:limit]

        return {
            "account_name": account_name,
            "files": formatted_files,
            "total": len(formatted_files),
        }

    except Exception as e:
        logger.error(f"Drive activity error for {account_name}: {e}")
        error_str = str(e).lower()
        if "invalid_grant" in error_str or "token" in error_str:
            return {
                "account_name": account_name,
                "files": [],
                "total": 0,
                "error": "Drive token expired. Please re-login.",
                "needs_reauth": True,
            }
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Activity Intelligence — unified aggregator (REMOVED — see audit notes)
# ---------------------------------------------------------------------------
# Historical note: this file previously exposed GET /api/activity-intelligence/
# {account_name} — a fan-out aggregator over Slack/Fireflies/Gmail/Calendar/
# Drive that returned a flat activity list. The corresponding frontend panel
# (ActivityIntelligencePanel) was built against an older spec living in
# simple_server.py.deprecated that produced AI-summarized output with
# relevance scores. The shapes never matched; the panel always rendered
# "No activity data found" in production. Additionally, the fan-out used
# singleton service-account tokens for Gmail/Calendar/Drive, creating a
# cross-user data-leakage risk if the frontend had worked.
#
# Endpoint + helpers removed 2026-04-14 as part of Bug 9 cleanup. See the
# audit report in the PR description for full context. If we revisit this
# feature, rebuild it behind per-user OAuth with a real LLM orchestration
# layer — do not restore this code from git history.
