"""Google Workspace Domain-Wide Delegation (DWD) credential factory.

Reads GOOGLE_SERVICE_ACCOUNT_JSON (base64-encoded service account key JSON)
and returns impersonated credentials for any staff email in the org.

Required Google Workspace Admin setup (one-time):
  Security → API Controls → Domain-wide delegation → add client_id with scopes:
    https://www.googleapis.com/auth/gmail.readonly
    https://www.googleapis.com/auth/calendar.readonly
"""

import base64
import json
import os

from google.oauth2 import service_account

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]


def _load_service_account_info() -> dict:
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON env var not set")
    try:
        decoded = base64.b64decode(raw)
    except Exception:
        decoded = raw.encode()
    return json.loads(decoded)


def get_dwd_credentials(
    user_email: str,
    scopes: list[str],
) -> service_account.Credentials:
    """Return impersonated credentials for user_email."""
    info = _load_service_account_info()
    creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
    return creds.with_subject(user_email)


def is_dwd_configured() -> bool:
    return bool(os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", ""))
