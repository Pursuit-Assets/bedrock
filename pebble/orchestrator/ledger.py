"""Real-time token + cost ledger for Pebble runs.

The ledger is the canonical answer to "how much has this run spent so
far, broken down by call?". Live enforcement of TierBudget /
GlobalRunCap reads from here, not from pre-flight estimates. The
cockpit's cost meter binds to live ledger state via SSE events.

Two tables back the ledger:

  * ``bedrock.pebble_harness_log`` — one row per LLM call. Extended in
    2026-05-18-pebble-ledger-instrumentation.sql with cache_creation
    + cache_read columns, plus session_id / purpose / cluster / tier
    so per-run rollups don't need a JOIN.
  * ``bedrock.pebble_tool_call_log`` — one row per non-LLM tool
    invocation (FEC / ProPublica / OpenCorporates HTTP fetches).
    These currently bypass ModelClient so they're invisible to
    pebble_harness_log; the cockpit needs them for tool-call burn
    rate vs allocated cap.

Why a separate module from ``pebble.storage.db.log_harness_outcome``:

  * The storage module is the per-call writer. The ledger is the
    per-run reader + roll-up + SSE-feed.
  * Keeping the read path here means a future schema change (e.g.,
    adding a partitioned table or a materialized view) localizes.
  * Pydantic models live with the queries that produce them — same
    pattern as pebble/orchestrator/schemas.py for chat-side types.

The ledger never owns a DB pool — callers pass a pool or a connection.
This keeps the module callable from both the request thread (live
queries during a run) and the SSE worker (background queries during
replay) without coupling to one event loop.

``observe_tool_call`` is the async context manager that L2 swarm
clusters use to wrap their data-source dispatches. It captures
start/end times and outcome, then records a ToolCallEvent — without
swallowing the call's own exceptions.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, AsyncIterator, Literal, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Read-side Pydantic models
# ---------------------------------------------------------------------------

# Provider for the "where did this call go" attribution. Empty when the
# row predates the 2026-05-18 column add.
ProviderLiteral = Optional[str]

# Purpose: logical role of an LLM call inside the swarm. Matches the
# values enumerated in 2026-05-18-pebble-ledger-instrumentation.sql.
PurposeLiteral = Literal[
    "doer",
    "verifier",
    "probe",
    "capacity",
    "propensity",
    "affinity",
    "synthesis",
    "meta_observer",
    "replan",
    "escalation",
    "quorum",
    "other",       # legacy rows
]


class TokenEvent(BaseModel):
    """One LLM call. Materialized from a pebble_harness_log row."""

    id: str
    occurred_at: datetime
    agent_name: str
    outcome: str
    model_id: ProviderLiteral = None
    provider: ProviderLiteral = None

    # The four token fields. Defaults to 0 (DB defaults via the
    # 2026-05-18 migration) so old rows don't read as None.
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0

    cost_usd: float = 0.0
    elapsed_seconds: float = 0.0
    attempts: int = 0
    redo_attempt: int = 0
    error: Optional[str] = None

    # Run context — populated for L2 swarm calls; NULL for legacy
    # research-pipeline rows.
    session_id: Optional[str] = None
    purpose: Optional[str] = None
    cluster: Optional[str] = None
    tier: Optional[str] = None

    # Per-request attribution.
    prospect_id: Optional[str] = None
    user_email: Optional[str] = None

    @property
    def cache_hit_input_tokens(self) -> int:
        """Convenience: total tokens served from the cache."""
        return self.cache_read_input_tokens

    @property
    def has_cache_data(self) -> bool:
        """True iff this call used prompt caching at all."""
        return (
            self.cache_creation_input_tokens > 0
            or self.cache_read_input_tokens > 0
        )


class ToolCallEvent(BaseModel):
    """One non-LLM tool invocation. From pebble_tool_call_log."""

    id: int
    occurred_at: datetime
    session_id: str
    tool: str
    cluster: Optional[str] = None
    agent_name: Optional[str] = None
    cost_usd: float = 0.0
    success: bool
    elapsed_ms: int = 0
    bytes_returned: Optional[int] = None
    cache_hit: bool = False
    rate_limit_remaining: Optional[int] = None
    rate_limit_reset_at: Optional[datetime] = None
    error_class: Optional[str] = None
    originating_user_email: str


class CacheHitMetrics(BaseModel):
    """Cache-hit ratio rollup shown in the cockpit's cost meter chip."""

    total_input_tokens: int = 0
    cache_create_tokens: int = 0
    cache_read_tokens: int = 0

    @property
    def cache_hit_ratio(self) -> float:
        """cache_read / (cache_read + fresh input). Returns 0.0 when no
        tokens have been counted yet so the cockpit shows a flat 0%
        instead of a NaN."""
        denominator = self.cache_read_tokens + self.total_input_tokens
        if denominator <= 0:
            return 0.0
        return self.cache_read_tokens / denominator

    @property
    def estimated_savings_usd(self) -> float:
        """How much we saved by serving cache_read instead of fresh
        input tokens. Sonnet 4.6 reference rate ($3/Mtok input) used
        when we don't know the per-call model — a slight under-
        estimate for Opus calls (which would save more) and a slight
        over-estimate for Haiku (which would save less). The cockpit
        treats this as "savings ballpark", not a billing figure.
        """
        savings_rate_per_mtok = 3.0 * 0.90   # input rate × (1 − cache_read_factor)
        return (self.cache_read_tokens / 1_000_000) * savings_rate_per_mtok


class ClusterRollup(BaseModel):
    """Per-cluster aggregation: how much did cluster X spend this run."""

    cluster: str
    call_count: int = 0
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    tool_call_count: int = 0
    error_count: int = 0


class PurposeRollup(BaseModel):
    """Per-purpose aggregation: how much did synthesis / verification /
    probe / etc. cost this run."""

    purpose: str
    call_count: int = 0
    cost_usd: float = 0.0


class RunTotal(BaseModel):
    """Top-level rollup. Drives the cockpit's main cost meter."""

    session_id: str
    started_at: Optional[datetime] = None
    last_event_at: Optional[datetime] = None
    llm_call_count: int = 0
    tool_call_count: int = 0
    total_cost_usd: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    cache: CacheHitMetrics = Field(default_factory=CacheHitMetrics)
    error_count: int = 0


class RunLedger(BaseModel):
    """The materialized ledger for one session. Lightweight enough to
    serialize on every SSE budget.consume event."""

    session_id: str
    run_total: RunTotal
    by_cluster: dict[str, ClusterRollup] = Field(default_factory=dict)
    by_purpose: dict[str, PurposeRollup] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Write-side helpers
# ---------------------------------------------------------------------------

async def record_token_event(
    pool,
    *,
    agent_name: str,
    outcome: str,
    cost_usd: float,
    tokens_input: int,
    tokens_output: int,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    attempts: int = 0,
    elapsed_seconds: float = 0.0,
    error: Optional[str] = None,
    prospect_id: Optional[str] = None,
    user_email: Optional[str] = None,
    session_id: Optional[str] = None,
    purpose: Optional[str] = None,
    cluster: Optional[str] = None,
    tier: Optional[str] = None,
    provider: Optional[str] = None,
    model_id: Optional[str] = None,
    redo_attempt: int = 0,
) -> None:
    """Persist one TokenEvent to bedrock.pebble_harness_log.

    Superset of pebble.storage.db.log_harness_outcome — adds the L2
    swarm columns (session_id, purpose, cluster, tier, provider,
    model_id, redo_attempt) and the cache-aware token fields. Existing
    callers can keep using log_harness_outcome; new callers in the L2
    swarm (Doers / Verifiers / Meta-Observer) use this.

    Best-effort write — logs and returns on failure. Same contract as
    the chat scratchpad: losing one ledger row is acceptable, failing
    the swarm step is not.
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO bedrock.pebble_harness_log
                   (agent_name, outcome, cost_usd,
                    tokens_input, tokens_output,
                    cache_creation_input_tokens, cache_read_input_tokens,
                    attempts, elapsed_seconds, error,
                    prospect_id, user_email,
                    session_id, purpose, cluster, tier,
                    provider, model_id, redo_attempt)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                           $11,$12,$13,$14,$15,$16,$17,$18,$19)""",
                agent_name, outcome, cost_usd,
                tokens_input, tokens_output,
                cache_creation_input_tokens, cache_read_input_tokens,
                attempts, elapsed_seconds, error,
                prospect_id, user_email,
                session_id, purpose, cluster, tier,
                provider, model_id, redo_attempt,
            )
    except Exception as e:
        logger.warning("ledger.record_token_event failed: %s", e)


async def record_tool_call(
    pool,
    *,
    session_id: str,
    tool: str,
    success: bool,
    elapsed_ms: int,
    originating_user_email: str,
    cluster: Optional[str] = None,
    agent_name: Optional[str] = None,
    cost_usd: float = 0.0,
    bytes_returned: Optional[int] = None,
    cache_hit: bool = False,
    rate_limit_remaining: Optional[int] = None,
    rate_limit_reset_at: Optional[datetime] = None,
    error_class: Optional[str] = None,
    org_id: str = "pursuit",
) -> None:
    """Persist one ToolCallEvent to bedrock.pebble_tool_call_log.

    Called by the @with_ledger decorator on pebble/data_sources/*.py
    HTTP fetches. Best-effort same as record_token_event.
    """
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO bedrock.pebble_tool_call_log
                   (session_id, tool, cluster, agent_name,
                    cost_usd, success, elapsed_ms, bytes_returned,
                    cache_hit, rate_limit_remaining, rate_limit_reset_at,
                    error_class, originating_user_email, org_id)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)""",
                session_id, tool, cluster, agent_name,
                cost_usd, success, elapsed_ms, bytes_returned,
                cache_hit, rate_limit_remaining, rate_limit_reset_at,
                error_class, originating_user_email, org_id,
            )
    except Exception as e:
        logger.warning("ledger.record_tool_call failed: %s", e)


# ---------------------------------------------------------------------------
# Read-side rollup
# ---------------------------------------------------------------------------

async def compute_run_rollup(pool, session_id: str) -> RunLedger:
    """Materialize the live ledger for one session.

    Reads from pebble_harness_log (LLM calls) + pebble_tool_call_log
    (non-LLM tool calls). Computes:
      * run_total (cost, token counts, cache metrics, errors)
      * by_cluster rollup (per Cluster A-F spend breakdown)
      * by_purpose rollup (doer / verifier / synthesis / ...)

    Pure aggregation — no side effects. Safe to call from SSE worker
    or from a request handler. Returns an empty RunLedger when no rows
    match (e.g., session has had no LLM activity yet).
    """
    rows: list[dict] = []
    async with pool.acquire() as conn:
        # LLM-side rows.
        llm_rows = await conn.fetch(
            """SELECT id, created_at AS occurred_at, agent_name, outcome,
                      COALESCE(model_id, '') AS model_id,
                      COALESCE(provider, '') AS provider,
                      COALESCE(tokens_input, 0)                AS input_tokens,
                      COALESCE(tokens_output, 0)               AS output_tokens,
                      COALESCE(cache_creation_input_tokens, 0) AS cache_creation,
                      COALESCE(cache_read_input_tokens, 0)     AS cache_read,
                      COALESCE(cost_usd, 0)                    AS cost_usd,
                      COALESCE(elapsed_seconds, 0)             AS elapsed_seconds,
                      COALESCE(attempts, 0)                    AS attempts,
                      COALESCE(redo_attempt, 0)                AS redo_attempt,
                      error,
                      session_id::text                         AS session_id,
                      purpose, cluster, tier,
                      prospect_id, user_email
               FROM bedrock.pebble_harness_log
               WHERE session_id::text = $1
               ORDER BY created_at""",
            session_id,
        )
        tool_rows = await conn.fetch(
            """SELECT id, occurred_at, session_id::text AS session_id,
                      tool, cluster, agent_name,
                      COALESCE(cost_usd, 0)                AS cost_usd,
                      success,
                      COALESCE(elapsed_ms, 0)              AS elapsed_ms,
                      bytes_returned, cache_hit,
                      rate_limit_remaining, rate_limit_reset_at,
                      error_class, originating_user_email
               FROM bedrock.pebble_tool_call_log
               WHERE session_id::text = $1
               ORDER BY occurred_at""",
            session_id,
        )

    # Roll up.
    total = RunTotal(session_id=session_id)
    by_cluster: dict[str, ClusterRollup] = {}
    by_purpose: dict[str, PurposeRollup] = {}

    for r in llm_rows:
        total.llm_call_count += 1
        total.total_cost_usd += float(r["cost_usd"])
        total.total_input_tokens += int(r["input_tokens"])
        total.total_output_tokens += int(r["output_tokens"])
        total.cache.total_input_tokens += int(r["input_tokens"])
        total.cache.cache_create_tokens += int(r["cache_creation"])
        total.cache.cache_read_tokens += int(r["cache_read"])
        if r["error"]:
            total.error_count += 1
        if total.started_at is None or r["occurred_at"] < total.started_at:
            total.started_at = r["occurred_at"]
        if total.last_event_at is None or r["occurred_at"] > total.last_event_at:
            total.last_event_at = r["occurred_at"]

        if r["cluster"]:
            cr = by_cluster.setdefault(r["cluster"], ClusterRollup(cluster=r["cluster"]))
            cr.call_count += 1
            cr.cost_usd += float(r["cost_usd"])
            cr.input_tokens += int(r["input_tokens"])
            cr.output_tokens += int(r["output_tokens"])
            cr.cache_read_tokens += int(r["cache_read"])
            if r["error"]:
                cr.error_count += 1

        if r["purpose"]:
            pr = by_purpose.setdefault(r["purpose"], PurposeRollup(purpose=r["purpose"]))
            pr.call_count += 1
            pr.cost_usd += float(r["cost_usd"])

    for r in tool_rows:
        total.tool_call_count += 1
        total.total_cost_usd += float(r["cost_usd"])
        if not r["success"]:
            total.error_count += 1
        if total.last_event_at is None or r["occurred_at"] > total.last_event_at:
            total.last_event_at = r["occurred_at"]
        if r["cluster"]:
            cr = by_cluster.setdefault(r["cluster"], ClusterRollup(cluster=r["cluster"]))
            cr.tool_call_count += 1
            cr.cost_usd += float(r["cost_usd"])

    return RunLedger(
        session_id=session_id,
        run_total=total,
        by_cluster=by_cluster,
        by_purpose=by_purpose,
    )


# ---------------------------------------------------------------------------
# Convenience: convert a HarnessResult into the record_token_event kwargs
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Tool-call observation context manager
# ---------------------------------------------------------------------------

@asynccontextmanager
async def observe_tool_call(
    pool,
    *,
    session_id: str,
    tool: str,
    originating_user_email: str,
    cluster: Optional[str] = None,
    agent_name: Optional[str] = None,
    cost_usd: float = 0.0,
) -> AsyncIterator[dict[str, Any]]:
    """Wrap a data-source call so its outcome lands in pebble_tool_call_log.

    Usage from a cluster's Doer (Wave 1+):

        async with observe_tool_call(
            pool,
            session_id=sid,
            cluster="cluster_a_financial",
            tool="fec.search_contributions",
            originating_user_email=user.email,
        ) as obs:
            try:
                result = await asyncio.to_thread(fec.search_contributions, name)
                obs["bytes_returned"] = len(json.dumps(result))
                # success implied by absence of exception
            except RateLimitError as e:
                obs["rate_limit_remaining"] = 0
                raise

    Contract:
      * Exceptions inside the block PROPAGATE — the ledger event is
        recorded as success=False with error_class set, then the
        exception re-raises so cluster-level error handling kicks in.
      * The yielded dict accepts mutations during the block:
          obs["bytes_returned"], obs["rate_limit_remaining"],
          obs["rate_limit_reset_at"], obs["cache_hit"],
          obs["cost_usd"] (override the default 0).
      * The ledger record is best-effort: a DB write failure during
        record_tool_call is logged + swallowed by record_tool_call's
        own try/except, so it never re-raises into the cluster code.

    Why a context manager and not a decorator: data sources are sync
    functions called via asyncio.to_thread from the cluster. The
    cluster is the natural place to capture session_id + cluster name
    + user_email (those are run-context, not data-source-context).
    Decorating data sources would require threading those values
    through every signature.
    """
    started_at = time.monotonic()
    obs: dict[str, Any] = {
        "bytes_returned": None,
        "rate_limit_remaining": None,
        "rate_limit_reset_at": None,
        "cache_hit": False,
        "cost_usd": cost_usd,
        "error_class": None,
    }
    success = True
    exc_to_reraise: BaseException | None = None
    try:
        yield obs
    except BaseException as e:
        success = False
        obs["error_class"] = type(e).__name__
        exc_to_reraise = e
    finally:
        elapsed_ms = int((time.monotonic() - started_at) * 1000)
        await record_tool_call(
            pool,
            session_id=session_id,
            tool=tool,
            cluster=cluster,
            agent_name=agent_name,
            cost_usd=float(obs.get("cost_usd") or 0.0),
            success=success,
            elapsed_ms=elapsed_ms,
            bytes_returned=obs.get("bytes_returned"),
            cache_hit=bool(obs.get("cache_hit", False)),
            rate_limit_remaining=obs.get("rate_limit_remaining"),
            rate_limit_reset_at=obs.get("rate_limit_reset_at"),
            error_class=obs.get("error_class"),
            originating_user_email=originating_user_email,
        )
        if exc_to_reraise is not None:
            raise exc_to_reraise


def harness_result_to_event_kwargs(
    result,
    *,
    agent_name: str,
    session_id: Optional[str] = None,
    purpose: Optional[str] = None,
    cluster: Optional[str] = None,
    tier: Optional[str] = None,
    provider: Optional[str] = None,
    model_id: Optional[str] = None,
    redo_attempt: int = 0,
    prospect_id: Optional[str] = None,
    user_email: Optional[str] = None,
) -> dict:
    """Adapter from HarnessResult → record_token_event kwargs.

    HarnessResult.tokens_used is a dict with the four-field shape
    (input / output / cache_create / cache_read) post-2026-05-18.
    Older legacy paths may still produce a two-field dict; we fall
    through with 0 defaults.
    """
    tokens = result.tokens_used if isinstance(result.tokens_used, dict) else {}
    outcome = result.outcome.value if hasattr(result.outcome, "value") else str(result.outcome)
    return dict(
        agent_name=agent_name,
        outcome=outcome,
        cost_usd=float(result.cost_usd or 0.0),
        tokens_input=int(tokens.get("input", 0) or 0),
        tokens_output=int(tokens.get("output", 0) or 0),
        cache_creation_input_tokens=int(tokens.get("cache_create", 0) or 0),
        cache_read_input_tokens=int(tokens.get("cache_read", 0) or 0),
        attempts=int(result.attempts or 0),
        elapsed_seconds=float(result.elapsed_seconds or 0.0),
        error=result.error,
        prospect_id=prospect_id,
        user_email=user_email,
        session_id=session_id,
        purpose=purpose,
        cluster=cluster,
        tier=tier,
        provider=provider,
        model_id=model_id,
        redo_attempt=redo_attempt,
    )
