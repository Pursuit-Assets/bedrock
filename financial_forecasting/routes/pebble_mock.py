"""
Pebble mock SSE endpoint — stand-in for /api/pebble/ask until the
production engine (PR #184) lands on main.

Why this exists:
  • The frontend (Pebble floating box) speaks the canonical
    OrchestratorEvent wire format already. Without a backend it would
    show "engine offline" — useful, but doesn't let JP dogfood the
    full Plan-as-Todos / streaming-response flow today.
  • The real engine lives behind a feature flag in pebble/orchestrator/.
    Standing it up locally requires Anthropic creds, the new
    `bedrock.pebble_chat_scratchpad` table, and PEBBLE_USE_ORCHESTRATOR=true.
    Heavy for a local dogfood loop.
  • This file scripts realistic events so the entire UX (plan
    rendering, step-status transitions, cost meter, citations,
    cancellation) is exercised end-to-end.

How to remove:
  • When the real /api/pebble/ask endpoint lands, delete this file
    and unregister it from main.py. The frontend doesn't change.

Wire format mirrors pebble/orchestrator/sse.py (per PR #184):
    data: {"kind": "<kind>", "payload": <payload>}\n\n
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import uuid
from typing import Any, AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Feature gate. When `PEBBLE_REAL_ENGINE=true`, the mock no-ops with
# a 404 so the real engine can claim the route. Default ON so local
# dev gets the mock without explicit configuration.
MOCK_ENABLED = os.getenv("PEBBLE_REAL_ENGINE", "false").lower() != "true"


# ── SSE encode helpers ─────────────────────────────────────────────


def _event(kind: str, payload: dict[str, Any]) -> str:
    return f"data: {json.dumps({'kind': kind, 'payload': payload})}\n\n"


def _keepalive() -> str:
    return ":keepalive\n\n"


# ── Mock script generation ─────────────────────────────────────────


def _classify(query: str) -> str:
    """Light keyword routing → script id. The mock picks one of a few
    realistic conversation arcs so JP sees variety across queries."""
    q = query.lower()
    if any(k in q for k in ["pipeline", "stage", "weighted", "forecast"]):
        return "pipeline"
    if any(k in q for k in ["goal", "behind", "ahead", "pace", "fy"]):
        return "goal"
    if any(k in q for k in ["account", "goldman", "morgan", "donor"]):
        return "account"
    if any(k in q for k in ["task", "overdue", "todo", "follow up"]):
        return "tasks"
    return "generic"


def _script(query: str, conversation_id: str) -> list[dict[str, Any]]:
    """Return the ordered list of (kind, payload) events for a query.
    Built once per request; the generator below adds timing."""
    script_id = _classify(query)
    plan_id = str(uuid.uuid4())

    if script_id == "pipeline":
        steps = [
            ("fetch_open_opportunities", {"stage_filter": "open"}),
            ("compute_weighted_pipeline", {"horizon_days": 90}),
            ("identify_at_risk", {"threshold_days": 30}),
        ]
        text = (
            "Your open pipeline weighted to $4.2M, with $1.8M closing in the "
            "next 30 days. Three opps are at risk: Goldman Sachs Foundation "
            "(stale 42 days), Bloomberg Philanthropies (no contact in 60 "
            "days), and Robin Hood (overdue close date by 12 days). "
            "Suggested next step: re-engage Goldman this week — they've "
            "moved on the last two cycles after a touchpoint at this stage."
        )
        citations = [
            ("sf_opportunity", "OPP-001", "Goldman Sachs Foundation — AIJI Year 3", "/opportunities/OPP-001"),
            ("sf_opportunity", "OPP-002", "Bloomberg Philanthropies — Workforce", "/opportunities/OPP-002"),
            ("sf_opportunity", "OPP-003", "Robin Hood — Capital Grant", "/opportunities/OPP-003"),
        ]
    elif script_id == "goal":
        steps = [
            ("fetch_owner_goal", {"fy": 2026}),
            ("sum_closed_won", {"fy": 2026}),
            ("project_run_rate", {}),
        ]
        text = (
            "You're at $7.4M closed-won against a $12M FY26 goal — 62% with "
            "39% of the year elapsed. Run-rate projects to $18.9M, putting "
            "you on track. Biggest single lever: Goldman ($2.5M weighted) "
            "closing on time would lock you in above goal by Q3."
        )
        citations = [
            ("owner_goal", "FY26", "FY26 revenue goal", "/settings"),
            ("sf_opportunity", "OPP-001", "Goldman Sachs Foundation — AIJI Year 3", "/opportunities/OPP-001"),
        ]
    elif script_id == "account":
        steps = [
            ("search_accounts", {"query": query}),
            ("aggregate_account_pipeline", {}),
            ("fetch_recent_activity", {"limit": 10}),
        ]
        text = (
            "Goldman Sachs Foundation has 3 open opportunities totaling "
            "$2.5M weighted, with $1.5M expected to close in Q3. Last "
            "activity: a stewardship email 18 days ago. Pattern across "
            "the last three years: they typically respond to a check-in "
            "within 5 business days when one's sent in this window."
        )
        citations = [
            ("sf_account", "ACC-GS", "Goldman Sachs Foundation", "/accounts/ACC-GS"),
        ]
    elif script_id == "tasks":
        steps = [
            ("fetch_my_tasks", {"include_overdue": True}),
            ("group_by_opportunity", {}),
        ]
        text = (
            "You have 7 open tasks — 3 overdue. Highest-priority overdue: "
            "\"Send revised budget to Goldman\" (3 days late). Today's "
            "queue: 2 calls + 1 proposal review. None blocked on others."
        )
        citations = []
    else:
        steps = [
            ("classify_intent", {"query": query}),
            ("compose_response", {}),
        ]
        text = (
            "I'm running in mock mode — the real Pebble engine isn't "
            "wired up locally yet. Once /api/pebble/ask in "
            "pebble/orchestrator/ is reachable, this same flow will hit "
            "real LLMs, real Salesforce data, and a real planner/evaluator "
            "loop. Try asking about \"pipeline\", \"goal\", \"account\", "
            "or \"tasks\" to see different scripted shapes."
        )
        citations = []

    plan_steps = [
        {"step_id": f"step-{i + 1}", "tool": tool, "args": args}
        for i, (tool, args) in enumerate(steps)
    ]

    events: list[dict[str, Any]] = [
        {
            "kind": "plan_emitted",
            "payload": {
                "plan_id": plan_id,
                "rationale": f"[mock] Resolving your query via the '{script_id}' script.",
                "steps": plan_steps,
                "estimated_tool_calls": len(plan_steps),
                "estimated_cost_usd": 0.012 * len(plan_steps),
                "is_replan": False,
            },
        }
    ]
    for s in plan_steps:
        events.append(
            {
                "kind": "tool_call_started",
                "payload": {
                    "step_id": s["step_id"],
                    "tool": s["tool"],
                    "args": s["args"],
                },
            }
        )
        events.append(
            {
                "kind": "tool_call_finished",
                "payload": {
                    "step_id": s["step_id"],
                    "tool": s["tool"],
                    "ok": True,
                    "error": None,
                    "duration_ms": random.randint(180, 520),
                    "cost_usd": round(random.uniform(0.004, 0.018), 4),
                    "tokens_in": random.randint(800, 2400),
                    "tokens_out": random.randint(120, 600),
                    "citation_count": len(citations),
                },
            }
        )

    final_response = {
        "plan_id": plan_id,
        "text": text,
        "citations": [
            {
                "cite_id": f"cite-{i + 1}",
                "entity_type": etype,
                "entity_id": eid,
                "title": title,
                "href": href,
            }
            for i, (etype, eid, title, href) in enumerate(citations)
        ],
        "suggested_actions": [],
        "charts": [],
        "degraded": False,
        "degradation_reason": None,
    }
    # Draft first (incremental render), then final.
    events.append({"kind": "draft_emitted", "payload": {"draft": final_response}})
    events.append(
        {
            "kind": "eval_emitted",
            "payload": {
                "verdict": "pass",
                "factuality": 0.92,
                "completeness": 0.88,
                "harm": "none",
                "rationale": "[mock] Looks coherent and grounded.",
                "cost_usd": 0.003,
                "tokens_in": 600,
                "tokens_out": 80,
            },
        }
    )
    events.append({"kind": "response_final", "payload": {"final": final_response}})
    return events


# ── Streaming generator ────────────────────────────────────────────


async def _stream(query: str, conversation_id: str) -> AsyncGenerator[str, None]:
    events = _script(query, conversation_id)
    for ev in events:
        kind = ev["kind"]
        # Latency profile mimics real LLM-orchestrator pacing without
        # being annoying. Planning is the slowest step; tool calls
        # ~300-500ms; final response near-instant after draft.
        if kind == "plan_emitted":
            await asyncio.sleep(0.6)
        elif kind == "tool_call_started":
            await asyncio.sleep(0.15)
        elif kind == "tool_call_finished":
            duration_ms = ev["payload"].get("duration_ms", 300)
            await asyncio.sleep(duration_ms / 1000)
        elif kind == "draft_emitted":
            await asyncio.sleep(0.25)
        elif kind == "eval_emitted":
            await asyncio.sleep(0.4)
        # response_final fires immediately after eval
        yield _event(kind, ev["payload"])


# ── Route ──────────────────────────────────────────────────────────


@router.post("/api/pebble/ask")
async def pebble_ask_mock(request: Request) -> StreamingResponse:
    """SSE relay → frontend Pebble floating box.

    Body shape (matches services/pebble.ts):
        { query: str, conversation_id?: str, context?: object }
    """
    if not MOCK_ENABLED:
        # When PEBBLE_REAL_ENGINE=true is set in env, the real engine
        # (registered elsewhere) is expected to handle this route.
        # Return 404 so this mock never shadows it.
        return StreamingResponse(
            iter(
                [
                    _event(
                        "error",
                        {
                            "phase": "construction",
                            "reason": "mock_disabled",
                            "detail": "PEBBLE_REAL_ENGINE=true — wire the real engine.",
                            "status": 404,
                        },
                    )
                ]
            ),
            media_type="text/event-stream",
            status_code=404,
        )

    body = await request.json()
    query = (body or {}).get("query", "")
    conversation_id = (body or {}).get("conversation_id") or str(uuid.uuid4())
    if not query.strip():
        return StreamingResponse(
            iter(
                [
                    _event(
                        "error",
                        {"phase": "construction", "reason": "empty_query"},
                    )
                ]
            ),
            media_type="text/event-stream",
        )

    logger.info(
        "[pebble-mock] query=%r conversation_id=%s", query[:80], conversation_id
    )
    return StreamingResponse(
        _stream(query, conversation_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Pebble-Mock": "1"},
    )
