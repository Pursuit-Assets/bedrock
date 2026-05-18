"""PostgreSQL storage for Pebble (asyncpg).

Migrated from SQLite in M11. Tables are managed by Bedrock's init.sql
in the bedrock schema with pebble_ prefix. This module only reads/writes.

Pool-level codecs convert UUID→str and NUMERIC→float automatically so
callers never deal with uuid.UUID or Decimal objects.
"""

import json
import logging
import os
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg

logger = logging.getLogger(__name__)

_pool: asyncpg.Pool | None = None


# ---------------------------------------------------------------------------
# Pool management
# ---------------------------------------------------------------------------

async def _init_connection(conn: asyncpg.Connection) -> None:
    """Pool-level codecs registered on every new connection.

    UUID→str:   Pebble convention — all IDs are str(uuid4()).
    NUMERIC→float: Pebble cost values are simple floats, not Decimal.
    """
    await conn.set_type_codec(
        "uuid", encoder=str, decoder=str,
        schema="pg_catalog", format="text",
    )
    await conn.set_type_codec(
        "numeric", encoder=str, decoder=float,
        schema="pg_catalog", format="text",
    )


async def init_db() -> None:
    """Create asyncpg connection pool.

    Tables are managed by Bedrock's init.sql — NOT created here.
    Verifies that the expected pebble tables exist as a health check.
    """
    global _pool
    database_url = os.getenv(
        "DATABASE_URL", "postgresql://bedrock@localhost:5432/bedrock",
    )
    _pool = await asyncpg.create_pool(
        database_url, min_size=2, max_size=5, init=_init_connection,
    )
    async with _pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM pg_tables "
            "WHERE schemaname = 'bedrock' AND tablename LIKE 'pebble_%'",
        )
        if count < 12:
            logger.warning(
                "Expected 12+ pebble tables, found %d. Run Bedrock init.sql.",
                count,
            )
        else:
            logger.info("Pebble storage connected — %d tables verified", count)


async def close_db() -> None:
    """Gracefully close the connection pool on shutdown."""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    """Return the connection pool.  Raises if init_db() was not called."""
    if _pool is None:
        raise RuntimeError(
            "Pebble DB pool not initialized — call init_db() first",
        )
    return _pool


# ---------------------------------------------------------------------------
# Harness telemetry
# ---------------------------------------------------------------------------

async def log_harness_outcome(
    agent_name: str,
    outcome: str,
    cost_usd: float | None = None,
    tokens_input: int = 0,
    tokens_output: int = 0,
    attempts: int = 0,
    elapsed_seconds: float = 0,
    error: str | None = None,
    prospect_id: str | None = None,
    user_email: str | None = None,
) -> None:
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_harness_log
               (agent_name, outcome, cost_usd, tokens_input, tokens_output,
                attempts, elapsed_seconds, error, prospect_id, user_email)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
            agent_name, outcome, cost_usd, tokens_input, tokens_output,
            attempts, elapsed_seconds, error, prospect_id, user_email,
        )


# ---------------------------------------------------------------------------
# Meta-Observer alerts
# ---------------------------------------------------------------------------
# Persists rows to bedrock.pebble_meta_alerts (created by the
# 2026-05-18-pebble-swarm-runtime.sql migration). Each row is one
# intervention the Meta-Observer made — anomaly detected + action
# taken. Cockpit renders these as the "Meta-Observer feed" panel
# (plan §6.3); ops dashboards aggregate by alert_kind.
#
# Best-effort: a DB failure here MUST NOT crash the research pipeline.
# We swallow exceptions with a warning log — pipeline correctness does
# not depend on alert persistence.

# Whitelisted alert_kind / severity values match the CHECK constraint on
# bedrock.pebble_meta_alerts so a typo turns into a Python error here
# rather than a SQL constraint violation at INSERT time. Update both
# this set AND the SQL CHECK when adding kinds.
_META_ALERT_KINDS = frozenset({
    "stall",
    "runaway",
    "off_rails",
    "divergence",
    "conflict_spike",
    "low_novelty",
    "cost_80",
    "cost_100",
    "injection_signature",
    "global_cost_breach",
})

_META_ALERT_SEVERITIES = frozenset({
    "warn",
    "throttle",
    "abort_cluster",
    "replan",
    "halt",
})


async def save_meta_alert(
    *,
    session_id: str,
    alert_kind: str,
    severity: str,
    action_taken: str,
    originating_user_email: str,
    cluster: str | None = None,
    payload: dict | None = None,
    llm_introspection: bool = False,
    llm_cost_usd: float = 0.0,
    org_id: str = "pursuit",
) -> None:
    """Persist one Meta-Observer intervention.

    Args mirror the columns of bedrock.pebble_meta_alerts. Validates
    alert_kind / severity against the schema CHECK constraint client-
    side so a typo surfaces immediately instead of at INSERT time.

    On DB failure: log a warning and return. The Meta-Observer is
    advisory; correctness of the research pipeline does not depend on
    it. Tests pin this best-effort behavior.
    """
    if alert_kind not in _META_ALERT_KINDS:
        raise ValueError(
            f"unknown alert_kind {alert_kind!r}; allowed: {sorted(_META_ALERT_KINDS)}"
        )
    if severity not in _META_ALERT_SEVERITIES:
        raise ValueError(
            f"unknown severity {severity!r}; allowed: {sorted(_META_ALERT_SEVERITIES)}"
        )
    if not originating_user_email:
        # Audit attribution is mandatory (§4.10). Reject empty rather
        # than persisting a row that violates audit invariants.
        raise ValueError("originating_user_email is required for meta alerts")

    payload_json = json.dumps(payload) if payload is not None else None

    try:
        async with get_pool().acquire() as conn:
            await conn.execute(
                """INSERT INTO bedrock.pebble_meta_alerts
                       (session_id, alert_kind, severity, cluster, action_taken,
                        payload_json, llm_introspection, llm_cost_usd,
                        originating_user_email, org_id)
                   VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)""",
                session_id, alert_kind, severity, cluster, action_taken,
                payload_json, llm_introspection, llm_cost_usd,
                originating_user_email, org_id,
            )
    except Exception as exc:  # pragma: no cover - logged best-effort path
        logger.warning(
            "save_meta_alert failed (best-effort): %s — alert dropped: "
            "session=%s kind=%s severity=%s",
            exc, session_id, alert_kind, severity,
        )


async def get_daily_usage(user_email: str, date_str: str) -> dict | None:
    """Get daily cost usage for a user.  Returns None if no usage recorded."""
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT total_cost_usd, query_count "
            "FROM bedrock.pebble_daily_usage "
            "WHERE user_email = $1 AND date = $2",
            user_email, date_str,
        )
        return dict(row) if row else None


async def increment_daily_usage(
    user_email: str, date_str: str, cost: float,
) -> None:
    """Atomically increment daily cost and query count for a user."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_daily_usage
               (user_email, date, total_cost_usd, query_count)
               VALUES ($1, $2, $3, 1)
               ON CONFLICT (user_email, date) DO UPDATE SET
                   total_cost_usd = bedrock.pebble_daily_usage.total_cost_usd
                                    + EXCLUDED.total_cost_usd,
                   query_count = bedrock.pebble_daily_usage.query_count + 1""",
            user_email, date_str, cost,
        )


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------

async def save_profile(
    contact_id: str, profile: dict, cost_usd: float | None = None,
) -> None:
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_profiles
               (contact_id, profile_json, cost_usd)
               VALUES ($1, $2, $3)
               ON CONFLICT (contact_id) DO UPDATE SET
                   profile_json = EXCLUDED.profile_json,
                   cost_usd = EXCLUDED.cost_usd""",
            contact_id, json.dumps(profile), cost_usd,
        )


async def get_profile(contact_id: str) -> dict | None:
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT profile_json FROM bedrock.pebble_profiles "
            "WHERE contact_id = $1",
            contact_id,
        )
        if row:
            return json.loads(row["profile_json"])
        return None


# ---------------------------------------------------------------------------
# Feedback
# ---------------------------------------------------------------------------

async def save_feedback(
    claim_id: str,
    correct: bool,
    text: str | None = None,
    contact_id: str | None = None,
    user_id: str | None = None,
) -> None:
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_feedback
               (claim_id, correct, text, contact_id, user_id)
               VALUES ($1, $2, $3, $4, $5)""",
            claim_id, correct, text, contact_id, user_id,
        )


async def get_feedback_for_contact(contact_id: str) -> list[dict]:
    """Return all feedback rows for a contact, newest first."""
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, claim_id, correct, text, contact_id, user_id, created_at "
            "FROM bedrock.pebble_feedback "
            "WHERE contact_id = $1 ORDER BY created_at DESC",
            contact_id,
        )
        return [dict(r) for r in rows]


async def get_feedback_trends(days: int = 30) -> dict:
    """Return feedback trend stats over the last N days."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    async with get_pool().acquire() as conn:
        # Overall counts
        row = await conn.fetchrow(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN correct THEN 1 ELSE 0 END) AS correct_count, "
            "SUM(CASE WHEN NOT correct THEN 1 ELSE 0 END) AS incorrect_count "
            "FROM bedrock.pebble_feedback WHERE created_at >= $1",
            cutoff,
        )
        total = row["total"] or 0
        correct_count = row["correct_count"] or 0
        incorrect_count = row["incorrect_count"] or 0
        correct_pct = (
            round(correct_count / total * 100, 1) if total > 0 else 0.0
        )

        # By contact
        by_contact_rows = await conn.fetch(
            "SELECT contact_id, COUNT(*) AS total, "
            "SUM(CASE WHEN correct THEN 1 ELSE 0 END) AS correct_count "
            "FROM bedrock.pebble_feedback "
            "WHERE created_at >= $1 AND contact_id IS NOT NULL "
            "GROUP BY contact_id ORDER BY total DESC",
            cutoff,
        )
        by_contact = [
            {
                "contact_id": r["contact_id"],
                "total": r["total"],
                "correct_count": r["correct_count"] or 0,
            }
            for r in by_contact_rows
        ]

        return {
            "total": total,
            "correct_count": correct_count,
            "incorrect_count": incorrect_count,
            "correct_pct": correct_pct,
            "by_contact": by_contact,
        }


# ---------------------------------------------------------------------------
# Source scores (stigmergy)
# ---------------------------------------------------------------------------

async def save_source_scores(
    prospect_id: str, scores: dict[str, float],
) -> None:
    """Stigmergy: write source richness scores to environment."""
    async with get_pool().acquire() as conn:
        await conn.executemany(
            """INSERT INTO bedrock.pebble_source_scores
               (source_name, richness_score, prospect_id)
               VALUES ($1, $2, $3)""",
            [(name, score, prospect_id) for name, score in scores.items()],
        )


async def get_source_reliability(source_name: str) -> float:
    """Stigmergy: read pheromone trail — success rate over last 50 runs."""
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT outcome FROM bedrock.pebble_harness_log
               WHERE agent_name = $1 ORDER BY created_at DESC LIMIT 50""",
            source_name,
        )
        if not rows:
            return 1.0  # No history — neutral multiplier
        successes = sum(1 for r in rows if r["outcome"] == "success")
        return successes / len(rows)


# ---------------------------------------------------------------------------
# Session history
# ---------------------------------------------------------------------------

async def save_session(
    session_id: str,
    contact_id: str,
    profile: dict,
    prospect_name: str,
    prospect_org: str,
    cost_usd: float | None = None,
    status: str = "completed",
    tier: str | None = None,
    agents_log: list[dict] | None = None,
    batch_id: str | None = None,
) -> None:
    """Insert a research session record."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_research_sessions
               (id, contact_id, profile_json, cost_usd, prospect_name,
                prospect_org, status, tier, agents_log_json, batch_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)""",
            session_id, contact_id, json.dumps(profile), cost_usd,
            prospect_name, prospect_org, status, tier,
            json.dumps(agents_log) if agents_log else None, batch_id,
        )


async def update_session_metadata(
    contact_id: str,
    tier: str | None = None,
    agents_log: list[dict] | None = None,
    batch_id: str | None = None,
) -> None:
    """Update the most recent session for a contact with metadata fields."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """UPDATE bedrock.pebble_research_sessions
               SET tier = COALESCE($1, tier),
                   agents_log_json = COALESCE($2, agents_log_json),
                   batch_id = COALESCE($3, batch_id)
               WHERE id = (
                   SELECT id FROM bedrock.pebble_research_sessions
                   WHERE contact_id = $4
                   ORDER BY created_at DESC LIMIT 1
               )""",
            tier,
            json.dumps(agents_log) if agents_log else None,
            batch_id,
            contact_id,
        )


async def get_recent_sessions(limit: int = 100) -> list[dict]:
    """Return recent research sessions ordered by created_at DESC."""
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, contact_id, prospect_name, prospect_org, status,
                      profile_json, tier, batch_id, cost_usd, created_at
               FROM bedrock.pebble_research_sessions
               ORDER BY created_at DESC
               LIMIT $1""",
            limit,
        )
        results = []
        for r in rows:
            profile = json.loads(r["profile_json"])
            results.append({
                "id": r["id"],
                "contact_id": r["contact_id"],
                "prospect_name": r["prospect_name"],
                "prospect_org": r["prospect_org"],
                "status": r["status"],
                "tier": r["tier"],
                "batch_id": r["batch_id"],
                "cost_usd": r["cost_usd"],
                "claims_count": len(profile.get("claims", [])),
                "confidence_score": profile.get("confidence_score", "unknown"),
                "created_at": r["created_at"],
            })
        return results


async def get_session(session_id: str) -> dict | None:
    """Return a full session record including profile_json (parsed)."""
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id, contact_id, profile_json, cost_usd,
                      prospect_name, prospect_org, status,
                      agents_log_json, tier, batch_id, created_at
               FROM bedrock.pebble_research_sessions WHERE id = $1""",
            session_id,
        )
        if not row:
            return None
        result = dict(row)
        result["profile"] = json.loads(result.pop("profile_json"))
        agents_log_raw = result.pop("agents_log_json", None)
        result["agents_log"] = (
            json.loads(agents_log_raw) if agents_log_raw else None
        )
        return result


async def get_sessions_grouped(limit: int = 100) -> list[dict]:
    """Return sessions grouped: batch -> prospect -> tier runs."""
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, contact_id, prospect_name, prospect_org, status,
                      profile_json, tier, batch_id, cost_usd, created_at
               FROM bedrock.pebble_research_sessions
               ORDER BY created_at DESC LIMIT $1""",
            limit,
        )

    batches: OrderedDict[str, dict] = OrderedDict()

    for r in rows:
        profile = json.loads(r["profile_json"])
        session = {
            "id": r["id"],
            "contact_id": r["contact_id"],
            "prospect_name": r["prospect_name"],
            "prospect_org": r["prospect_org"],
            "status": r["status"],
            "tier": r["tier"],
            "batch_id": r["batch_id"],
            "cost_usd": r["cost_usd"],
            "claims_count": len(profile.get("claims", [])),
            "confidence_score": profile.get("confidence_score", "unknown"),
            "created_at": r["created_at"],
        }

        batch_key = r["batch_id"] or f"_implicit_{r['id']}"
        if batch_key not in batches:
            batches[batch_key] = {
                "batch_id": r["batch_id"],
                "created_at": r["created_at"],
                "prospects": OrderedDict(),
            }

        prospect_key = r["contact_id"]
        if prospect_key not in batches[batch_key]["prospects"]:
            batches[batch_key]["prospects"][prospect_key] = {
                "prospect_name": r["prospect_name"],
                "prospect_org": r["prospect_org"],
                "contact_id": r["contact_id"],
                "runs": [],
            }
        batches[batch_key]["prospects"][prospect_key]["runs"].append(session)

    result = []
    for batch in batches.values():
        batch["prospects"] = list(batch["prospects"].values())
        result.append(batch)
    return result


# ---------------------------------------------------------------------------
# Chat persistence (Ask Pebble)
# ---------------------------------------------------------------------------

async def ensure_conversation(
    conversation_id: str, user_email: str,
) -> None:
    """Create a conversation record if it doesn't exist."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_chat_conversations (id, user_email)
               VALUES ($1, $2)
               ON CONFLICT (id) DO NOTHING""",
            conversation_id, user_email,
        )


async def save_chat_message(
    message_id: str,
    conversation_id: str,
    role: str,
    content: str,
    tier: str | None = None,
    cost_usd: float = 0.0,
    metadata: dict | None = None,
) -> None:
    """Save a chat message and update conversation cost.

    Uses a transaction for atomicity: message insert + cost update
    either both succeed or neither does.
    """
    metadata_json = json.dumps(metadata) if metadata else None
    async with get_pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """INSERT INTO bedrock.pebble_chat_messages
                   (id, conversation_id, role, content, tier, cost_usd, metadata_json)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)""",
                message_id, conversation_id, role, content, tier,
                cost_usd, metadata_json,
            )
            if cost_usd > 0:
                # updated_at handled by trigger — no manual SET needed
                await conn.execute(
                    """UPDATE bedrock.pebble_chat_conversations
                       SET total_cost_usd = total_cost_usd + $1
                       WHERE id = $2""",
                    cost_usd, conversation_id,
                )


async def get_conversation_messages(
    conversation_id: str, limit: int = 50,
) -> list[dict]:
    """Get recent messages for a conversation."""
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, role, content, tier, cost_usd,
                      metadata_json, created_at
               FROM bedrock.pebble_chat_messages
               WHERE conversation_id = $1
               ORDER BY created_at ASC
               LIMIT $2""",
            conversation_id, limit,
        )
    results = []
    for r in rows:
        msg = dict(r)
        if msg.get("metadata_json"):
            msg["metadata"] = json.loads(msg.pop("metadata_json"))
        else:
            msg.pop("metadata_json", None)
            msg["metadata"] = None
        results.append(msg)
    return results


async def get_recent_conversations(
    user_email: str | None = None, limit: int = 20,
) -> list[dict]:
    """Get recent conversations, optionally filtered by user."""
    async with get_pool().acquire() as conn:
        if user_email:
            rows = await conn.fetch(
                """SELECT id, user_email, title, total_cost_usd,
                          created_at, updated_at
                   FROM bedrock.pebble_chat_conversations
                   WHERE user_email = $1
                   ORDER BY updated_at DESC
                   LIMIT $2""",
                user_email, limit,
            )
        else:
            rows = await conn.fetch(
                """SELECT id, user_email, title, total_cost_usd,
                          created_at, updated_at
                   FROM bedrock.pebble_chat_conversations
                   ORDER BY updated_at DESC
                   LIMIT $1""",
                limit,
            )
        return [dict(r) for r in rows]


async def get_conversation_context(conversation_id: str) -> dict | None:
    """Get the last assistant message's metadata for context resolution."""
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            """SELECT metadata_json FROM bedrock.pebble_chat_messages
               WHERE conversation_id = $1 AND role = 'assistant'
               ORDER BY created_at DESC LIMIT 1""",
            conversation_id,
        )
        if row and row["metadata_json"]:
            return json.loads(row["metadata_json"])
        return None


# ---------------------------------------------------------------------------
# Batch research persistence (Ask Pebble Phase 4)
# ---------------------------------------------------------------------------

async def create_batch(
    batch_id: str, user_email: str, prospects: list[dict],
) -> None:
    """Create a batch and its prospect rows.

    Uses a transaction for atomicity: either all prospects are inserted
    or none (prevents partial batches on failure).
    """
    async with get_pool().acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """INSERT INTO bedrock.pebble_research_batches
                   (id, user_email, total_prospects)
                   VALUES ($1, $2, $3)""",
                batch_id, user_email, len(prospects),
            )
            for p in prospects:
                await conn.execute(
                    """INSERT INTO bedrock.pebble_batch_prospects
                       (id, batch_id, prospect_name, prospect_org)
                       VALUES ($1, $2, $3, $4)""",
                    p["id"], batch_id, p.get("name", ""),
                    p.get("organization", ""),
                )


async def update_batch_prospect(
    prospect_id: str,
    current_tier: str,
    identity_confidence: str = "none",
    crm_status: str = "unknown",
    result_json: str | None = None,
    cost_usd: float = 0.0,
) -> None:
    """Update a prospect's tier result in a batch."""
    # updated_at handled by trigger — no manual SET needed
    async with get_pool().acquire() as conn:
        await conn.execute(
            """UPDATE bedrock.pebble_batch_prospects
               SET current_tier = $1, identity_confidence = $2,
                   crm_status = $3, result_json = $4, cost_usd = $5
               WHERE id = $6""",
            current_tier, identity_confidence, crm_status,
            result_json, cost_usd, prospect_id,
        )


async def update_batch_status(
    batch_id: str,
    status: str,
    completed_prospects: int | None = None,
    total_cost_usd: float | None = None,
) -> None:
    """Update batch-level status."""
    # updated_at handled by trigger — no manual SET needed
    params: list[Any] = [status]
    sets = ["status = $1"]
    idx = 2
    if completed_prospects is not None:
        sets.append(f"completed_prospects = ${idx}")
        params.append(completed_prospects)
        idx += 1
    if total_cost_usd is not None:
        sets.append(f"total_cost_usd = ${idx}")
        params.append(total_cost_usd)
        idx += 1
    params.append(batch_id)
    async with get_pool().acquire() as conn:
        await conn.execute(
            f"UPDATE bedrock.pebble_research_batches "
            f"SET {', '.join(sets)} WHERE id = ${idx}",
            *params,
        )


async def get_batch_status(batch_id: str) -> dict | None:
    """Get batch status and summary."""
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            """SELECT id, user_email, total_prospects, completed_prospects,
                      target_tier, status, total_cost_usd, created_at, updated_at
               FROM bedrock.pebble_research_batches WHERE id = $1""",
            batch_id,
        )
        return dict(row) if row else None


async def get_batch_prospects(batch_id: str) -> list[dict]:
    """Get all prospects in a batch."""
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, prospect_name, prospect_org, current_tier,
                      identity_confidence, crm_status, result_json, cost_usd
               FROM bedrock.pebble_batch_prospects
               WHERE batch_id = $1
               ORDER BY prospect_name ASC""",
            batch_id,
        )
    results = []
    for r in rows:
        item = dict(r)
        if item.get("result_json"):
            item["result"] = json.loads(item.pop("result_json"))
        else:
            item.pop("result_json", None)
            item["result"] = None
        results.append(item)
    return results


# ---------------------------------------------------------------------------
# Prospect CRM mapping (M17 — SF field audit + prospect readiness)
# ---------------------------------------------------------------------------

async def save_prospect_sf_contact(prospect_id: str, data: dict) -> None:
    """UPSERT structured Contact fields for a prospect.

    Scalar fields (title, email, etc.) use COALESCE — later tiers supersede.
    notes: appended with '---' separator (research accumulates).
    sources: merged with dedup (every data source tracked).
    """
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.prospect_sf_contact
               (prospect_id, last_name, first_name, title, email, phone,
                department, lead_source, linkedin_url,
                mailing_street, mailing_city, mailing_state, mailing_postal_code,
                philanthropic_contact, philanthropy, volunteer,
                notes, sources, last_enriched_tier, last_enriched_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
               ON CONFLICT (prospect_id) DO UPDATE SET
                   last_name      = COALESCE(EXCLUDED.last_name, bedrock.prospect_sf_contact.last_name),
                   first_name     = COALESCE(EXCLUDED.first_name, bedrock.prospect_sf_contact.first_name),
                   title          = COALESCE(EXCLUDED.title, bedrock.prospect_sf_contact.title),
                   email          = COALESCE(EXCLUDED.email, bedrock.prospect_sf_contact.email),
                   phone          = COALESCE(EXCLUDED.phone, bedrock.prospect_sf_contact.phone),
                   department     = COALESCE(EXCLUDED.department, bedrock.prospect_sf_contact.department),
                   lead_source    = COALESCE(EXCLUDED.lead_source, bedrock.prospect_sf_contact.lead_source),
                   linkedin_url   = COALESCE(EXCLUDED.linkedin_url, bedrock.prospect_sf_contact.linkedin_url),
                   mailing_street = COALESCE(EXCLUDED.mailing_street, bedrock.prospect_sf_contact.mailing_street),
                   mailing_city   = COALESCE(EXCLUDED.mailing_city, bedrock.prospect_sf_contact.mailing_city),
                   mailing_state  = COALESCE(EXCLUDED.mailing_state, bedrock.prospect_sf_contact.mailing_state),
                   mailing_postal_code = COALESCE(EXCLUDED.mailing_postal_code, bedrock.prospect_sf_contact.mailing_postal_code),
                   philanthropic_contact = COALESCE(EXCLUDED.philanthropic_contact, bedrock.prospect_sf_contact.philanthropic_contact),
                   philanthropy   = COALESCE(EXCLUDED.philanthropy, bedrock.prospect_sf_contact.philanthropy),
                   volunteer      = COALESCE(EXCLUDED.volunteer, bedrock.prospect_sf_contact.volunteer),
                   notes = CASE
                       WHEN EXCLUDED.notes IS NOT NULL THEN
                           CASE WHEN bedrock.prospect_sf_contact.notes IS NOT NULL
                               THEN bedrock.prospect_sf_contact.notes || E'\n---\n' || EXCLUDED.notes
                               ELSE EXCLUDED.notes END
                       ELSE bedrock.prospect_sf_contact.notes END,
                   sources = CASE
                       WHEN EXCLUDED.sources IS NOT NULL THEN
                           ARRAY(SELECT DISTINCT unnest(
                               COALESCE(bedrock.prospect_sf_contact.sources, ARRAY[]::text[])
                               || EXCLUDED.sources))
                       ELSE bedrock.prospect_sf_contact.sources END,
                   last_enriched_tier = EXCLUDED.last_enriched_tier,
                   last_enriched_at   = now()""",
            prospect_id,
            data.get("last_name"), data.get("first_name"),
            data.get("title"), data.get("email"), data.get("phone"),
            data.get("department"), data.get("lead_source"), data.get("linkedin_url"),
            data.get("mailing_street"), data.get("mailing_city"),
            data.get("mailing_state"), data.get("mailing_postal_code"),
            data.get("philanthropic_contact"), data.get("philanthropy"),
            data.get("volunteer"),
            data.get("notes"), data.get("sources"),
            data.get("last_enriched_tier"),
        )


async def save_prospect_sf_account(prospect_id: str, data: dict) -> None:
    """UPSERT structured Account fields for a prospect.

    Same accumulation semantics as save_prospect_sf_contact — see its docstring.
    """
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.prospect_sf_account
               (prospect_id, name, account_type, industry, website, phone,
                grantmaker, philanthropy, fee_for_service,
                annual_revenue, funding_focus,
                notes, sources, last_enriched_tier, last_enriched_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
               ON CONFLICT (prospect_id) DO UPDATE SET
                   name            = COALESCE(EXCLUDED.name, bedrock.prospect_sf_account.name),
                   account_type    = COALESCE(EXCLUDED.account_type, bedrock.prospect_sf_account.account_type),
                   industry        = COALESCE(EXCLUDED.industry, bedrock.prospect_sf_account.industry),
                   website         = COALESCE(EXCLUDED.website, bedrock.prospect_sf_account.website),
                   phone           = COALESCE(EXCLUDED.phone, bedrock.prospect_sf_account.phone),
                   grantmaker      = COALESCE(EXCLUDED.grantmaker, bedrock.prospect_sf_account.grantmaker),
                   philanthropy    = COALESCE(EXCLUDED.philanthropy, bedrock.prospect_sf_account.philanthropy),
                   fee_for_service = COALESCE(EXCLUDED.fee_for_service, bedrock.prospect_sf_account.fee_for_service),
                   annual_revenue  = COALESCE(EXCLUDED.annual_revenue, bedrock.prospect_sf_account.annual_revenue),
                   funding_focus   = COALESCE(EXCLUDED.funding_focus, bedrock.prospect_sf_account.funding_focus),
                   notes = CASE
                       WHEN EXCLUDED.notes IS NOT NULL THEN
                           CASE WHEN bedrock.prospect_sf_account.notes IS NOT NULL
                               THEN bedrock.prospect_sf_account.notes || E'\n---\n' || EXCLUDED.notes
                               ELSE EXCLUDED.notes END
                       ELSE bedrock.prospect_sf_account.notes END,
                   sources = CASE
                       WHEN EXCLUDED.sources IS NOT NULL THEN
                           ARRAY(SELECT DISTINCT unnest(
                               COALESCE(bedrock.prospect_sf_account.sources, ARRAY[]::text[])
                               || EXCLUDED.sources))
                       ELSE bedrock.prospect_sf_account.sources END,
                   last_enriched_tier = EXCLUDED.last_enriched_tier,
                   last_enriched_at   = now()""",
            prospect_id,
            data.get("name"), data.get("account_type"),
            data.get("industry"), data.get("website"), data.get("phone"),
            data.get("grantmaker"), data.get("philanthropy"),
            data.get("fee_for_service"),
            data.get("annual_revenue"), data.get("funding_focus"),
            data.get("notes"), data.get("sources"),
            data.get("last_enriched_tier"),
        )


async def save_prospect_sf_opportunity(prospect_id: str, data: dict) -> None:
    """UPSERT Opportunity hints derived from prospect research.

    Same accumulation semantics as save_prospect_sf_contact — see its docstring.
    """
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.prospect_sf_opportunity
               (prospect_id, suggested_name, suggested_amount, suggested_stage,
                suggested_close_date, suggested_record_type,
                giving_capacity_estimate, past_giving_history, wealth_indicators,
                notes, sources, last_enriched_tier, last_enriched_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
               ON CONFLICT (prospect_id) DO UPDATE SET
                   suggested_name  = COALESCE(EXCLUDED.suggested_name, bedrock.prospect_sf_opportunity.suggested_name),
                   suggested_amount = COALESCE(EXCLUDED.suggested_amount, bedrock.prospect_sf_opportunity.suggested_amount),
                   suggested_stage = COALESCE(EXCLUDED.suggested_stage, bedrock.prospect_sf_opportunity.suggested_stage),
                   suggested_close_date  = COALESCE(EXCLUDED.suggested_close_date, bedrock.prospect_sf_opportunity.suggested_close_date),
                   suggested_record_type = COALESCE(EXCLUDED.suggested_record_type, bedrock.prospect_sf_opportunity.suggested_record_type),
                   giving_capacity_estimate = COALESCE(EXCLUDED.giving_capacity_estimate, bedrock.prospect_sf_opportunity.giving_capacity_estimate),
                   past_giving_history     = COALESCE(EXCLUDED.past_giving_history, bedrock.prospect_sf_opportunity.past_giving_history),
                   wealth_indicators       = COALESCE(EXCLUDED.wealth_indicators, bedrock.prospect_sf_opportunity.wealth_indicators),
                   notes = CASE
                       WHEN EXCLUDED.notes IS NOT NULL THEN
                           CASE WHEN bedrock.prospect_sf_opportunity.notes IS NOT NULL
                               THEN bedrock.prospect_sf_opportunity.notes || E'\n---\n' || EXCLUDED.notes
                               ELSE EXCLUDED.notes END
                       ELSE bedrock.prospect_sf_opportunity.notes END,
                   sources = CASE
                       WHEN EXCLUDED.sources IS NOT NULL THEN
                           ARRAY(SELECT DISTINCT unnest(
                               COALESCE(bedrock.prospect_sf_opportunity.sources, ARRAY[]::text[])
                               || EXCLUDED.sources))
                       ELSE bedrock.prospect_sf_opportunity.sources END,
                   last_enriched_tier = EXCLUDED.last_enriched_tier,
                   last_enriched_at   = now()""",
            prospect_id,
            data.get("suggested_name"), data.get("suggested_amount"),
            data.get("suggested_stage"), data.get("suggested_close_date"),
            data.get("suggested_record_type"),
            data.get("giving_capacity_estimate"), data.get("past_giving_history"),
            data.get("wealth_indicators"),
            data.get("notes"), data.get("sources"),
            data.get("last_enriched_tier"),
        )


# ---------------------------------------------------------------------------
# Phase 5C (Claim 5): SF push idempotency
# ---------------------------------------------------------------------------
#
# After Pebble pushes a prospect to Salesforce, the resulting SF Contact/Account
# IDs are written back to the staging tables so subsequent re-runs of the
# research pipeline can short-circuit the create_record call instead of
# duplicating SF records. The schema migration is in init.sql.


async def mark_prospect_contact_pushed(prospect_id: str, sf_contact_id: str) -> None:
    """Record that a prospect's Contact has been successfully pushed to SF.

    Idempotent — re-pushing the same prospect just updates the timestamp.
    """
    async with get_pool().acquire() as conn:
        await conn.execute(
            """UPDATE bedrock.prospect_sf_contact
               SET sf_contact_id = $1, sf_pushed_at = now()
               WHERE prospect_id = $2""",
            sf_contact_id, prospect_id,
        )


async def mark_prospect_account_pushed(prospect_id: str, sf_account_id: str) -> None:
    """Record that a prospect's Account has been successfully pushed to SF.

    Idempotent — re-pushing the same prospect just updates the timestamp.
    """
    async with get_pool().acquire() as conn:
        await conn.execute(
            """UPDATE bedrock.prospect_sf_account
               SET sf_account_id = $1, sf_pushed_at = now()
               WHERE prospect_id = $2""",
            sf_account_id, prospect_id,
        )


async def get_prospect_sf_ids(prospect_id: str) -> dict:
    """Fetch the SF Contact ID and SF Account ID for a prospect, if pushed.

    Returns:
        {"sf_contact_id": str | None, "sf_account_id": str | None,
         "contact_pushed_at": datetime | None, "account_pushed_at": datetime | None}

    Use this to short-circuit a re-push of an already-pushed prospect.
    """
    async with get_pool().acquire() as conn:
        contact_row = await conn.fetchrow(
            "SELECT sf_contact_id, sf_pushed_at "
            "FROM bedrock.prospect_sf_contact WHERE prospect_id = $1",
            prospect_id,
        )
        account_row = await conn.fetchrow(
            "SELECT sf_account_id, sf_pushed_at "
            "FROM bedrock.prospect_sf_account WHERE prospect_id = $1",
            prospect_id,
        )

    return {
        "sf_contact_id": contact_row["sf_contact_id"] if contact_row else None,
        "sf_account_id": account_row["sf_account_id"] if account_row else None,
        "contact_pushed_at": contact_row["sf_pushed_at"] if contact_row else None,
        "account_pushed_at": account_row["sf_pushed_at"] if account_row else None,
    }


async def get_prospect_crm_readiness(prospect_id: str) -> dict:
    """Fetch all prospect CRM sub-objects and compute readiness status.

    Returns a dict with contact, account, opportunity data and a readiness
    assessment showing which required fields are populated vs missing.
    """
    async with get_pool().acquire() as conn:
        contact_row = await conn.fetchrow(
            "SELECT * FROM bedrock.prospect_sf_contact WHERE prospect_id = $1",
            prospect_id,
        )
        account_row = await conn.fetchrow(
            "SELECT * FROM bedrock.prospect_sf_account WHERE prospect_id = $1",
            prospect_id,
        )
        opp_row = await conn.fetchrow(
            "SELECT * FROM bedrock.prospect_sf_opportunity WHERE prospect_id = $1",
            prospect_id,
        )
        req_rows = await conn.fetch(
            "SELECT sobject, field_name, field_label FROM bedrock.sf_field_requirements "
            "WHERE is_required = TRUE AND has_default = FALSE",
        )

    contact = dict(contact_row) if contact_row else {}
    account = dict(account_row) if account_row else {}
    opportunity = dict(opp_row) if opp_row else {}

    # Map SF field names to prospect table columns
    _sf_to_col = {
        "Contact": {"LastName": "last_name", "FirstName": "first_name"},
        "Account": {"Name": "name"},
        "Opportunity": {
            "Name": "suggested_name", "StageName": "suggested_stage",
            "CloseDate": "suggested_close_date",
        },
    }
    readiness: dict[str, dict] = {}
    for row in req_rows:
        obj = row["sobject"]
        fname = row["field_name"]
        if obj not in _sf_to_col:
            continue
        col = _sf_to_col[obj].get(fname)
        if col is None:
            continue
        source = {"Contact": contact, "Account": account, "Opportunity": opportunity}.get(obj, {})
        readiness.setdefault(obj, {"filled": [], "missing": []})
        if source.get(col):
            readiness[obj]["filled"].append(row["field_label"] or fname)
        else:
            readiness[obj]["missing"].append(row["field_label"] or fname)

    return {
        "contact": contact,
        "account": account,
        "opportunity": opportunity,
        "readiness": readiness,
    }


# ---------------------------------------------------------------------------
# Conflict log & scratchpad persistence (M14, absorbed into M17)
# ---------------------------------------------------------------------------

async def save_conflicts(
    session_id: str, contact_id: str, conflicts: list[dict],
) -> None:
    """Batch-insert detected data conflicts for a research session."""
    if not conflicts:
        return
    async with get_pool().acquire() as conn:
        await conn.executemany(
            """INSERT INTO bedrock.pebble_conflict_log
               (session_id, contact_id, conflict_type, claim_a, claim_b, description)
               VALUES ($1, $2, $3, $4, $5, $6)""",
            [
                (
                    session_id, contact_id,
                    c.get("type", "unknown"),
                    c.get("claim_a", ""),
                    c.get("claim_b", ""),
                    c.get("description", ""),
                )
                for c in conflicts
            ],
        )


async def save_scratchpad(
    session_id: str | None,
    contact_id: str,
    scratchpad_json: str,
    status: str = "active",
) -> None:
    """UPSERT research scratchpad state for a session."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """INSERT INTO bedrock.pebble_scratchpad
               (session_id, contact_id, scratchpad_json, status)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (session_id) DO UPDATE SET
                   scratchpad_json = EXCLUDED.scratchpad_json,
                   status = EXCLUDED.status""",
            session_id, contact_id, scratchpad_json, status,
        )


async def update_scratchpad(
    session_id: str,
    scratchpad_json: str,
    status: str,
) -> None:
    """Update an existing scratchpad's state and status."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """UPDATE bedrock.pebble_scratchpad
               SET scratchpad_json = $1, status = $2
               WHERE session_id = $3""",
            scratchpad_json, status, session_id,
        )
