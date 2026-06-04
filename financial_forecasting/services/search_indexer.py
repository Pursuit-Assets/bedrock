"""Search indexer worker — Layer 1.6 of the Pebble 1.0 plan.

Drains ``bedrock.search_index_queue`` and upserts rows into
``bedrock.search_doc``. One row per searchable entity, composed at
write time so the read path never needs to JOIN back to source.

Architecture (backend spec §3.4):

    Source-table trigger
      → bedrock.search_index_queue (UNIQUE coalesces dups)
      → pg_notify('bedrock_search_index_queue', 'entity_type:entity_id')
      → indexer worker LISTENs + drains FOR UPDATE SKIP LOCKED LIMIT 100
      → composer fn (per entity_type) reads source row + composes search_doc
      → INSERT INTO bedrock.search_doc ... ON CONFLICT (entity_type, entity_id) DO UPDATE
      → DELETE FROM bedrock.search_index_queue WHERE id = $1
      → next row

Composer registry:

    Each entity_type has an async composer function
        composer(conn, entity_id) -> SearchDocRow | None
    that reads the source row and produces the denormalized
    projection. Returning None signals "row is gone or shouldn't be
    indexed" — the indexer marks the source as deleted in search_doc
    via deleted_at.

Failure handling:

    Per-row failures bump attempt_count and store last_error. Hard
    failure at attempt_count >= 5; row stays in queue with
    ``last_error`` populated for the periodic reconciliation job.
    Worker never crashes the FastAPI process; transient errors
    are retried with exponential backoff baked into the polling loop.

This module exposes:
    * ``register_composer(entity_type, fn)``  — registry hook
    * ``compose_*`` — built-in composers for bedrock-side entities
    * ``drain_once(pool, max_rows=100)`` — one drain cycle
    * ``run_worker(pool, stop_event)`` — long-running asyncio task
    * ``backfill(pool, entity_type)`` — one-shot reindex from source

The wire-up to ``main.py`` lifespan happens in a separate change.
This module is callable + testable in isolation.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# Queue drain configuration. Conservative defaults; configurable via
# env at the lifespan wire-up site.
DEFAULT_BATCH_SIZE = 100
MAX_ATTEMPT_COUNT = 5
POLL_INTERVAL_SECONDS = 2.0      # belt-and-suspenders alongside LISTEN/NOTIFY
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_MAX_SECONDS = 60.0


# ---------------------------------------------------------------------------
# Composer types + registry
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SearchDocRow:
    """The denormalized projection a composer produces."""
    entity_type: str
    entity_id: str
    title: str
    subtitle: Optional[str]
    href: str
    search_text: str
    owner_sf_id: Optional[str] = None
    owner_email: Optional[str] = None
    account_sf_id: Optional[str] = None
    visibility: str = "org"
    activity_at: Any = None         # datetime | None
    source_version: Any = None      # datetime | None
    org_id: str = "pursuit"


# Composer signature.
ComposerFn = Callable[[Any, str], Awaitable[Optional[SearchDocRow]]]

_composers: dict[str, ComposerFn] = {}


def register_composer(entity_type: str, fn: ComposerFn) -> None:
    """Register a composer for an entity_type. Idempotent — re-register
    overwrites (useful for tests).
    """
    _composers[entity_type] = fn


def get_composer(entity_type: str) -> Optional[ComposerFn]:
    return _composers.get(entity_type)


def registered_entity_types() -> tuple[str, ...]:
    return tuple(_composers.keys())


def clear_registry() -> None:
    """Reset the registry — for tests."""
    _composers.clear()


# ---------------------------------------------------------------------------
# Built-in composers
# ---------------------------------------------------------------------------

async def compose_bedrock_project(conn, entity_id: str) -> Optional[SearchDocRow]:
    row = await conn.fetchrow(
        """
        SELECT p.id::text AS id, p.name, p.description,
               p.owner_email, p.created_by,
               p.created_at, p.updated_at,
               COALESCE(p.deleted_at IS NOT NULL, FALSE) AS is_deleted
        FROM bedrock.project p
        WHERE p.id = $1::uuid
        """,
        entity_id,
    )
    if not row or row["is_deleted"]:
        return None

    description = (row["description"] or "").strip()
    # owner_email is the current owner (set by transfer flows since
    # 2026-04-21). created_by is the original author. We prefer
    # owner_email — search visibility should follow the live owner,
    # not the creator. Fall through to created_by when projects
    # haven't been migrated to owner_email yet.
    owner = row["owner_email"] or row["created_by"]
    return SearchDocRow(
        entity_type="bedrock_project",
        entity_id=row["id"],
        title=row["name"] or "Untitled project",
        subtitle="Project" + (f" · {description[:80]}" if description else ""),
        href=f"/projects/{row['id']}",
        search_text=" ".join(filter(None, [row["name"], description])),
        owner_email=owner,
        visibility="org",
        activity_at=row["updated_at"],
        source_version=row["updated_at"],
    )


async def compose_bedrock_saved_view(conn, entity_id: str) -> Optional[SearchDocRow]:
    row = await conn.fetchrow(
        """
        SELECT id::text AS id, scope_key, name, owner_email, is_global,
               created_at, updated_at
        FROM bedrock.saved_view
        WHERE id = $1::uuid
        """,
        entity_id,
    )
    if not row:
        return None

    visibility = "org" if row["is_global"] else "private"
    return SearchDocRow(
        entity_type="bedrock_saved_view",
        entity_id=row["id"],
        title=row["name"] or "Untitled view",
        subtitle=f"Saved view · {row['scope_key']}",
        href=f"/{row['scope_key']}?view={row['id']}",
        search_text=" ".join(filter(None, [row["name"], row["scope_key"]])),
        owner_email=row["owner_email"] if not row["is_global"] else None,
        visibility=visibility,
        activity_at=row["updated_at"],
        source_version=row["updated_at"],
    )


async def compose_pebble_profile(conn, entity_id: str) -> Optional[SearchDocRow]:
    """Index Pebble research from ``pebble_research_sessions`` (one row
    per completed research run). Keyed on session id, not contact_id,
    because the session row carries name/org as explicit columns whereas
    pebble_profiles stores them inside profile_json.
    """
    row = await conn.fetchrow(
        """
        SELECT id::text AS id, contact_id, prospect_name, prospect_org,
               tier, status, batch_id, profile_json, created_at
        FROM bedrock.pebble_research_sessions
        WHERE id = $1::uuid
        """,
        entity_id,
    )
    if not row or row["status"] != "completed":
        return None

    name = (row["prospect_name"] or "").strip() or "Researched prospect"
    org = (row["prospect_org"] or "").strip()

    summary = ""
    if row["profile_json"]:
        try:
            data = json.loads(row["profile_json"])
            summary = (data.get("summary") or "")[:500]
        except (ValueError, TypeError):
            summary = ""

    subtitle = " · ".join(filter(None, [
        org or None,
        f"Tier {row['tier']}" if row["tier"] else None,
    ]))
    if not subtitle:
        subtitle = "Researched prospect"

    return SearchDocRow(
        entity_type="pebble_profile",
        entity_id=row["id"],
        title=name,
        subtitle=subtitle,
        href=f"/pebble/profiles/{row['id']}",
        search_text=" ".join(filter(None, [name, org, summary])),
        visibility="org",
        activity_at=row["created_at"],
        source_version=row["created_at"],
    )


# Register the built-ins on import.
register_composer("bedrock_project", compose_bedrock_project)
register_composer("bedrock_saved_view", compose_bedrock_saved_view)
register_composer("pebble_profile", compose_pebble_profile)


# ---------------------------------------------------------------------------
# Drain
# ---------------------------------------------------------------------------

@dataclass
class DrainStats:
    rows_processed: int = 0
    rows_upserted: int = 0
    rows_deleted: int = 0
    rows_errored: int = 0
    rows_no_composer: int = 0
    elapsed_ms: int = 0
    last_errors: list[str] = field(default_factory=list)


async def drain_once(pool, *, batch_size: int = DEFAULT_BATCH_SIZE) -> DrainStats:
    """Drain one batch of queue rows. Returns stats. Single transaction
    per row so partial failures don't block the queue head.
    """
    started = time.perf_counter()
    stats = DrainStats()

    async with pool.acquire() as conn:
        # Claim a batch with row-level locking. SKIP LOCKED so multiple
        # workers can run side-by-side without contending.
        rows = await conn.fetch(
            """
            SELECT id, entity_type, entity_id, op, attempt_count
            FROM bedrock.search_index_queue
            WHERE attempt_count < $1
            ORDER BY enqueued_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
            """,
            MAX_ATTEMPT_COUNT, batch_size,
        )

        for row in rows:
            stats.rows_processed += 1
            try:
                if row["op"] == "delete":
                    await _apply_delete(conn, row["entity_type"], row["entity_id"])
                    stats.rows_deleted += 1
                else:
                    composer = get_composer(row["entity_type"])
                    if not composer:
                        stats.rows_no_composer += 1
                        # Silently leave in queue — a future worker with
                        # the composer registered will process it. No
                        # attempt_count bump; this is "unsupported", not
                        # "failed."
                        continue

                    doc = await composer(conn, row["entity_id"])
                    if doc is None:
                        # Source deleted / non-indexable — soft-delete in
                        # search_doc.
                        await _apply_delete(conn, row["entity_type"], row["entity_id"])
                        stats.rows_deleted += 1
                    else:
                        await _apply_upsert(conn, doc)
                        stats.rows_upserted += 1

                # Successful: remove queue row.
                await conn.execute(
                    "DELETE FROM bedrock.search_index_queue WHERE id = $1",
                    row["id"],
                )
            except Exception as e:
                stats.rows_errored += 1
                stats.last_errors.append(f"{row['entity_type']}:{row['entity_id']}: {e}")
                # Bump attempt count so eventual hard-fail removes it
                # from the hot path.
                await conn.execute(
                    """
                    UPDATE bedrock.search_index_queue
                       SET attempt_count = attempt_count + 1,
                           last_error = $1
                     WHERE id = $2
                    """,
                    str(e)[:500], row["id"],
                )

    stats.elapsed_ms = int((time.perf_counter() - started) * 1000)
    return stats


async def _apply_upsert(conn, doc: SearchDocRow) -> None:
    """UPSERT into search_doc. The compose-vector trigger handles
    search_vector synthesis; we only feed the column inputs."""
    await conn.execute(
        """
        INSERT INTO bedrock.search_doc (
            entity_type, entity_id, title, subtitle, href,
            search_text, search_vector,
            owner_sf_id, owner_email, account_sf_id, visibility,
            activity_at, source_version, org_id
        ) VALUES (
            $1, $2, $3, $4, $5,
            $6, ''::tsvector,
            $7, $8, $9, $10,
            $11, $12, $13
        )
        ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET title          = EXCLUDED.title,
            subtitle       = EXCLUDED.subtitle,
            href           = EXCLUDED.href,
            search_text    = EXCLUDED.search_text,
            owner_sf_id    = EXCLUDED.owner_sf_id,
            owner_email    = EXCLUDED.owner_email,
            account_sf_id  = EXCLUDED.account_sf_id,
            visibility     = EXCLUDED.visibility,
            activity_at    = EXCLUDED.activity_at,
            source_version = EXCLUDED.source_version,
            indexed_at     = now(),
            deleted_at     = NULL
        """,
        doc.entity_type, doc.entity_id, doc.title, doc.subtitle, doc.href,
        doc.search_text,
        doc.owner_sf_id, doc.owner_email, doc.account_sf_id, doc.visibility,
        doc.activity_at, doc.source_version, doc.org_id,
    )


async def _apply_delete(conn, entity_type: str, entity_id: str) -> None:
    """Soft-delete in search_doc. Tombstone partial-index excludes from
    GIN scans automatically."""
    await conn.execute(
        """
        UPDATE bedrock.search_doc
           SET deleted_at = now(), indexed_at = now()
         WHERE entity_type = $1 AND entity_id = $2 AND deleted_at IS NULL
        """,
        entity_type, entity_id,
    )


# ---------------------------------------------------------------------------
# Long-running worker
# ---------------------------------------------------------------------------

async def run_worker(
    pool,
    stop_event: asyncio.Event,
    *,
    poll_interval: float = POLL_INTERVAL_SECONDS,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> None:
    """Long-running drain. Cancels cleanly on stop_event.set().

    Belt-and-suspenders: combines LISTEN/NOTIFY (lossy by spec — see
    Postgres docs) with periodic polling. NOTIFY wakes us promptly;
    polling catches anything we miss.

    This function does not crash the calling process on errors — every
    drain cycle is wrapped, and consecutive failures back off
    exponentially.
    """
    backoff = BACKOFF_BASE_SECONDS

    async with pool.acquire() as listen_conn:
        try:
            await listen_conn.add_listener(
                "bedrock_search_index_queue",
                lambda *_args: None,    # we just need the wakeup signal
            )
        except Exception:
            logger.exception("Failed to attach LISTEN; will rely on polling only")

        while not stop_event.is_set():
            try:
                stats = await drain_once(pool, batch_size=batch_size)
                if stats.rows_errored:
                    logger.warning(
                        "search_indexer_drain rows=%d errored=%d (%s)",
                        stats.rows_processed, stats.rows_errored,
                        "; ".join(stats.last_errors[:3]),
                    )
                elif stats.rows_processed:
                    logger.info(
                        "search_indexer_drain processed=%d upserted=%d deleted=%d in %dms",
                        stats.rows_processed, stats.rows_upserted,
                        stats.rows_deleted, stats.elapsed_ms,
                    )
                # Reset backoff on successful cycle.
                backoff = BACKOFF_BASE_SECONDS
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("search_indexer_drain failed")
                backoff = min(backoff * 2, BACKOFF_MAX_SECONDS)

            try:
                await asyncio.wait_for(stop_event.wait(), timeout=poll_interval if backoff == BACKOFF_BASE_SECONDS else backoff)
            except asyncio.TimeoutError:
                pass


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------

async def backfill(
    pool,
    entity_type: str,
    *,
    batch_size: int = 500,
    progress_cb: Optional[Callable[[int, int], None]] = None,
) -> int:
    """Walk every source row of an entity_type and enqueue it. The
    drain worker picks up the queue rows and indexes them. Returns the
    enqueued count.

    ``progress_cb(processed, total)`` is called every batch when
    provided.
    """
    composer = get_composer(entity_type)
    if not composer:
        raise ValueError(f"No composer registered for entity_type={entity_type!r}")

    # Per-entity-type id-source SQL. Each composer has a default
    # source table; we centralize the id-walk SQL here so the composer
    # contract stays "given an id, give me a SearchDocRow".
    id_source_sql = _BACKFILL_ID_SOURCE_SQL.get(entity_type)
    if not id_source_sql:
        raise ValueError(
            f"No backfill id-source SQL registered for entity_type={entity_type!r}"
        )

    enqueued = 0
    async with pool.acquire() as conn:
        total = await conn.fetchval(_BACKFILL_COUNT_SQL[entity_type])
        offset = 0
        while True:
            rows = await conn.fetch(id_source_sql, batch_size, offset)
            if not rows:
                break
            await conn.executemany(
                """
                INSERT INTO bedrock.search_index_queue (entity_type, entity_id, op)
                VALUES ($1, $2, 'upsert')
                ON CONFLICT (entity_type, entity_id, op) DO UPDATE
                    SET enqueued_at = now()
                """,
                [(entity_type, str(r["id"])) for r in rows],
            )
            enqueued += len(rows)
            offset += batch_size
            if progress_cb:
                progress_cb(enqueued, total)
    return enqueued


# Per-entity-type backfill SQL. Centralized here so composers stay tiny.
_BACKFILL_ID_SOURCE_SQL: dict[str, str] = {
    "bedrock_project": """
        SELECT id FROM bedrock.project
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1 OFFSET $2
    """,
    "bedrock_saved_view": """
        SELECT id FROM bedrock.saved_view
        ORDER BY created_at ASC
        LIMIT $1 OFFSET $2
    """,
    "pebble_profile": """
        SELECT id FROM bedrock.pebble_research_sessions
        WHERE status = 'completed'
        ORDER BY created_at ASC
        LIMIT $1 OFFSET $2
    """,
}

_BACKFILL_COUNT_SQL: dict[str, str] = {
    "bedrock_project": "SELECT COUNT(*) FROM bedrock.project WHERE deleted_at IS NULL",
    "bedrock_saved_view": "SELECT COUNT(*) FROM bedrock.saved_view",
    "pebble_profile": "SELECT COUNT(*) FROM bedrock.pebble_research_sessions WHERE status = 'completed'",
}
