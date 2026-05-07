"""LLM-driven planner for the Pebble chat orchestrator.

The planner is the *one* place an LLM is allowed to be creative with
control flow. It reads the user query, the registered tools, and a
short conversation context, then emits a Plan: a DAG of PlanStep
objects the executor will run mechanically.

Pattern: orchestrator-worker — the planner is the orchestrator brain,
the executor is the dumb worker. Pure planning ⇒ pure execution =
deterministic replay, lower variance, easier audit.

Why a separate module instead of "just call Sonnet inline":
  * Schema-validate every PlanStep.args against the actual tool's
    JSON schema BEFORE the executor runs anything. The planner can
    hallucinate — Sonnet is creative but fallible; we catch the
    hallucination before it costs a tool call.
  * Retry-on-malformed: if the planner emits invalid JSON or a
    step that doesn't match a registered tool, we feed the error
    back ONCE and re-prompt. Twice would let it spin; once is the
    sweet spot.
  * Dependency-injected client: the AnthropicClient protocol means
    tests pass a stub that returns canned plans. No real API calls
    in unit tests.

Input contract:
    plan = await planner.plan(
        user_query="What's the current pipeline for Acme?",
        ctx=ToolContext(...),
        registry=ToolRegistry,
        budget_hint=Budget,
        recent_messages=[],   # optional short context
    )

Output contract:
    Plan(steps=(PlanStep(tool="search_crm", args={...}), ...))

Halt reasons returned as PlannerError (not raised) so the
orchestrator can write a clean ``error`` scratchpad row instead of
propagating an exception.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional, Protocol
from uuid import UUID, uuid4

import jsonschema
from pydantic import ValidationError

from .schemas import Plan, PlanStep
from .tools import ToolContext, ToolRegistry, ToolSpec

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# LLM client protocol — what the planner needs from Anthropic. Tests
# inject a stub that records prompts and returns canned text.
# ---------------------------------------------------------------------------

class PlannerLLMClient(Protocol):
    """Minimal protocol for the planner's LLM dependency.

    Implementations call Anthropic's Messages API with the system
    prompt + tool defs and return the assistant's plan text plus
    cost / token usage. Real impl in ``pebble.llm.anthropic_client``;
    test impl returns canned text.
    """

    async def emit_plan(
        self,
        *,
        system: str,
        user: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 2048,
    ) -> "PlannerLLMResponse": ...


@dataclass(frozen=True)
class PlannerLLMResponse:
    """Standard return shape so any client (Anthropic SDK, Bedrock,
    a test stub) plugs in.
    """
    text: str
    cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    stop_reason: str = "end_turn"


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class PlannerError:
    """Returned (not raised) when planning fails after retry. The
    orchestrator writes an ``error`` scratchpad row and surfaces a
    'Pebble couldn't plan this — please rephrase' to the user.
    """
    reason: str
    detail: str = ""
    last_response_text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "reason": self.reason,
            "detail": self.detail,
            "last_response_text": self.last_response_text[:500],
        }


# ---------------------------------------------------------------------------
# Prompt — system + user templates. Kept here, not in a separate file,
# because the prompt structure is part of the planner's contract.
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are Pebble's planner — the brain of a CRM/business-intelligence
assistant for Pursuit, a nonprofit accelerator that funds founders.

Your job: read the user's question, decide which tools to call, and
emit a JSON plan. The executor runs your plan mechanically — it has
NO judgment, so your plan must be precise.

# Output format

Emit a single JSON object on one line, no prose, no markdown fences.
Schema:

  {
    "rationale": "brief one-sentence reasoning",
    "estimated_tool_calls": 0-20,
    "estimated_cost_usd": 0.0-0.50,
    "steps": [
      {
        "id": "s1",
        "tool": "<tool_name from the available list>",
        "args": { ... matching the tool's input_schema },
        "expected_shape": "what kind of data this should return",
        "success_criteria": "what makes this step useful",
        "depends_on": ["s0", ...]   // ids of prior steps; [] for none
      }
    ]
  }

# Rules

  1. Only use tools from the available list. Never invent tools.
  2. Match each tool's input_schema exactly — strict mode.
  3. depends_on must reference earlier step ids in the same plan.
  4. Prefer fewer steps; one tool call is better than three when one suffices.
  5. If the user asks something a tool can't answer, emit an empty
     steps list and put the reason in rationale. Do NOT hallucinate
     a tool call to placate the user.
  6. If the user asks for an irreversible write (update, delete, send),
     plan a request_human_review step FIRST so the user can confirm.
  7. estimated_cost_usd is your honest forecast — if you're not sure,
     guess high; the executor will hard-cap if you exceed.

# Style

  * Concise rationale. 'User wants pipeline info; search then drill in.'
  * Don't apologize, hedge, or chat. Plan only.
"""


_USER_PROMPT_TEMPLATE = """\
User query:
{user_query}

Available tools (only these are valid):
{tool_list}

Recent conversation context (may be empty):
{recent_context}

Emit the plan JSON now.
"""


_RETRY_SUFFIX = """\

Your previous response was REJECTED with this error:
{error}

The original query is unchanged. Re-emit a corrected plan now.
"""


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------

class Planner:
    """Pure planner. One method: ``plan(...)``. Holds no state; the
    same instance can plan many conversations in parallel.
    """

    def __init__(
        self,
        client: PlannerLLMClient,
        registry: ToolRegistry,
        *,
        max_steps: int = 10,
        max_retries: int = 1,
    ) -> None:
        self.client = client
        self.registry = registry
        self.max_steps = max_steps
        self.max_retries = max_retries

    async def plan(
        self,
        *,
        user_query: str,
        ctx: ToolContext,
        recent_messages: Optional[list[dict[str, str]]] = None,
    ) -> Plan | PlannerError:
        """Emit a Plan, or return a PlannerError if the LLM can't
        produce a valid plan even after the retry.

        Never raises. Logs on every malformed attempt.
        """
        if not user_query or not user_query.strip():
            return PlannerError(
                reason="empty_query",
                detail="Planner.plan called with empty user_query",
            )

        tool_specs = self.registry.iter_specs()
        if not tool_specs:
            return PlannerError(
                reason="no_tools_registered",
                detail="ToolRegistry empty — planner has nothing to plan with",
            )

        tool_list_block = _format_tool_list(tool_specs)
        recent_block = _format_recent_context(recent_messages or [])

        user_prompt = _USER_PROMPT_TEMPLATE.format(
            user_query=user_query.strip(),
            tool_list=tool_list_block,
            recent_context=recent_block or "(none)",
        )

        last_text = ""
        last_error = ""

        for attempt in range(self.max_retries + 1):
            if attempt > 0:
                user_prompt_with_retry = (
                    user_prompt
                    + _RETRY_SUFFIX.format(error=last_error)
                )
            else:
                user_prompt_with_retry = user_prompt

            try:
                resp = await self.client.emit_plan(
                    system=_SYSTEM_PROMPT,
                    user=user_prompt_with_retry,
                    tools=self.registry.to_anthropic_list(),
                )
            except Exception as e:
                logger.exception("planner.llm_call_failed attempt=%d", attempt)
                last_error = f"{type(e).__name__}: {e}"
                last_text = ""
                continue

            last_text = resp.text or ""

            parse_error = _try_parse_plan(
                resp.text,
                user_query=user_query.strip(),
                registry=self.registry,
                max_steps=self.max_steps,
            )
            if isinstance(parse_error, Plan):
                return parse_error
            last_error = parse_error
            logger.warning(
                "planner.malformed_plan attempt=%d error=%s",
                attempt, parse_error,
            )

        return PlannerError(
            reason="planner_max_retries_exceeded",
            detail=last_error,
            last_response_text=last_text,
        )


# ---------------------------------------------------------------------------
# Parsing + validation
# ---------------------------------------------------------------------------

def _try_parse_plan(
    text: str,
    *,
    user_query: str,
    registry: ToolRegistry,
    max_steps: int,
) -> Plan | str:
    """Validate the LLM output. Returns a Plan on success or an
    error string on failure (suitable for the retry prompt).
    """
    raw = (text or "").strip()
    if not raw:
        return "empty response from planner"

    raw = _strip_code_fence(raw)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        return f"output is not valid JSON: {e.msg} at line {e.lineno} col {e.colno}"

    if not isinstance(parsed, dict):
        return f"top-level must be an object, got {type(parsed).__name__}"

    raw_steps = parsed.get("steps")
    if not isinstance(raw_steps, list):
        return "missing or non-list 'steps' field"
    if len(raw_steps) > max_steps:
        return f"plan has {len(raw_steps)} steps; max is {max_steps}"

    rationale = str(parsed.get("rationale") or "").strip()

    try:
        estimated_cost_usd = float(parsed.get("estimated_cost_usd") or 0.0)
        estimated_tool_calls = int(parsed.get("estimated_tool_calls") or len(raw_steps))
    except (TypeError, ValueError) as e:
        return f"invalid numeric estimate fields: {e}"

    # Empty plan = "I can't help with this." Surface as a Plan with no
    # steps so the executor writes a normal completion (the renderer
    # turns this into an apology).
    if not raw_steps:
        return Plan(
            user_query=user_query,
            steps=(),
            rationale=rationale or "Planner returned no actionable steps.",
            estimated_cost_usd=estimated_cost_usd,
            estimated_tool_calls=0,
        )

    # Two-pass: build PlanStep objects (auto-mints uuid), then resolve
    # the LLM's string-id depends_on into the minted UUIDs.
    id_map: dict[str, UUID] = {}
    pending: list[tuple[dict[str, Any], list[str]]] = []

    for idx, raw_step in enumerate(raw_steps):
        if not isinstance(raw_step, dict):
            return f"step {idx} is not an object"

        sid = str(raw_step.get("id") or f"s{idx}")
        if sid in id_map:
            return f"duplicate step id {sid!r}"
        tool_name = raw_step.get("tool")
        if not isinstance(tool_name, str) or not tool_name.strip():
            return f"step {sid}: missing or non-string 'tool'"
        spec = registry.get(tool_name)
        if spec is None:
            return (
                f"step {sid}: tool {tool_name!r} not in registry "
                f"(known: {registry.names()})"
            )

        args = raw_step.get("args") or {}
        if not isinstance(args, dict):
            return f"step {sid}: args must be an object, got {type(args).__name__}"

        try:
            jsonschema.validate(args, spec.input_schema)
        except jsonschema.ValidationError as e:
            return (
                f"step {sid} ({tool_name}): args fail schema validation: "
                f"{e.message} (path: {list(e.absolute_path)})"
            )

        deps = raw_step.get("depends_on") or []
        if not isinstance(deps, list):
            return f"step {sid}: depends_on must be a list"
        for d in deps:
            if not isinstance(d, str):
                return f"step {sid}: depends_on entries must be strings"
            if d not in id_map:
                return f"step {sid}: depends_on {d!r} not a prior step"

        new_step_id = uuid4()
        id_map[sid] = new_step_id
        pending.append((raw_step, deps))

    # Build the immutable PlanStep tuple in order.
    steps_built: list[PlanStep] = []
    for (raw_step, deps), (sid, step_uuid) in zip(pending, id_map.items()):
        try:
            step = PlanStep(
                step_id=step_uuid,
                tool=raw_step["tool"],
                args=raw_step.get("args") or {},
                expected_shape=str(raw_step.get("expected_shape") or ""),
                success_criteria=str(raw_step.get("success_criteria") or ""),
                depends_on=tuple(id_map[d] for d in deps),
            )
        except (ValidationError, ValueError) as e:
            return f"step {sid}: failed to construct PlanStep: {e}"
        steps_built.append(step)

    try:
        return Plan(
            user_query=user_query,
            steps=tuple(steps_built),
            rationale=rationale,
            estimated_cost_usd=estimated_cost_usd,
            estimated_tool_calls=estimated_tool_calls,
        )
    except (ValidationError, ValueError) as e:
        return f"plan-level validation failed: {e}"


def _strip_code_fence(s: str) -> str:
    """LLMs frequently wrap JSON in ```json ... ``` despite the system
    prompt telling them not to. Strip it tolerantly.
    """
    s = s.strip()
    if s.startswith("```"):
        # Drop the first line (```json or ```) and the trailing fence.
        lines = s.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    return s


def _format_tool_list(specs: list[ToolSpec]) -> str:
    """Concise Markdown list — name, description (1 line), schema
    keys. Full schema goes via the Anthropic tools= API arg, not the
    prompt body, but we restate names + summaries so the planner has
    them inline.
    """
    lines: list[str] = []
    for s in specs:
        props = s.input_schema.get("properties", {}) if isinstance(s.input_schema, dict) else {}
        required = s.input_schema.get("required", []) if isinstance(s.input_schema, dict) else []
        keys = ", ".join(
            f"{k}{'*' if k in required else ''}"
            for k in props
        ) or "(no args)"
        first_line = (s.description or "").split("\n", 1)[0].strip()
        lines.append(f"- **{s.name}** — {first_line}\n  args: {keys}")
    return "\n".join(lines)


def _format_recent_context(messages: list[dict[str, str]]) -> str:
    """Compact role/content rendering. Bounded to the last ~6 turns
    so we don't blow the context window on long conversations.
    """
    if not messages:
        return ""
    tail = messages[-6:]
    lines: list[str] = []
    for m in tail:
        role = str(m.get("role", "?")).strip() or "?"
        content = str(m.get("content", "")).strip().replace("\n", " ")
        if len(content) > 240:
            content = content[:240] + "…"
        lines.append(f"{role}: {content}")
    return "\n".join(lines)
