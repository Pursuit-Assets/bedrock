"""Shared FastAPI dependency functions.

Separated from main.py to avoid circular imports when route files
need to inject services via Depends().
"""

import asyncio
import logging
from typing import Any, Dict

from fastapi import HTTPException, Request

from mcp_client import UnifiedMCPClient
from data_sync import DataSyncService

logger = logging.getLogger(__name__)

# Service singletons — populated by main.py startup_event()
_services: Dict[str, Any] = {}

# Shared sync lock — used by background_sync_task, /api/sync/trigger,
# and /api/activities/sync/trigger to prevent concurrent syncs.
_sync_lock = asyncio.Lock()


def get_mcp_client(request: Request = None) -> UnifiedMCPClient:
    """Get MCP client dependency.

    Per-request behavior for Salesforce:
    - If the caller presents an ``sf_tokens`` cookie, we ALWAYS rebuild the
      Salesforce service from those (freshly-decrypted) tokens before
      returning. This prevents the singleton from caching a broken
      ``sf_client`` across requests after a token refresh (see BUG-AUTH-2).
    - If no cookie is present, fall back to whatever the startup code wired
      up (service-account SF, or nothing).
    """
    client = _services.get("mcp_client")
    if not client:
        raise HTTPException(status_code=503, detail="MCP client not initialized")

    sf_cookie = request.cookies.get("sf_tokens") if request else None

    if sf_cookie:
        try:
            from auth import decrypt_tokens
            from simple_salesforce import Salesforce
            from mcp_client.services.salesforce import SalesforceMCPService

            tokens = decrypt_tokens(sf_cookie)
            if tokens and tokens.get("access_token") and tokens.get("instance_url"):
                instance = tokens["instance_url"].replace("https://", "")
                sf = Salesforce(instance=instance, session_id=tokens["access_token"])

                existing = client.services.get("salesforce")
                if isinstance(existing, SalesforceMCPService):
                    existing.sf_client = sf
                    existing._authenticated = True
                    svc = existing
                else:
                    svc = SalesforceMCPService.__new__(SalesforceMCPService)
                    svc.client = None
                    svc._config = {}
                    svc._authenticated = True
                    svc.sf_client = sf
                    svc._reauth_lock = asyncio.Lock()
                    svc.username = None
                    svc.password = None
                    svc.security_token = None
                    svc.client_id = None
                    svc.client_secret = None
                    svc.domain = None
                    client.services["salesforce"] = svc

                if "salesforce" not in client._connected_services:
                    client._connected_services.append("salesforce")
                logger.debug("Refreshed SF service from per-user OAuth cookie")
        except Exception as e:
            logger.debug(f"Could not use per-user SF token: {e}")

    return client


def get_data_sync_service() -> DataSyncService:
    """Get data sync service dependency."""
    svc = _services.get("data_sync_service")
    if not svc:
        raise HTTPException(status_code=503, detail="Data sync service not available")
    return svc
