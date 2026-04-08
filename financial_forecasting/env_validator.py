"""Centralized environment variable validation.

Single source of truth for "what does production require" plus the
"is this prod?" detection. Called once at the very start of the FastAPI
startup hook in main.py — fails loudly in production if any required
credential is missing, weak, or matches a known placeholder; logs warnings
in development without aborting.

Why this exists:
    Before this module, missing credentials manifested as confusing 401/500
    errors at first API call. Worse, auth.py:20 falls back to
    secrets.token_urlsafe(32) for JWT_SECRET_KEY, meaning a missing key in
    production silently generates a random secret each restart, invalidating
    every session. The validator catches all of these at startup so the
    operator sees one structured error message instead of debugging
    runtime mysteries.

Two ways to mark an environment as production:
    1. Explicit:  ENVIRONMENT=production
    2. Heuristic: FRONTEND_URL starts with "https" (legacy, kept for
                  backward compat with the existing IS_PRODUCTION constant
                  in auth.py:26)
    The explicit env var takes precedence when both are set.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Environment detection
# ---------------------------------------------------------------------------


class Environment(str, Enum):
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


def current_environment() -> Environment:
    """Determine the current environment.

    Order of precedence:
        1. Explicit ENVIRONMENT env var ("development" / "staging" / "production")
        2. FRONTEND_URL starts with "https" → PRODUCTION (legacy heuristic)
        3. Default → DEVELOPMENT
    """
    explicit = os.getenv("ENVIRONMENT", "").strip().lower()
    if explicit == "production":
        return Environment.PRODUCTION
    if explicit == "staging":
        return Environment.STAGING
    if explicit == "development":
        return Environment.DEVELOPMENT

    # Legacy heuristic: prod is detected by https FRONTEND_URL
    frontend_url = os.getenv("FRONTEND_URL", "")
    if frontend_url.startswith("https"):
        return Environment.PRODUCTION

    return Environment.DEVELOPMENT


# ---------------------------------------------------------------------------
# Required-variable specification
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RequiredVar:
    """Specification for a required environment variable.

    Attributes:
        name: The env var name (e.g. "JWT_SECRET_KEY")
        min_length: Minimum acceptable length after strip(). Default 1.
        forbidden_values: Exact strings that count as "missing" even if set
            (e.g. "changeme", template placeholders).
        condition: Optional predicate. If provided and returns False, the var
            is skipped entirely. Used for vars that are only required when a
            feature flag is on (e.g. SAGE_* only required when SAGE_ENABLED).
    """

    name: str
    min_length: int = 1
    forbidden_values: tuple[str, ...] = field(default_factory=tuple)
    condition: Optional[Callable[[], bool]] = None


def _sage_enabled() -> bool:
    """SAGE_* vars are only required when SAGE_ENABLED is on."""
    return os.getenv("SAGE_ENABLED", "").lower() in ("true", "1", "yes")


# Forbidden values that mean "operator forgot to fill in the template"
_TEMPLATE_PLACEHOLDERS_JWT: tuple[str, ...] = (
    "",
    "changeme",
    "secret",
    "your-very-long-random-secret-key-minimum-32-characters",
)
_TEMPLATE_PLACEHOLDERS_GENERIC: tuple[str, ...] = ("",)
_TEMPLATE_PLACEHOLDERS_SAGE_PASSWORD: tuple[str, ...] = (
    "",
    "your_password",
    "your-password",
)


REQUIRED_VARS: tuple[RequiredVar, ...] = (
    # Always required
    RequiredVar(
        name="JWT_SECRET_KEY",
        min_length=32,
        forbidden_values=_TEMPLATE_PLACEHOLDERS_JWT,
    ),
    RequiredVar(name="DATABASE_URL", forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="GOOGLE_CLIENT_ID", forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="GOOGLE_CLIENT_SECRET", forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="FRONTEND_URL", forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="SALESFORCE_CLIENT_ID", forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="SALESFORCE_CLIENT_SECRET", forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    # Conditional: Sage Intacct (only when SAGE_ENABLED)
    RequiredVar(name="SAGE_COMPANY_ID", condition=_sage_enabled, forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="SAGE_USER_ID", condition=_sage_enabled, forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(
        name="SAGE_USER_PASSWORD",
        condition=_sage_enabled,
        forbidden_values=_TEMPLATE_PLACEHOLDERS_SAGE_PASSWORD,
    ),
    RequiredVar(name="SAGE_SENDER_ID", condition=_sage_enabled, forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
    RequiredVar(name="SAGE_SENDER_PASSWORD", condition=_sage_enabled, forbidden_values=_TEMPLATE_PLACEHOLDERS_GENERIC),
)


# ---------------------------------------------------------------------------
# JWT secret strength helper (extracted for reuse by auth.py)
# ---------------------------------------------------------------------------


def validate_jwt_secret_strength(secret: Optional[str]) -> tuple[bool, Optional[str]]:
    """Check whether a JWT secret meets the strength bar.

    Returns:
        (is_strong, reason_if_weak). reason_if_weak is None when is_strong is True.
    """
    if secret is None or secret.strip() == "":
        return False, "missing or empty"
    stripped = secret.strip()
    if len(stripped) < 32:
        return False, f"too short ({len(stripped)} chars, minimum 32)"
    if stripped in _TEMPLATE_PLACEHOLDERS_JWT:
        return False, f"matches forbidden placeholder value {stripped!r}"
    return True, None


# ---------------------------------------------------------------------------
# Validation entrypoint
# ---------------------------------------------------------------------------


def _check_var(var: RequiredVar) -> Optional[str]:
    """Check a single var. Returns an error string if invalid, else None."""
    if var.condition is not None and not var.condition():
        return None  # Conditional, not required right now

    raw = os.getenv(var.name)
    if raw is None:
        return f"{var.name}: missing (env var unset)"

    stripped = raw.strip()
    if stripped == "":
        return f"{var.name}: empty after strip()"

    if stripped in var.forbidden_values:
        return f"{var.name}: matches forbidden placeholder value {stripped!r}"

    if len(stripped) < var.min_length:
        return f"{var.name}: too short ({len(stripped)} chars, minimum {var.min_length})"

    return None


def validate_required_env(env: Optional[Environment] = None) -> None:
    """Validate every required environment variable in one pass.

    In PRODUCTION: raises RuntimeError listing every problem.
    In DEVELOPMENT or STAGING: logs warnings, returns normally.

    Args:
        env: Override the detected environment. Mostly for testing — production
             code should call this with no argument so it uses current_environment().

    Raises:
        RuntimeError: in production mode if any required var is missing or weak.
    """
    if env is None:
        env = current_environment()

    errors: list[str] = []
    for var in REQUIRED_VARS:
        problem = _check_var(var)
        if problem is not None:
            errors.append(problem)

    if not errors:
        logger.info(f"env_validator: all required vars present ({env.value})")
        return

    summary = (
        f"env_validator: {len(errors)} required env var(s) missing or weak:\n"
        + "\n".join(f"  - {e}" for e in errors)
    )

    if env == Environment.PRODUCTION:
        # Hard fail. The operator must fix all of these before the app can serve traffic.
        raise RuntimeError(
            f"{summary}\n\n"
            "Production refuses to start with missing or weak credentials. "
            "Set the variables above and restart. "
            "Generate a JWT secret with: openssl rand -hex 32"
        )
    else:
        # Dev / staging: warn but continue. Local dev convenience.
        logger.warning(f"{summary}\n  ({env.value} mode — continuing without these)")
