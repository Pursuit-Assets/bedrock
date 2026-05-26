"""Phase 0.9 — canonical source of Salesforce Opportunity stage values.

Eight independent locations in the codebase carry stage strings literally:

  * ``models.py:OpportunityStage`` enum
  * ``frontend-v2/src/lib/stages.ts``
  * ``frontend-v2/src/lib/funnelStages.ts``
  * ``frontend-v2/src/components/StageProgression.tsx``
  * ``frontend-v2/src/pages/Cleanup.tsx``
  * ``services/crm_parser.py``
  * ``routes/opportunities_extra.py:53`` (prior_stage default)
  * ``services/awards_service.ELIGIBLE_STAGES_BY_RECORD_TYPE``

Every time SF renames a picklist value (commit ``58c360e`` did three
at once), all eight need hand-edits. This module is the single read
API everything migrates to.

Invariants the F1 stage-buckets PR #134 (and ``feedback_sf_stages_sacred``)
encode and this module preserves:

  * SF stages are sacred — never hide / deprecate / reclassify them.
  * Reporting buckets layer ON TOP of stages, never replace them.
  * Buckets are ``Set[str]`` lookups, not switch statements over a
    static enum — code that does ``if stage in REVENUE_EARNING_STAGES``
    keeps working when SF adds a new stage without a code change.

This module reads from ``bedrock.sf_picklist_cache`` (populated by a
nightly background job calling ``Salesforce.describeSObject``). The
cache has 24h TTL. Live SF picklist read is the fallback when the
cache is empty or stale.

This file does NOT yet replace the eight call-sites. That migration
lands in Layer 1, after the picklist refresh job exists. For now the
module exposes the read API and a static fallback table that mirrors
``models.OpportunityStage`` so callers can swap incrementally.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Static fallback — mirrors models.OpportunityStage as of 2026-05-06.
# ---------------------------------------------------------------------------
# Used when bedrock.sf_picklist_cache is empty (fresh deploy, or SF
# picklist refresh job hasn't run yet). Matches the renamed labels
# from commit 58c360e ("rename SF stages to match new picklist labels").
#
# This is the LAST line of defense — production should always serve
# from the cache. If you find yourself editing this list, the picklist
# refresh job is probably broken.
# ---------------------------------------------------------------------------

_STATIC_FALLBACK_STAGES_BY_RECORD_TYPE: dict[str, tuple[str, ...]] = {
    "Philanthropy": (
        "Lead Gen",
        "New Lead",
        "Qualifying",
        "Ask in Progress",
        "Proposal Submitted",
        "Verbal Commitment",
        "Contract Creation",
        "Contracting",
        "Contract Signed",
        "Closed / Fulfilled",
        "Closed Won",
        "Closed Lost",
        "Withdrawn",
    ),
}

# Per-record-type entry stage. The "promote a prospect to an Opp" wedge
# in Phase B3 of the overhaul plan creates Opps at this stage.
ENTRY_STAGE_BY_RECORD_TYPE: dict[str, str] = {
    "Philanthropy": "New Lead",
}

# ---------------------------------------------------------------------------
# Reporting buckets. Set[str] semantics — code that says
# `if stage in REVENUE_EARNING_STAGES:` keeps working when SF adds a
# new stage that the picklist refresh job classifies into the bucket.
# ---------------------------------------------------------------------------

REVENUE_EARNING_STAGES: frozenset[str] = frozenset({
    "Closed / Fulfilled",
    "Closed Won",
})

OPEN_PIPELINE_STAGES: frozenset[str] = frozenset({
    "Lead Gen",
    "New Lead",
    "Qualifying",
    "Ask in Progress",
    "Proposal Submitted",
    "Verbal Commitment",
    "Contract Creation",
    "Contracting",
    "Contract Signed",
})

CLOSED_STAGES: frozenset[str] = frozenset({
    "Closed / Fulfilled",
    "Closed Won",
    "Closed Lost",
    "Withdrawn",
})

LOST_STAGES: frozenset[str] = frozenset({
    "Closed Lost",
    "Withdrawn",
})


# ---------------------------------------------------------------------------
# Cache module — process-local 24h read-through over
# bedrock.sf_picklist_cache. Refresh happens via a separate background
# job (Layer 1) that writes to the table directly.
# ---------------------------------------------------------------------------

_DEFAULT_TTL_SECONDS = int(os.getenv("SF_STAGES_CACHE_TTL_SECONDS", "300"))


@dataclass
class _StageCacheEntry:
    fetched_at: float
    stages: tuple[str, ...]
    ttl_seconds: int = _DEFAULT_TTL_SECONDS

    @property
    def is_fresh(self) -> bool:
        return (time.time() - self.fetched_at) < self.ttl_seconds


@dataclass
class _StageCache:
    by_record_type: dict[str, _StageCacheEntry] = field(default_factory=dict)

    def get(self, record_type: str) -> Optional[tuple[str, ...]]:
        entry = self.by_record_type.get(record_type)
        if entry and entry.is_fresh:
            return entry.stages
        return None

    def set(self, record_type: str, stages: tuple[str, ...]) -> None:
        self.by_record_type[record_type] = _StageCacheEntry(
            fetched_at=time.time(), stages=stages,
        )

    def clear(self) -> None:
        self.by_record_type.clear()


_cache = _StageCache()


# ---------------------------------------------------------------------------
# Read API
# ---------------------------------------------------------------------------

async def get_stages(
    record_type: str = "Philanthropy",
    *,
    db_conn=None,
) -> tuple[str, ...]:
    """Return the canonical, ordered stage list for a record type.

    Read order:
        1. Process-local cache (fresh ≤ TTL).
        2. ``bedrock.sf_picklist_cache`` row.
        3. Static fallback (this module).

    ``db_conn`` should be an asyncpg connection. If ``None``, skips the
    DB step and uses the static fallback. Tests pass ``db_conn=None``
    to exercise the static path; production passes the request-scoped
    DB connection.
    """
    cached = _cache.get(record_type)
    if cached is not None:
        return cached

    if db_conn is not None:
        try:
            stages = await _fetch_from_db(db_conn, record_type)
            if stages:
                _cache.set(record_type, stages)
                return stages
        except Exception as e:
            logger.warning(
                "sf_stages: DB cache read failed for %s, falling back to static: %s",
                record_type, e,
            )

    stages = _STATIC_FALLBACK_STAGES_BY_RECORD_TYPE.get(record_type, ())
    if stages:
        _cache.set(record_type, stages)
    return stages


async def get_entry_stage(record_type: str = "Philanthropy") -> Optional[str]:
    """Return the canonical entry-stage name for new opps of a record type.
    None if the record type is not configured for promotion.
    """
    return ENTRY_STAGE_BY_RECORD_TYPE.get(record_type)


def is_revenue_earning(stage: str) -> bool:
    return stage in REVENUE_EARNING_STAGES


def is_open(stage: str) -> bool:
    return stage in OPEN_PIPELINE_STAGES


def is_closed(stage: str) -> bool:
    return stage in CLOSED_STAGES


def is_lost(stage: str) -> bool:
    return stage in LOST_STAGES


def clear_cache() -> None:
    """Drop the process-local cache. Used by tests and by the
    picklist-refresh background job after writing fresh rows.
    """
    _cache.clear()


# ---------------------------------------------------------------------------
# Internal — DB read
# ---------------------------------------------------------------------------

async def _fetch_from_db(db_conn, record_type: str) -> tuple[str, ...]:
    """Read sorted active stages from bedrock.sf_picklist_cache.

    Falls through (returns empty tuple) when:
      * Table doesn't exist yet (fresh deploy pre-migration).
      * No rows for the record type (refresh job hasn't run).
      * All rows are stale (`refresh_after < now()`).
    """
    rows = await db_conn.fetch(
        """
        SELECT value
        FROM bedrock.sf_picklist_cache
        WHERE sf_object = 'Opportunity'
          AND field_name = 'StageName'
          AND (record_type = $1 OR record_type IS NULL)
          AND is_active = TRUE
          AND refresh_after > now()
        ORDER BY sort_order ASC, value ASC
        """,
        record_type,
    )
    return tuple(r["value"] for r in rows)
