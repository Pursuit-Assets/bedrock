"""Shared Salesforce-error → HTTP mapping.

SF write/read failures should surface as actionable HTTP statuses, not opaque
500s, so the UI can route to the right recovery (reconnect / use-existing /
fix-field). Used by main.py and the route modules that call Salesforce.
"""
from fastapi import HTTPException


def sf_http_error(e: Exception, action: str = "operation") -> HTTPException:
    """Map a Salesforce error to an actionable HTTP status.

    401 session-expired (reconnect) · 409 duplicate rule · 400 validation
    (with the SF message) · 403 insufficient access · else 500.
    """
    msg = str(e)
    low = msg.lower()
    if "INVALID_SESSION_ID" in msg or "session expired" in low or "re-authentication failed" in low:
        return HTTPException(status_code=401, detail={
            "error": "sf_auth_required",
            "message": "Salesforce session expired — reconnect Salesforce in Settings.",
        })
    if "DUPLICATES_DETECTED" in msg or "duplicate" in low:
        return HTTPException(status_code=409, detail={
            "error": "duplicate", "message": f"This {action} already exists in Salesforce."})
    if any(x in msg for x in ("REQUIRED_FIELD_MISSING", "FIELD_CUSTOM_VALIDATION_EXCEPTION",
                              "INVALID_CROSS_REFERENCE_KEY", "MALFORMED_QUERY", "FIELD_INTEGRITY_EXCEPTION")):
        return HTTPException(status_code=400, detail={"error": "validation_failed", "message": msg})
    if "INSUFFICIENT_ACCESS" in msg:
        return HTTPException(status_code=403, detail={
            "error": "insufficient_access", "message": "You don't have permission for this in Salesforce."})
    return HTTPException(status_code=500, detail=msg)
