"""Tests for the JP-only launch-dark gate (pebble_access permission).

Pinned behaviors:
  A. pebble_access is in PERMISSION_KEYS so admin tooling validates it.
  B. pebble_access is in ADMIN_AUTOFILL_EXCLUDED — Admin profile does
     NOT auto-grant it. Without this, every Admin (Jac, etc.) would
     receive pebble_access=true via the setdefault loop at
     routes/permissions.py:_admin_autofill.
  C. Per-user permission_overrides win over profile permissions:
       * Override grant (true) on a non-Pebble profile → user has access.
       * Override deny  (false) on an Admin → user loses access.
  D. check_pebble_permission composite gate:
       * 403 "Permission denied: pebble_access" when master gate fails.
       * 403 "Permission denied: <sub>" when master passes but sub fails.
       * Service account (is_service=True) bypasses both.
  E. require_pebble_access standalone gate (for cockpit SSE / abort):
       * 403 on missing master gate.
       * Service account bypass.
"""

from __future__ import annotations

import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from routes.permissions import (
    ADMIN_AUTOFILL_EXCLUDED,
    PERMISSION_KEYS,
    _admin_autofill,
    _apply_overrides,
    check_pebble_permission,
    require_pebble_access,
)


# ---------------------------------------------------------------------------
# A. PERMISSION_KEYS includes pebble_access
# ---------------------------------------------------------------------------

def test_pebble_access_in_permission_keys():
    """Admin tooling validates against PERMISSION_KEYS — the key must be there."""
    assert "pebble_access" in PERMISSION_KEYS


# ---------------------------------------------------------------------------
# B. Admin auto-fill EXCLUDES pebble_access
# ---------------------------------------------------------------------------

def test_admin_autofill_excludes_pebble_access():
    """An Admin starting with empty perms should NOT receive pebble_access."""
    perms: dict = {}
    _admin_autofill(perms)
    # Every other key gets true:
    assert perms.get("manage_users_roles") is True
    assert perms.get("view_opportunities") is True
    assert perms.get("use_pebble_chat") is True
    # Except the launch-dark gates:
    assert "pebble_access" not in perms or perms.get("pebble_access") is not True


def test_admin_autofill_excluded_set_contains_pebble_access():
    """The exclusion set is the source of truth; pin its membership."""
    assert "pebble_access" in ADMIN_AUTOFILL_EXCLUDED


def test_admin_autofill_preserves_explicit_grant():
    """If a profile explicitly sets pebble_access=true, auto-fill must not
    clobber it. setdefault semantics preserve existing values."""
    perms = {"pebble_access": True}
    _admin_autofill(perms)
    assert perms["pebble_access"] is True


def test_admin_autofill_preserves_explicit_deny():
    """If a profile explicitly sets pebble_access=false (current state for
    all 4 profiles post-2026-05-18 migration), auto-fill must not flip it."""
    perms = {"pebble_access": False}
    _admin_autofill(perms)
    assert perms["pebble_access"] is False


# ---------------------------------------------------------------------------
# C. permission_overrides layer
# ---------------------------------------------------------------------------

def test_apply_overrides_grants_pebble_access():
    """JP's user_config row: override grants pebble_access on a profile
    that defaults to false."""
    perms = {"pebble_access": False, "use_pebble_chat": False}
    _apply_overrides(perms, {"pebble_access": True})
    assert perms["pebble_access"] is True
    # Other keys unchanged:
    assert perms["use_pebble_chat"] is False


def test_apply_overrides_revokes_admin_grant():
    """Override can deny — even on an Admin profile that has the key true."""
    perms = {"pebble_access": True, "view_opportunities": True}
    _apply_overrides(perms, {"pebble_access": False})
    assert perms["pebble_access"] is False
    assert perms["view_opportunities"] is True


def test_apply_overrides_ignores_non_boolean_values():
    """Defense against malformed JSONB — string / null / int overrides
    must not corrupt the perms dict."""
    perms = {"pebble_access": False}
    _apply_overrides(perms, {"pebble_access": "yes"})        # not bool
    assert perms["pebble_access"] is False
    _apply_overrides(perms, {"pebble_access": 1})            # not bool
    assert perms["pebble_access"] is False
    _apply_overrides(perms, {"pebble_access": None})         # not bool
    assert perms["pebble_access"] is False


def test_apply_overrides_handles_jsonb_string_input():
    """asyncpg can return JSONB as either a dict or a JSON string;
    _parse_perms (used internally) handles both."""
    perms = {"pebble_access": False}
    _apply_overrides(perms, '{"pebble_access": true}')
    assert perms["pebble_access"] is True


def test_apply_overrides_handles_empty_overrides():
    """Empty / None / unparseable overrides leave perms unchanged."""
    perms = {"pebble_access": False, "use_pebble_chat": True}
    _apply_overrides(perms, {})
    _apply_overrides(perms, None)
    _apply_overrides(perms, "")
    _apply_overrides(perms, "garbage-not-json")
    assert perms == {"pebble_access": False, "use_pebble_chat": True}


# ---------------------------------------------------------------------------
# D. check_pebble_permission composite gate semantics
# ---------------------------------------------------------------------------

class _FakeDB:
    def __init__(self, perms: dict):
        self._perms = perms

    async def fetchrow(self, *a, **kw):
        return None

    async def fetchval(self, *a, **kw):
        return 0


@pytest.mark.asyncio
async def test_composite_gate_blocks_when_master_gate_missing(monkeypatch):
    """User has use_pebble_chat=true but lacks pebble_access → 403 with
    pebble_access error (not use_pebble_chat)."""
    async def fake_get_perms(email, db):
        return {"permissions": {"pebble_access": False, "use_pebble_chat": True}}
    monkeypatch.setattr("routes.permissions.get_user_permissions", fake_get_perms)

    gate = check_pebble_permission("use_pebble_chat")
    with pytest.raises(HTTPException) as exc:
        await gate(user={"email": "jac@pursuit.org"}, db=None)
    assert exc.value.status_code == 403
    assert "pebble_access" in exc.value.detail
    # The message must NOT mention the sub-permission — we want frontends
    # to distinguish "launch-dark disabled" from "feature-specific deny".
    assert "use_pebble_chat" not in exc.value.detail


@pytest.mark.asyncio
async def test_composite_gate_blocks_when_sub_permission_missing(monkeypatch):
    """User has pebble_access but lacks use_pebble_chat → 403 with the
    sub-permission error."""
    async def fake_get_perms(email, db):
        return {"permissions": {"pebble_access": True, "use_pebble_chat": False}}
    monkeypatch.setattr("routes.permissions.get_user_permissions", fake_get_perms)

    gate = check_pebble_permission("use_pebble_chat")
    with pytest.raises(HTTPException) as exc:
        await gate(user={"email": "jp@pursuit.org"}, db=None)
    assert exc.value.status_code == 403
    assert "use_pebble_chat" in exc.value.detail


@pytest.mark.asyncio
async def test_composite_gate_passes_when_both_grant(monkeypatch):
    """JP after migration: pebble_access=true (via override) AND
    use_pebble_chat=true (via Admin auto-fill)."""
    async def fake_get_perms(email, db):
        return {"permissions": {"pebble_access": True, "use_pebble_chat": True}}
    monkeypatch.setattr("routes.permissions.get_user_permissions", fake_get_perms)

    gate = check_pebble_permission("use_pebble_chat")
    user = await gate(user={"email": "jp@pursuit.org"}, db=None)
    assert user["email"] == "jp@pursuit.org"
    assert user["_permissions"]["pebble_access"] is True


@pytest.mark.asyncio
async def test_composite_gate_service_account_bypass(monkeypatch):
    """Pebble→Bedrock internal-key call: is_service=True bypasses both
    checks, same shape as check_permission_or_internal."""
    async def should_not_be_called(*a, **kw):
        raise AssertionError("get_user_permissions called for service account")
    monkeypatch.setattr("routes.permissions.get_user_permissions", should_not_be_called)

    gate = check_pebble_permission("use_pebble_chat")
    user = await gate(user={"is_service": True}, db=None)
    assert user["is_service"] is True


# ---------------------------------------------------------------------------
# E. require_pebble_access standalone gate
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_require_pebble_access_blocks_non_jp(monkeypatch):
    """An Admin without the override gets 403 from the standalone gate."""
    async def fake_get_perms(email, db):
        return {"permissions": {"pebble_access": False}}
    monkeypatch.setattr("routes.permissions.get_user_permissions", fake_get_perms)

    with pytest.raises(HTTPException) as exc:
        await require_pebble_access(user={"email": "jac@pursuit.org"}, db=None)
    assert exc.value.status_code == 403
    assert "pebble_access" in exc.value.detail


@pytest.mark.asyncio
async def test_require_pebble_access_passes_jp(monkeypatch):
    """JP with the override passes the gate."""
    async def fake_get_perms(email, db):
        return {"permissions": {"pebble_access": True}}
    monkeypatch.setattr("routes.permissions.get_user_permissions", fake_get_perms)

    user = await require_pebble_access(user={"email": "jp@pursuit.org"}, db=None)
    assert user["email"] == "jp@pursuit.org"
    assert user["_permissions"]["pebble_access"] is True


@pytest.mark.asyncio
async def test_require_pebble_access_service_bypass(monkeypatch):
    """Service account bypasses the standalone gate too."""
    async def should_not_be_called(*a, **kw):
        raise AssertionError("get_user_permissions called for service account")
    monkeypatch.setattr("routes.permissions.get_user_permissions", should_not_be_called)

    user = await require_pebble_access(user={"is_service": True}, db=None)
    assert user["is_service"] is True


# ---------------------------------------------------------------------------
# F. Integration: full resolution chain mimics get_user_permissions
# ---------------------------------------------------------------------------

def test_full_resolution_jac_vs_jp():
    """Simulate the full resolve chain: profile.permissions → Admin
    auto-fill (excluding pebble_access) → permission_overrides.

    Jac (Admin, no override) → pebble_access=False.
    JP  (Admin, override grants) → pebble_access=True.
    """
    # Both start from the post-migration Admin profile state where
    # pebble_access is explicitly false.
    jac_profile_perms = {"manage_users_roles": True, "pebble_access": False}
    jp_profile_perms = {"manage_users_roles": True, "pebble_access": False}

    # Step 1: Admin auto-fill
    _admin_autofill(jac_profile_perms)
    _admin_autofill(jp_profile_perms)
    # Both still have pebble_access=False (auto-fill excludes it)
    assert jac_profile_perms["pebble_access"] is False
    assert jp_profile_perms["pebble_access"] is False
    # But every other admin-relevant key is now true
    assert jac_profile_perms["use_pebble_chat"] is True
    assert jp_profile_perms["use_pebble_chat"] is True

    # Step 2: apply overrides
    _apply_overrides(jac_profile_perms, {})                       # no override for Jac
    _apply_overrides(jp_profile_perms, {"pebble_access": True})   # JP's seeded override

    assert jac_profile_perms["pebble_access"] is False
    assert jp_profile_perms["pebble_access"] is True
