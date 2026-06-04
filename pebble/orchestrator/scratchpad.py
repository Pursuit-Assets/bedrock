"""Scratchpad persistence layer — writes orchestrator steps to
``bedrock.pebble_chat_scratchpad``.

The scratchpad is THE durable state of an orchestrator run. Every
plan emission, tool invocation, tool result, evaluation, conflict,
checkpoint, and error gets a row. This is what lets us:

  * Replay a conversation exactly (debugging "user said X, Pebble
    did Y, why?").
  * Generate training signal from real production traces.
  * Resume a paused conversation from the checkpoint step.
  * Audit cost / latency / call count per conversation.

Insert-only contract — no UPDATE / no DELETE — so reasoning chains
are immutable. Retention via a separate role at the cleanup-job
layer (out of scope here).

Failure semantics: scratchpad writes are best-effort + observable.
A persistence failure logs to Cloud Logging and continues — losing
a step row is acceptable; failing the whole conversation is not.
This module never raises.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional
from uuid import UUID, uuid4

logger = logging.getLogger(__name__)


@dataclass
class ScratchpadStep:
    """An in-memory step before persistence. Mirrors the columns of
    ``bedrock.pebble_chat_scratchpad`` 1:1 for one-line INSERTs.
    """
    conversation_id: UUID
    step_number: int
    step_type: str
    user_email: str
    parent_step_id: Optional[UUID] = None
    tool_name: Optional[str] = None
    tool_args: Optional[dict[str, Any]] = None
    tool_result: Optional[dict[str, Any]] = None
    payload: Optional[dict[str, Any]] = None
    cost_usd: Optional[float] = None
    duration_ms: Optional[int] = None
    tokens_in: Optional[int] = None
    tokens_out: Optional[int] = None
    org_id: str = "pursuit"
    step_id: UUID = None  # type: ignore[assignment]

    def __post_init__(self):
        if self.step_id is None:
            self.step_id = uuid4()


class ScratchpadWriter:
    """Stateful per-conversation step counter + DB writer.

    Why per-instance counter: ``step_number`` is monotonic within a
    conversation. Reading the next number from the DB on each insert
    requires a SELECT-then-INSERT race; tracking it in-process
    eliminates the race for a single-process orchestrator.

    For multi-process orchestrators (a future scale-out), a SEQUENCE
    or advisory-lock pattern would replace this — flagged in
    ``tasks/pebble-bi-architect.md`` as a future concern.
    """

    def __init__(
        self,
        pool,
        conversation_id: UUID,
        user_email: str,
        org_id: str = "pursuit",
    ) -> None:
        self._pool = pool
        self.conversation_id = conversation_id
        self.user_email = user_email
        self.org_id = org_id
        self._next_step_number = 1

    def _make_step(
        self,
        step_type: str,
        **kwargs: Any,
    ) -> ScratchpadStep:
        step = ScratchpadStep(
            conversation_id=self.conversation_id,
            step_number=self._next_step_number,
            step_type=step_type,
            user_email=self.user_email,
            org_id=self.org_id,
            **kwargs,
        )
        self._next_step_number += 1
        return step

    async def append(self, step: ScratchpadStep) -> Optional[UUID]:
        """INSERT and return the step_id on success, None on failure."""
        if self._pool is None:
            return step.step_id
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    INSERT INTO bedrock.pebble_chat_scratchpad (
                        id, conversation_id, parent_step_id, step_number,
                        step_type, tool_name, tool_args, tool_result,
                        payload, cost_usd, duration_ms,
                        tokens_in, tokens_out, user_email, org_id
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9,
                        $10, $11, $12, $13, $14, $15
                    )
                    RETURNING id
                    """,
                    step.step_id, step.conversation_id, step.parent_step_id,
                    step.step_number, step.step_type, step.tool_name,
                    _to_json(step.tool_args), _to_json(step.tool_result),
                    _to_json(step.payload),
                    step.cost_usd, step.duration_ms,
                    step.tokens_in, step.tokens_out,
                    step.user_email, step.org_id,
                )
                return row["id"] if row else step.step_id
        except Exception:
            logger.exception(
                "scratchpad_insert_failed conversation_id=%s step_type=%s",
                step.conversation_id, step.step_type,
            )
            return None

    # ---- Convenience methods, one per step_type ------------------------

    async def write_plan(
        self, plan_payload: dict[str, Any], **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "plan", payload=plan_payload, **kw,
        ))

    async def write_tool_call(
        self, tool_name: str, tool_args: dict[str, Any],
        parent_step_id: Optional[UUID] = None, **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "tool_call", tool_name=tool_name, tool_args=tool_args,
            parent_step_id=parent_step_id, **kw,
        ))

    async def write_tool_result(
        self, tool_name: str, tool_result: dict[str, Any],
        parent_step_id: Optional[UUID] = None,
        cost_usd: Optional[float] = None, duration_ms: Optional[int] = None,
        **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "tool_result", tool_name=tool_name, tool_result=tool_result,
            parent_step_id=parent_step_id, cost_usd=cost_usd,
            duration_ms=duration_ms, **kw,
        ))

    async def write_evaluation(
        self, eval_payload: dict[str, Any],
        parent_step_id: Optional[UUID] = None, **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "evaluation", payload=eval_payload,
            parent_step_id=parent_step_id, **kw,
        ))

    async def write_render(
        self, render_payload: dict[str, Any], **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "render", payload=render_payload, **kw,
        ))

    async def write_conflict(
        self, conflict_payload: dict[str, Any], **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "conflict", payload=conflict_payload, **kw,
        ))

    async def write_checkpoint(
        self, checkpoint_payload: dict[str, Any], **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "checkpoint", payload=checkpoint_payload, **kw,
        ))

    async def write_error(
        self, error_payload: dict[str, Any], **kw: Any,
    ) -> Optional[UUID]:
        return await self.append(self._make_step(
            "error", payload=error_payload, **kw,
        ))


def _to_json(value: Optional[dict[str, Any]]) -> Optional[str]:
    """asyncpg accepts JSONB as JSON-string. Pre-serialize so dicts
    with UUID / datetime values don't crash the driver.
    """
    if value is None:
        return None
    return json.dumps(value, default=str)
