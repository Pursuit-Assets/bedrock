"""Tests for ``services/search_service.py`` — Phase 1.8 read API.

Locks in the load-bearing invariants:

A. Multi-tenant ``org_id`` is ALWAYS in the WHERE predicate.
B. Admin / view-all callers get a simplified predicate but org_id
   still applies.
C. Non-admin callers get the OR-chain (org-visible + owner_sf_id +
   owner_email + view-all overrides).
D. Org-visible entity types (Accounts, Contacts) bypass ownership
   when visibility='org'.
E. Owned-by-this-user via sf_user_id when caller has it.
F. Owned-by-this-user via email always.
G. Empty query returns empty response, not a database hit.
H. Type validation rejects unknown entity_type strings.
I. Limit clamping (negative → default; > MAX → MAX).
J. Service callers spoofing a non-existent originating user get the
   most-restrictive (logged-out-shaped) principal — no rows visible.
K. ``query_text_hash`` is stable + case-insensitive.
"""

import os
import sys
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from services import search_service as ss


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _principal(
    *,
    email: str = "rm@pursuit.org",
    sf_user_id: str | None = "005AAA",
    is_admin: bool = False,
    view_all_accounts: bool = False,
    view_all_opps: bool = False,
    view_all_contacts: bool = False,
    org_id: str = "pursuit",
) -> ss.SearchPrincipal:
    return ss.SearchPrincipal(
        email=email,
        sf_user_id=sf_user_id,
        is_admin=is_admin,
        has_view_all_accounts=view_all_accounts,
        has_view_all_opportunities=view_all_opps,
        has_view_all_contacts=view_all_contacts,
        org_id=org_id,
    )


def _row(
    *,
    entity_type: str = "sf_account",
    entity_id: str = "001AAA",
    title: str = "Acme",
    subtitle: str | None = None,
    href: str = "/accounts/001AAA",
    rank: float = 1.0,
    activity_at: datetime | None = None,
    indexed_at: datetime | None = None,
) -> dict:
    return {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "title": title,
        "subtitle": subtitle,
        "href": href,
        "rank": rank,
        "activity_at": activity_at,
        "indexed_at": indexed_at or datetime(2026, 5, 6, tzinfo=timezone.utc),
    }


# ---------------------------------------------------------------------------
# A. Multi-tenant org_id always present
# ---------------------------------------------------------------------------

def test_admin_predicate_keeps_org_id():
    pred, params = ss._compose_permission_predicate(
        _principal(is_admin=True), sql_param_offset=2,
    )
    assert "org_id = $3" in pred
    assert params == ["pursuit"]


def test_non_admin_predicate_keeps_org_id_first():
    pred, _ = ss._compose_permission_predicate(
        _principal(), sql_param_offset=2,
    )
    # org_id must be the first WHERE clause for index seek efficiency.
    assert pred.startswith("org_id = $3")


def test_custom_org_id_propagates():
    _, params = ss._compose_permission_predicate(
        _principal(org_id="other_tenant"), sql_param_offset=2,
    )
    assert "other_tenant" in params


# ---------------------------------------------------------------------------
# B. Admin path
# ---------------------------------------------------------------------------

def test_admin_predicate_skips_or_chain():
    """Admins see everything → no OR-chain, just org_id."""
    pred, _ = ss._compose_permission_predicate(
        _principal(is_admin=True), sql_param_offset=2,
    )
    assert " OR " not in pred
    assert "owner_sf_id" not in pred
    assert "owner_email" not in pred


def test_full_view_all_grant_skips_or_chain():
    """A non-admin user with all three view_all_* permissions gets the
    fast-path (no OR-chain), since they can see everything."""
    pred, _ = ss._compose_permission_predicate(
        _principal(
            view_all_accounts=True,
            view_all_opps=True,
            view_all_contacts=True,
        ),
        sql_param_offset=2,
    )
    assert " OR " not in pred


# ---------------------------------------------------------------------------
# C, D, E, F. OR-chain composition for restricted users
# ---------------------------------------------------------------------------

def test_restricted_predicate_includes_org_visible_clause():
    pred, _ = ss._compose_permission_predicate(
        _principal(), sql_param_offset=2,
    )
    # Org-visible entity types (sorted): sf_account, sf_contact
    assert "'sf_account'" in pred
    assert "'sf_contact'" in pred
    assert "visibility = 'org'" in pred


def test_restricted_predicate_includes_owner_sf_id_when_present():
    pred, params = ss._compose_permission_predicate(
        _principal(sf_user_id="005XYZ"), sql_param_offset=2,
    )
    assert "owner_sf_id" in pred
    assert "005XYZ" in params


def test_restricted_predicate_omits_owner_sf_id_when_missing():
    pred, params = ss._compose_permission_predicate(
        _principal(sf_user_id=None), sql_param_offset=2,
    )
    assert "owner_sf_id" not in pred
    assert "005XYZ" not in params


def test_restricted_predicate_always_includes_owner_email():
    pred, params = ss._compose_permission_predicate(
        _principal(email="rm@pursuit.org"), sql_param_offset=2,
    )
    assert "owner_email" in pred
    assert "rm@pursuit.org" in params


def test_view_all_opportunities_adds_opp_branch():
    pred, _ = ss._compose_permission_predicate(
        _principal(view_all_opps=True), sql_param_offset=2,
    )
    assert "entity_type = 'sf_opportunity'" in pred


def test_view_all_contacts_adds_contact_branch():
    pred, _ = ss._compose_permission_predicate(
        _principal(view_all_contacts=True), sql_param_offset=2,
    )
    assert "entity_type = 'sf_contact'" in pred


def test_view_all_accounts_adds_account_branch():
    pred, _ = ss._compose_permission_predicate(
        _principal(view_all_accounts=True), sql_param_offset=2,
    )
    assert "entity_type = 'sf_account'" in pred


# ---------------------------------------------------------------------------
# G. Empty query short-circuits
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_query_returns_empty_without_db_hit():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[])
    resp = await ss.search(fake_conn, _principal(), ss.SearchRequest(query="   "))
    assert resp.items == []
    assert resp.backend_used == "cache_hit"
    fake_conn.fetch.assert_not_called()


# ---------------------------------------------------------------------------
# H. Entity-type validation
# ---------------------------------------------------------------------------

def test_unknown_entity_type_rejected():
    req = ss.SearchRequest(query="x", types=["totally_fake"])
    with pytest.raises(ValueError, match=r"Unknown entity_type"):
        req.normalized_types()


def test_known_entity_types_accepted():
    req = ss.SearchRequest(query="x", types=["sf_account", "pebble_profile"])
    assert req.normalized_types() == ("sf_account", "pebble_profile")


def test_default_entity_types_is_all():
    req = ss.SearchRequest(query="x")
    assert req.normalized_types() == ss.ALL_ENTITY_TYPES


# ---------------------------------------------------------------------------
# I. Limit clamping
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    (0, ss.DEFAULT_LIMIT),
    (-5, ss.DEFAULT_LIMIT),
    (1, 1),
    (50, 50),
    (ss.MAX_LIMIT, ss.MAX_LIMIT),
    (ss.MAX_LIMIT + 1, ss.MAX_LIMIT),
    (10000, ss.MAX_LIMIT),
])
def test_limit_clamping(raw, expected):
    assert ss.SearchRequest(query="x", limit=raw).normalized_limit() == expected


# ---------------------------------------------------------------------------
# J. Service-caller spoof of non-existent user → most restrictive
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resolve_principal_for_nonexistent_user_is_restrictive(monkeypatch):
    """Pebble carrying X-Originating-User=ghost@example.com hits the
    canonical permission resolver, which returns
    ``{permissions: {}, sf_user_id: None, profile_name: None}`` for
    a non-existent user (local-dev or genuine spoof). Principal
    locks down — no rows visible."""
    async def _fake_get_perms(email, db):
        return {
            "id": None, "email": email, "name": "",
            "sf_user_id": None, "is_active": True,
            "permissions": {}, "profile_name": None, "profile_id": None,
            "org_user_id": None,
        }
    monkeypatch.setattr("routes.permissions.get_user_permissions", _fake_get_perms)

    fake_conn = AsyncMock()
    user = {
        "is_service": True,
        "originating_user_email": "ghost@example.com",
    }
    principal = await ss.resolve_principal(fake_conn, user)
    assert principal.email == "ghost@example.com"
    assert principal.sf_user_id is None
    assert principal.is_admin is False
    assert principal.has_view_all_accounts is False
    assert principal.has_view_all_opportunities is False
    assert principal.has_view_all_contacts is False


@pytest.mark.asyncio
async def test_resolve_principal_for_admin_grants_view_all(monkeypatch):
    """Admin profile name OR manage_users_roles permission ⇒ is_admin
    ⇒ all view_all_* flags true regardless of individual perm flags.
    Mirrors the canonical resolver's "Admin defaults all keys true"
    behavior."""
    async def _fake(email, db):
        return {
            "id": "u-1", "email": email, "name": "Admin User",
            "sf_user_id": "005ADMIN", "is_active": True,
            "permissions": {"manage_users_roles": True, "edit_accounts": True,
                            "edit_all_opportunities": True, "edit_contacts": True},
            "profile_name": "Admin",
            "profile_id": "p-admin", "org_user_id": "u-1",
        }
    monkeypatch.setattr("routes.permissions.get_user_permissions", _fake)

    fake_conn = AsyncMock()
    principal = await ss.resolve_principal(fake_conn, {"email": "admin@pursuit.org"})
    assert principal.is_admin is True
    assert principal.has_view_all_accounts is True
    assert principal.has_view_all_opportunities is True
    assert principal.has_view_all_contacts is True


@pytest.mark.asyncio
async def test_resolve_principal_rm_with_partial_perms(monkeypatch):
    """RM profile — has edit_accounts and edit_contacts but NOT
    edit_all_opportunities. Should grant view_all on accounts +
    contacts but NOT on opportunities."""
    async def _fake(email, db):
        return {
            "id": "u-2", "email": email, "name": "RM",
            "sf_user_id": "005RM", "is_active": True,
            "permissions": {
                "edit_accounts": True,
                "edit_contacts": True,
                "edit_own_opportunities": True,
                "edit_all_opportunities": False,
                "manage_users_roles": False,
            },
            "profile_name": "Relationship Manager",
            "profile_id": "p-rm", "org_user_id": "u-2",
        }
    monkeypatch.setattr("routes.permissions.get_user_permissions", _fake)

    fake_conn = AsyncMock()
    principal = await ss.resolve_principal(fake_conn, {"email": "rm@pursuit.org"})
    assert principal.is_admin is False
    assert principal.has_view_all_accounts is True   # RM has edit_accounts
    assert principal.has_view_all_contacts is True
    assert principal.has_view_all_opportunities is False
    assert principal.sf_user_id == "005RM"


@pytest.mark.asyncio
async def test_resolve_principal_get_user_permissions_failure_is_fail_closed(monkeypatch):
    """When the canonical resolver raises (DB down, schema migration
    in flight), we fail-closed to the most restrictive principal.
    Search returns nothing rather than failing open."""
    async def _boom(email, db):
        raise RuntimeError("DB unreachable")
    monkeypatch.setattr("routes.permissions.get_user_permissions", _boom)

    fake_conn = AsyncMock()
    principal = await ss.resolve_principal(fake_conn, {"email": "rm@pursuit.org"})
    assert principal.email == "rm@pursuit.org"
    assert principal.is_admin is False
    assert principal.has_view_all_accounts is False
    assert principal.has_view_all_opportunities is False
    assert principal.has_view_all_contacts is False


@pytest.mark.asyncio
async def test_resolve_principal_service_without_originating_user_raises():
    fake_conn = AsyncMock()
    user = {"is_service": True}    # missing originating_user_email
    with pytest.raises(ValueError, match=r"originating_user_email"):
        await ss.resolve_principal(fake_conn, user)


@pytest.mark.asyncio
async def test_resolve_principal_service_uses_originating_user_for_lookup(monkeypatch):
    """Pebble (service caller) resolves permissions against the
    originating human, NOT against pebble@internal. Locks in the
    delegated-principal contract."""
    captured_emails: list[str] = []

    async def _fake(email, db):
        captured_emails.append(email)
        return {
            "id": "u-3", "email": email, "name": "RM",
            "sf_user_id": "005RM", "is_active": True,
            "permissions": {"edit_accounts": True},
            "profile_name": "Relationship Manager",
            "profile_id": "p-rm", "org_user_id": "u-3",
        }
    monkeypatch.setattr("routes.permissions.get_user_permissions", _fake)

    fake_conn = AsyncMock()
    user = {
        "is_service": True,
        "email": "pebble@internal",
        "originating_user_email": "rm@pursuit.org",
    }
    principal = await ss.resolve_principal(fake_conn, user)
    assert captured_emails == ["rm@pursuit.org"]
    assert principal.email == "rm@pursuit.org"
    assert principal.sf_user_id == "005RM"


# ---------------------------------------------------------------------------
# K. query_text_hash
# ---------------------------------------------------------------------------

def test_query_text_hash_stable():
    h1 = ss.query_text_hash("Acme Corp")
    h2 = ss.query_text_hash("Acme Corp")
    assert h1 == h2


def test_query_text_hash_case_insensitive():
    assert ss.query_text_hash("acme corp") == ss.query_text_hash("ACME CORP")


def test_query_text_hash_strips_whitespace():
    assert ss.query_text_hash("  acme  ") == ss.query_text_hash("acme")


def test_query_text_hash_distinguishes_distinct_queries():
    assert ss.query_text_hash("acme") != ss.query_text_hash("widget")


# ---------------------------------------------------------------------------
# End-to-end search() with a mocked connection
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_returns_hits_with_correct_grouping():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[
        _row(entity_type="sf_account", title="Acme", rank=0.9),
        _row(entity_type="sf_contact", entity_id="003BBB",
             title="Wile E. Coyote", subtitle="Acme · CEO",
             href="/contacts/003BBB", rank=0.8),
        _row(entity_type="pebble_profile", entity_id="prof-1",
             title="MetLife Foundation", subtitle="Researched 4d ago",
             href="/pebble/profiles/prof-1", rank=0.7),
    ])

    resp = await ss.search(fake_conn, _principal(), ss.SearchRequest(query="acme"))

    assert len(resp.items) == 3
    # Group labels should match ENTITY_GROUP_LABEL.
    assert resp.items[0].group == "Accounts"
    assert resp.items[1].group == "Contacts"
    assert resp.items[2].group == "Researched Prospects"
    # The query SQL must include the org_id predicate and the perm OR-chain.
    sent_sql, *_ = fake_conn.fetch.call_args.args
    assert "org_id = $" in sent_sql
    assert "search_vector @@ q.tsq" in sent_sql
    assert "ts_rank_cd" in sent_sql
    assert "deleted_at IS NULL" in sent_sql


@pytest.mark.asyncio
async def test_search_admin_predicate_does_not_include_owner_filters():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[])
    await ss.search(
        fake_conn, _principal(is_admin=True), ss.SearchRequest(query="x"),
    )
    sent_sql, *_ = fake_conn.fetch.call_args.args
    assert "owner_sf_id" not in sent_sql
    assert "owner_email" not in sent_sql
    # But org_id MUST still be there.
    assert "org_id = $" in sent_sql


@pytest.mark.asyncio
async def test_search_passes_query_text_and_types_as_params():
    fake_conn = AsyncMock()
    fake_conn.fetch = AsyncMock(return_value=[])
    await ss.search(
        fake_conn,
        _principal(),
        ss.SearchRequest(query="metlife", types=["sf_account", "pebble_profile"]),
    )
    sent_args = fake_conn.fetch.call_args.args
    # First param is the query, second is the type-array.
    assert sent_args[1] == "metlife"
    assert sent_args[2] == ["sf_account", "pebble_profile"]


# ---------------------------------------------------------------------------
# Group labelling
# ---------------------------------------------------------------------------

def test_group_hits_preserves_rank_order():
    a = ss.SearchHit(
        entity_type="sf_account", entity_id="1",
        title="A", subtitle=None, href="/", rank=2.0,
        activity_at=None, indexed_at="2026-05-06",
    )
    b = ss.SearchHit(
        entity_type="sf_account", entity_id="2",
        title="B", subtitle=None, href="/", rank=1.0,
        activity_at=None, indexed_at="2026-05-06",
    )
    c = ss.SearchHit(
        entity_type="pebble_profile", entity_id="3",
        title="C", subtitle=None, href="/", rank=0.5,
        activity_at=None, indexed_at="2026-05-06",
    )
    grouped = ss.group_hits([a, b, c])
    assert list(grouped.keys()) == ["Accounts", "Researched Prospects"]
    assert grouped["Accounts"] == [a, b]
    assert grouped["Researched Prospects"] == [c]


def test_all_entity_types_have_group_labels():
    """No silent missing labels — every entity_type the indexer can
    produce has a UI group."""
    for et in ss.ALL_ENTITY_TYPES:
        assert et in ss.ENTITY_GROUP_LABEL, f"missing label for {et}"
