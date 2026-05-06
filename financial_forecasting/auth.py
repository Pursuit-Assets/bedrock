"""Authentication utilities — JWT, Fernet encryption, user extraction from cookies."""

import hmac
import os
import json
import secrets
import hashlib
import base64
import logging
from typing import Dict, Optional
from datetime import datetime, timedelta

from jose import jwt, JWTError
from cryptography.fernet import Fernet
from fastapi import Request, HTTPException

logger = logging.getLogger(__name__)

# JWT secret — shared by JWT signing and Fernet key derivation
JWT_SECRET_KEY = os.getenv('JWT_SECRET_KEY', secrets.token_urlsafe(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24 * 30  # 30 days

# Production detection
FRONTEND_URL = os.getenv('FRONTEND_URL') or 'http://localhost:3000'
IS_PRODUCTION = FRONTEND_URL.startswith('https')

# Defense-in-depth JWT check at import time. The full env validator runs
# again at startup_event() in main.py — this earlier check catches the same
# weakness in any code path that imports auth.py before main.py runs (e.g.
# tests, scripts, alternate entry points).
from env_validator import current_environment, validate_jwt_secret_strength, Environment

if current_environment() == Environment.PRODUCTION:
    _jwt_ok, _jwt_reason = validate_jwt_secret_strength(JWT_SECRET_KEY)
    if not _jwt_ok:
        raise RuntimeError(
            f"Production requires a strong JWT_SECRET_KEY: {_jwt_reason}. "
            "Generate with: openssl rand -hex 32"
        )


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_access_token(data: dict) -> str:
    """Create JWT access token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(hours=JWT_EXPIRATION_HOURS)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> Optional[Dict]:
    """Verify JWT token and return payload."""
    try:
        return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return None


async def get_current_user(request: Request) -> Optional[Dict]:
    """Get current authenticated user from cookie."""
    token = request.cookies.get("access_token")
    if not token:
        return None
    payload = verify_token(token)
    if payload:
        # Backward compat: main.py endpoints reference user["user_id"]
        payload["user_id"] = payload.get("email", "unknown")
    return payload


# ---------------------------------------------------------------------------
# Fernet encryption for token cookies (SF / Google)
# ---------------------------------------------------------------------------

_fernet: Optional[Fernet] = None


def _derive_fernet_key(secret: str) -> bytes:
    """Derive a Fernet-compatible key from an arbitrary secret string."""
    key_bytes = hashlib.sha256(secret.encode()).digest()
    return base64.urlsafe_b64encode(key_bytes)


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_derive_fernet_key(JWT_SECRET_KEY))
    return _fernet


def encrypt_tokens(data: dict) -> str:
    """Encrypt a dict for cookie storage."""
    return get_fernet().encrypt(json.dumps(data).encode()).decode()


def decrypt_tokens(encrypted: str) -> Optional[dict]:
    """Decrypt a cookie value back to a dict."""
    try:
        return json.loads(get_fernet().decrypt(encrypted.encode()).decode())
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Cookie helpers
# ---------------------------------------------------------------------------

def cookie_params() -> dict:
    """Common cookie parameters (samesite, secure, httponly, max_age)."""
    return {
        "httponly": True,
        "max_age": 3600 * 24 * 30,
        "samesite": "none" if IS_PRODUCTION else "lax",
        "secure": IS_PRODUCTION,
    }


# ---------------------------------------------------------------------------
# FastAPI dependency wrapper
# ---------------------------------------------------------------------------

async def require_auth(request: Request) -> Dict:
    """Raises 401 if not authenticated."""
    user = await get_current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def get_current_user_dep(request: Request) -> Optional[Dict]:
    """FastAPI Depends() wrapper — returns user dict or None (allows unauthenticated)."""
    return await get_current_user(request)


# ---------------------------------------------------------------------------
# Internal service-to-service auth (CRM bridge: Pebble → Bedrock)
# ---------------------------------------------------------------------------

_BEDROCK_INTERNAL_API_KEY = os.getenv("BEDROCK_INTERNAL_API_KEY", "")

# HTTP methods considered "writes" for the kill switch below. Idempotent reads
# (GET, HEAD, OPTIONS) remain available even when the switch is on so that
# Pebble's research/lookup paths keep working during write-side incidents.
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Default scope grant for the internal-key principal. v1.0 grants the
# superset; later phases tighten via per-call X-Pebble-Scopes header.
# `*` is interpreted as "all scopes" by check_permission_or_internal.
_DEFAULT_INTERNAL_SCOPES = ("*",)


def _pebble_writes_disabled() -> bool:
    """Read the kill switch fresh on every call so operators can flip it
    without a redeploy. Truthy values: "true" / "1" / "yes" (case-insensitive).
    """
    return os.getenv("PEBBLE_WRITES_DISABLED", "").strip().lower() in {"true", "1", "yes"}


def _parse_scopes(header_value: str) -> tuple[str, ...]:
    """Parse the optional X-Pebble-Scopes header. Comma-separated scope
    strings; empty / unset header = full grant via the wildcard ``*``.
    """
    raw = (header_value or "").strip()
    if not raw:
        return _DEFAULT_INTERNAL_SCOPES
    scopes = tuple(s.strip() for s in raw.split(",") if s.strip())
    return scopes or _DEFAULT_INTERNAL_SCOPES


def _is_valid_originating_user_email(email: str) -> bool:
    """Lightweight shape check on X-Originating-User. We don't verify
    membership in org_users here (would require a DB hit on every
    request); the route-level audit insert (FK to org_users via
    originating_user_email lookup) is the durable check. Spoofs against
    the API key still produce auditable rows.
    """
    if not email or len(email) > 254:
        return False
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        return False
    if any(c.isspace() for c in email):
        return False
    return True


async def require_auth_or_internal(request: Request) -> Dict:
    """Authorize via internal API key (service-to-service) or user JWT.

    If X-Internal-Key header matches BEDROCK_INTERNAL_API_KEY, returns a
    synthetic service user dict.  Otherwise falls back to require_auth.
    Dev mode: if BEDROCK_INTERNAL_API_KEY is empty, internal key check
    is skipped and only JWT auth is tried.

    **Mandatory headers when using internal-key auth (Phase 0.2):**

    - ``X-Originating-User``: the human whose session triggered this
      service-to-service call. Required on EVERY internal-key request,
      reads and writes alike. The email is propagated to
      ``bedrock.pebble_write_audit`` and to permission resolution so
      that Pebble acts as a delegated principal, not a god principal.
      Three independent adversarial reviews flagged the un-attributed
      "service:pebble" pattern as a 1.0 blocker; this enforcement
      closes that gap.
    - ``X-Request-Id``: a UUIDv7 (or any UUID) for replay defense via
      ``UNIQUE(request_id)`` on ``bedrock.pebble_write_audit``. Format
      checked here; uniqueness checked at the audit-row INSERT in the
      route handler.

    Optional header:

    - ``X-Pebble-Scopes``: comma-separated scopes the caller is
      requesting for THIS request. Default = ``("*",)`` (full grant).
      ``check_permission_or_internal`` verifies the matching scope is
      present. Future tightening: Pebble will request narrow scopes
      per call instead of carrying the full grant.

    Kill switch: if PEBBLE_WRITES_DISABLED env is truthy AND the caller
    is using a valid internal key AND the request method is a write
    (POST/PUT/PATCH/DELETE), return 503. Reads via internal key and all
    JWT-authenticated requests are unaffected.
    """
    internal_key = request.headers.get("X-Internal-Key", "")
    if _BEDROCK_INTERNAL_API_KEY and internal_key:
        if hmac.compare_digest(internal_key, _BEDROCK_INTERNAL_API_KEY):
            if _pebble_writes_disabled() and request.method in _WRITE_METHODS:
                logger.warning(
                    "pebble_writes_disabled: blocking %s %s for service caller",
                    request.method,
                    request.url.path,
                )
                raise HTTPException(
                    status_code=503,
                    detail={
                        "error": "pebble_writes_disabled",
                        "message": (
                            "Pebble service-account writes are temporarily "
                            "disabled. Reads remain available."
                        ),
                    },
                )

            originating_user = request.headers.get("X-Originating-User", "").strip()
            if not _is_valid_originating_user_email(originating_user):
                logger.warning(
                    "internal_key_missing_originating_user: %s %s",
                    request.method,
                    request.url.path,
                )
                raise HTTPException(
                    status_code=401,
                    detail={
                        "error": "originating_user_required",
                        "message": (
                            "X-Originating-User header is required on every "
                            "internal-key request. Pebble acts on behalf of a "
                            "specific user, never as itself."
                        ),
                    },
                )

            request_id = request.headers.get("X-Request-Id", "").strip()
            if not request_id:
                logger.warning(
                    "internal_key_missing_request_id: %s %s",
                    request.method,
                    request.url.path,
                )
                raise HTTPException(
                    status_code=401,
                    detail={
                        "error": "request_id_required",
                        "message": (
                            "X-Request-Id header is required on every "
                            "internal-key request for replay defense. "
                            "Pass a UUID."
                        ),
                    },
                )

            scopes = _parse_scopes(request.headers.get("X-Pebble-Scopes", ""))

            return {
                "user_id": "service:pebble",
                "email": "pebble@internal",
                "is_service": True,
                "originating_user_email": originating_user,
                "request_id": request_id,
                "scopes": scopes,
            }
    return await require_auth(request)
