"""Search service — read API for ``bedrock.search_doc``.

Phase 1.8 of the Pebble 1.0 plan. The service that ``routes/search.py``
calls. Owns the permission-filter SQL composition, ranking math, and
response shaping. Pebble's ``search_crm`` tool calls the same service
via the route, so there's one canonical read path no matter who the
caller is.

Key design choices (argued in tasks/pebble-search-spec-backend.md):

  * Permission filter is **pre-filter** in SQL, never post-filter in
    Python. The DB enforces row-level visibility.
  * Ranking is ``ts_rank_cd * recency_decay`` so the half-life can be
    tuned without reindexing.
  * Result rows are denormalized — the API never JOINs back to source
    tables on the read path. The indexer's job is to compose the
    ``title / subtitle / search_text`` projection at write time.
  * Multi-tenant ``org_id`` is the OUTERMOST WHERE predicate. CI grep
    enforces this; tests assert it as well.
  * Service callers (Pebble, ``is_service=True``) carry an
    ``originating_user_email`` and the filter resolves against THAT
    user's permissions. Pebble is delegated, never god-principal.

The service is deliberately tiny so it stays testable. The route
layer adds rate-limiting, audit emission, and response packaging
on top.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Sequence
from uuid import UUID, uuid4

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

# Every entity_type the indexer is expected to populate. The CHECK
# constraint on bedrock.search_doc.entity_type carries the same list;
# they must stay in sync.
ALL_ENTITY_TYPES: tuple[str, ...] = (
    "sf_account", "sf_contact", "sf_opportunity", "sf_task", "sf_activity",
    "bedrock_project", "bedrock_award", "bedrock_saved_view",
    "pebble_profile", "pebble_chat_conversation", "pebble_batch",
)

# UI grouping. Maps the storage entity_type → display group so the
# frontend can group without a second lookup.
ENTITY_GROUP_LABEL: dict[str, str] = {
    "sf_account": "Accounts",
    "sf_contact": "Contacts",
    "sf_opportunity": "Opportunities",
    "sf_task": "Tasks",
    "sf_activity": "Activities",
    "bedrock_project": "Projects",
    "bedrock_award": "Awards",
    "bedrock_saved_view": "Saved Views",
    "pebble_profile": "Researched Prospects",
    "pebble_chat_conversation": "Pebble Conversations",
    "pebble_batch": "Pebble Batches",
}

# Entity types whose visibility = 'org' overrides ownership filtering.
# Per the security spec: SF Accounts and Contacts are org-visible by
# default; Opps / Tasks / Activities follow ownership.
ORG_VISIBLE_ENTITY_TYPES: frozenset[str] = frozenset({
    "sf_account", "sf_contact",
})

# Default per-query result cap. Hard-capped at 100 to bound memory +
# transit. Frontend defaults to 8 per group.
DEFAULT_LIMIT = 25
MAX_LIMIT = 100

# Recency half-life in days. ts_rank_cd × exp(-Δseconds / SECONDS_PER_HALFLIFE).
RECENCY_HALFLIFE_DAYS = 30
_SECONDS_PER_HALFLIFE = 86400 * RECENCY_HALFLIFE_DAYS


# ---------------------------------------------------------------------------
# Caller identity
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SearchPrincipal:
    """The effective principal whose permissions filter the search.

    For a JWT-authenticated user this is the user themself. For a
    service caller (Pebble) this is the *originating user* — Pebble
    is the bearer but the human is the principal whose visibility
    rules apply.
    """
    email: str
    sf_user_id: Optional[str]
    is_admin: bool
    has_view_all_accounts: bool
    has_view_all_opportunities: bool
    has_view_all_contacts: bool
    org_id: str = "pursuit"

    @property
    def can_see_everything(self) -> bool:
        return self.is_admin or all((
            self.has_view_all_accounts,
            self.has_view_all_opportunities,
            self.has_view_all_contacts,
        ))


async def resolve_principal(
    db_conn,
    user: dict[str, Any],
) -> SearchPrincipal:
    """Resolve the SearchPrincipal from the user dict produced by
    ``require_auth_or_internal``.

    For service callers (``is_service=True``) we use
    ``originating_user_email`` — Pebble acts on behalf of, never as
    itself, on the read side. Auth dependency already rejects service
    calls without that header (Phase 0.2).
    """
    if user.get("is_service"):
        email = user.get("originating_user_email")
        if not email:
            raise ValueError(
                "Service caller missing originating_user_email — "
                "auth.require_auth_or_internal should have rejected this."
            )
    else:
        email = user.get("email")
        if not email:
            raise ValueError("User dict missing email")

    row = await db_conn.fetchrow(
        """
        SELECT
            u.email,
            u.sf_user_id,
            (pp.permissions ->> 'manage_users_roles')::boolean
                AS is_admin,
            COALESCE(
                (pp.permissions ->> 'edit_all_opportunities')::boolean,
                FALSE
            ) AS has_view_all_opportunities,
            COALESCE(
                (pp.permissions ->> 'edit_accounts')::boolean,
                FALSE
            ) AS has_view_all_accounts,
            COALESCE(
                (pp.permissions ->> 'edit_contacts')::boolean,
                FALSE
            ) AS has_view_all_contacts,
            COALESCE(u.org_id, 'pursuit') AS org_id
        FROM bedrock.org_users u
        LEFT JOIN bedrock.permission_profiles pp
            ON u.permission_profile_id = pp.id
        WHERE u.email = $1
        """,
        email,
    )
    if not row:
        # User not in org_users — locked out of search by default.
        # Service callers spoofing a non-existent user land here.
        return SearchPrincipal(
            email=email,
            sf_user_id=None,
            is_admin=False,
            has_view_all_accounts=False,
            has_view_all_opportunities=False,
            has_view_all_contacts=False,
        )
    return SearchPrincipal(
        email=row["email"],
        sf_user_id=row["sf_user_id"],
        is_admin=bool(row["is_admin"]),
        has_view_all_accounts=bool(row["has_view_all_accounts"]),
        has_view_all_opportunities=bool(row["has_view_all_opportunities"]),
        has_view_all_contacts=bool(row["has_view_all_contacts"]),
        org_id=row["org_id"] or "pursuit",
    )


# ---------------------------------------------------------------------------
# Search request + response
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SearchRequest:
    query: str
    types: Optional[Sequence[str]] = None     # None = all entity types
    limit: int = DEFAULT_LIMIT
    org_id: str = "pursuit"

    def normalized_types(self) -> tuple[str, ...]:
        if not self.types:
            return ALL_ENTITY_TYPES
        invalid = [t for t in self.types if t not in ALL_ENTITY_TYPES]
        if invalid:
            raise ValueError(f"Unknown entity_type(s): {invalid}")
        return tuple(self.types)

    def normalized_limit(self) -> int:
        if self.limit < 1:
            return DEFAULT_LIMIT
        return min(self.limit, MAX_LIMIT)


@dataclass(frozen=True)
class SearchHit:
    entity_type: str
    entity_id: str
    title: str
    subtitle: Optional[str]
    href: str
    rank: float
    activity_at: Optional[str]      # ISO8601 string for JSON
    indexed_at: str                  # ISO8601 string for JSON

    @property
    def group(self) -> str:
        return ENTITY_GROUP_LABEL.get(self.entity_type, self.entity_type)


@dataclass
class SearchResponse:
    query_id: UUID
    items: list[SearchHit] = field(default_factory=list)
    total_count_redacted: int = 0
    backend_used: str = "postgres_fts"
    took_ms: int = 0


# ---------------------------------------------------------------------------
# Permission filter SQL composition
# ---------------------------------------------------------------------------

def _compose_permission_predicate(
    principal: SearchPrincipal,
    *,
    sql_param_offset: int,
) -> tuple[str, list[Any]]:
    """Return (where_clause, params) appended after the existing query
    builder. Composes the OR-chain that defines record-level visibility.

    ``sql_param_offset`` is the count of $-params already used by the
    query builder, so the placeholders here line up.
    """
    # Admin / "view all" callers see everything in their org. We still
    # filter on org_id, which is the multi-tenant outermost guard.
    if principal.can_see_everything:
        params = [principal.org_id]
        return (f"org_id = ${sql_param_offset + 1}", params)

    clauses: list[str] = []
    params: list[Any] = []
    pi = sql_param_offset

    # 1. Multi-tenant outer guard. ALWAYS first.
    pi += 1
    clauses.append(f"org_id = ${pi}")
    params.append(principal.org_id)

    # Inner OR group — at least one must match.
    or_clauses: list[str] = []

    # 2a. Org-visible entity types (Accounts, Contacts).
    org_visible_list = ", ".join(f"'{t}'" for t in sorted(ORG_VISIBLE_ENTITY_TYPES))
    or_clauses.append(
        f"(entity_type IN ({org_visible_list}) AND visibility = 'org')"
    )

    # 2b. Owned-by-this-user via SF user id (SF-mirrored entities).
    if principal.sf_user_id:
        pi += 1
        or_clauses.append(f"owner_sf_id = ${pi}")
        params.append(principal.sf_user_id)

    # 2c. Owned-by-this-user via email (Bedrock-native entities).
    pi += 1
    or_clauses.append(f"owner_email = ${pi}")
    params.append(principal.email)

    # 2d. View-all overrides for specific entity types.
    if principal.has_view_all_opportunities:
        or_clauses.append("entity_type = 'sf_opportunity'")
    if principal.has_view_all_contacts:
        or_clauses.append("entity_type = 'sf_contact'")
    if principal.has_view_all_accounts:
        or_clauses.append("entity_type = 'sf_account'")

    clauses.append("(" + " OR ".join(or_clauses) + ")")

    return (" AND ".join(clauses), params)


# ---------------------------------------------------------------------------
# Public read API
# ---------------------------------------------------------------------------

def query_text_hash(query: str) -> str:
    """sha256 of the canonical query text. Used as the dashboard join
    key and in the audit-log row.
    """
    return hashlib.sha256(query.strip().lower().encode("utf-8")).hexdigest()


async def search(
    db_conn,
    principal: SearchPrincipal,
    req: SearchRequest,
) -> SearchResponse:
    """Run a Find search and return the top-K hits.

    Composes:
        SELECT entity_type, entity_id, title, subtitle, href,
               ts_rank_cd(...) * recency_decay AS rank,
               activity_at, indexed_at
        FROM bedrock.search_doc, websearch_to_tsquery('english', $q) AS q
        WHERE search_vector @@ q
          AND deleted_at IS NULL
          AND entity_type = ANY($types)
          AND <permission predicate>
        ORDER BY rank DESC
        LIMIT $limit
    """
    started = time.perf_counter()

    types = req.normalized_types()
    limit = req.normalized_limit()
    query_text = req.query.strip()

    if not query_text:
        return SearchResponse(query_id=uuid4(), backend_used="cache_hit")

    # Build the permission predicate first so we know how many params it
    # consumes before we lay out the rest.
    base_params: list[Any] = [query_text, list(types)]   # $1, $2
    perm_clause, perm_params = _compose_permission_predicate(
        principal, sql_param_offset=len(base_params),
    )
    limit_param_idx = len(base_params) + len(perm_params) + 1

    sql = f"""
        WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
        SELECT
            entity_type,
            entity_id,
            title,
            subtitle,
            href,
            ts_rank_cd(search_vector, q.tsq) *
                exp(-EXTRACT(epoch FROM (now() - COALESCE(activity_at, indexed_at)))
                    / {_SECONDS_PER_HALFLIFE}::float8)
                AS rank,
            activity_at,
            indexed_at
        FROM bedrock.search_doc, q
        WHERE search_vector @@ q.tsq
          AND deleted_at IS NULL
          AND entity_type = ANY($2)
          AND {perm_clause}
        ORDER BY rank DESC
        LIMIT ${limit_param_idx}
    """

    params: list[Any] = base_params + perm_params + [limit]
    rows = await db_conn.fetch(sql, *params)

    items = [
        SearchHit(
            entity_type=r["entity_type"],
            entity_id=r["entity_id"],
            title=r["title"],
            subtitle=r["subtitle"],
            href=r["href"],
            rank=float(r["rank"]),
            activity_at=r["activity_at"].isoformat() if r["activity_at"] else None,
            indexed_at=r["indexed_at"].isoformat(),
        )
        for r in rows
    ]
    took_ms = int((time.perf_counter() - started) * 1000)

    return SearchResponse(
        query_id=uuid4(),
        items=items,
        total_count_redacted=len(items),    # count-after-redaction
        backend_used="postgres_fts",
        took_ms=took_ms,
    )


# ---------------------------------------------------------------------------
# Helpers exposed for the route layer + tests
# ---------------------------------------------------------------------------

def group_hits(hits: Iterable[SearchHit]) -> dict[str, list[SearchHit]]:
    """Bucket hits by their UI group label, preserving rank order."""
    out: dict[str, list[SearchHit]] = {}
    for hit in hits:
        out.setdefault(hit.group, []).append(hit)
    return out
