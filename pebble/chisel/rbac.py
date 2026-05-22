"""RBAC stub for Chisel — interim, until Sprint-12 lands.

Plan §11.9: bypass list driven by ``PEBBLE_CHISEL_RBAC_BYPASS_USERS``
(comma-separated emails), defaulting to ``PEBBLE_CHAT_ALLOWED_EMAILS``
if that env exists. When Sprint-12 ships the real permission resolver,
this module becomes a one-call shim onto that resolver.

Manifest fields consumed:
  * ``requires_permission`` — snake_case name (e.g. ``chisel_write``)
    matching the Sprint-12 convention sample ``use_pebble_research``.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class PermissionResult:
    ok: bool
    reason: str = ""


def _split_emails(raw: str) -> set[str]:
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _bypass_set() -> set[str]:
    raw = os.environ.get("PEBBLE_CHISEL_RBAC_BYPASS_USERS", "").strip()
    if raw:
        return _split_emails(raw)
    raw = os.environ.get("PEBBLE_CHAT_ALLOWED_EMAILS", "").strip()
    return _split_emails(raw)


def check_permission(
    *,
    user_email: str,
    required_permission: str | None,
) -> PermissionResult:
    """Return PermissionResult(ok=True) when:

    * ``required_permission`` is None (tool/workflow doesn't gate);
    * the user is in the bypass set;

    otherwise (Sprint-12 hook absent) PermissionResult(ok=False).
    Once Sprint-12 lands, the else-branch defers to its resolver.
    """
    if not required_permission:
        return PermissionResult(ok=True)

    bypass = _bypass_set()
    if user_email and user_email.lower() in bypass:
        return PermissionResult(ok=True, reason="bypass_list")

    return PermissionResult(
        ok=False,
        reason=f"missing_permission: {required_permission}",
    )
