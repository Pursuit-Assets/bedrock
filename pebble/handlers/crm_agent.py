"""CRM tool-use agent — replaces hardcoded L0/L1 handlers.

A single Haiku-powered agent with 5 CRM tools that can chain multi-step
lookups and return natural language answers. Bounded by max tool calls,
wall-clock timeout, and per-query cost cap.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Optional

from ..router import RouteResult
from ..tools.crm_tools import CRM_TOOLS, execute_tool
from . import HandlerResponse

logger = logging.getLogger("pebble.handlers.crm_agent")

# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------

MAX_TOOL_CALLS = 5
TIMEOUT_SECONDS = 15.0
COST_CAP_USD = 0.02

# Haiku cost rates (per million tokens)
_HAIKU_INPUT_COST_PER_MTOK = 1.0
_HAIKU_OUTPUT_COST_PER_MTOK = 5.0

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

_CRM_AGENT_SYSTEM = """\
You are Pebble, a CRM intelligence assistant for a nonprofit fundraising team at Pursuit.

You have access to tools that query the Salesforce CRM. Use them to answer the user's question.

GUIDELINES:
- Be concise and factual. Cite specific record names and numbers.
- Use markdown: **bold** for names and amounts, bullet lists for multiple items.
- If a search returns no results, say so clearly. Do not invent data.
- For multi-step questions (e.g., "What's the pipeline for Goldman Sachs?"), \
chain tool calls: first search for the account, then search opportunities by account_id.
- If a question is ambiguous or matches multiple records, list the matches \
and ask the user to clarify.
- For pipeline or aggregate questions, compute totals from the data returned by tools.
- Keep answers to 2-5 sentences for simple lookups, longer for analysis.
- When listing records, cap at 10 items and note if there are more.
"""


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

async def handle_crm_agent(
    route: RouteResult,
    crm_bridge,
    search_results: Optional[dict],
    conversation_context: Optional[list[dict]],
    client,
) -> HandlerResponse:
    """Handle T0/T0.5 queries using a Haiku tool-use agent.

    Args:
        route: Classified query from the router.
        crm_bridge: CRM bridge module (pebble.crm_bridge).
        search_results: Pre-fetched CRM search results from disambiguation.
        conversation_context: Recent messages [{"role": ..., "content": ...}].
        client: ModelClient instance.

    Returns:
        HandlerResponse with natural language answer and structured data.
    """
    start = time.monotonic()
    total_cost = 0.0
    tool_call_count = 0
    collected_data: dict = {}

    messages = _build_initial_messages(route, search_results, conversation_context)

    try:
        for _iteration in range(MAX_TOOL_CALLS):
            # Timeout check
            elapsed = time.monotonic() - start
            if elapsed > TIMEOUT_SECONDS:
                logger.warning("CRM agent timed out after %.1fs", elapsed)
                break

            # Call Haiku with tools
            result = client.complete_with_tools(
                agent_name="crm_agent",
                messages=messages,
                system=_CRM_AGENT_SYSTEM,
                tools=CRM_TOOLS,
            )

            # Track cost
            usage = result.get("usage", {})
            turn_cost = _calculate_turn_cost(usage)
            total_cost += turn_cost

            # Budget check
            if total_cost > COST_CAP_USD:
                logger.warning("CRM agent exceeded cost cap ($%.4f > $%.2f)",
                               total_cost, COST_CAP_USD)
                # Try to extract any text from this last response
                final_text = _extract_text(result["message"])
                if final_text:
                    return HandlerResponse(
                        text=final_text,
                        level=route.level,
                        intent=route.intent,
                        cost_usd=total_cost,
                        data=collected_data or None,
                    )
                break

            response_message = result["message"]
            stop_reason = result["stop_reason"]

            # Model finished with text — we're done
            if stop_reason == "end_turn":
                final_text = _extract_text(response_message)
                return HandlerResponse(
                    text=final_text or "I found CRM data but couldn't form a response.",
                    level=route.level,
                    intent=route.intent,
                    cost_usd=total_cost,
                    data=collected_data or None,
                )

            # Model wants to use tools — execute them
            if stop_reason == "tool_use":
                # Append assistant message (with tool_use blocks)
                messages.append(response_message)

                # Execute each tool_use block
                tool_results = []
                for block in response_message["content"]:
                    if block["type"] != "tool_use":
                        continue

                    tool_call_count += 1
                    logger.info("CRM agent tool call #%d: %s(%s)",
                                tool_call_count, block["name"],
                                json.dumps(block["input"], default=str)[:100])

                    tool_result_str = await execute_tool(
                        block["name"], block["input"], crm_bridge,
                    )

                    # Store structured data for response
                    try:
                        parsed = json.loads(tool_result_str)
                        collected_data[block["name"]] = parsed
                    except (json.JSONDecodeError, TypeError):
                        pass

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block["id"],
                        "content": tool_result_str,
                    })

                # Append tool results as user message
                messages.append({"role": "user", "content": tool_results})
                continue

            # Unexpected stop reason (max_tokens, etc.) — break
            logger.warning("CRM agent unexpected stop_reason: %s", stop_reason)
            final_text = _extract_text(response_message)
            if final_text:
                return HandlerResponse(
                    text=final_text,
                    level=route.level,
                    intent=route.intent,
                    cost_usd=total_cost,
                    data=collected_data or None,
                )
            break

    except Exception as e:
        logger.error("CRM agent failed: %s", e, exc_info=True)
        return HandlerResponse(
            text="I ran into an error looking that up in the CRM. Please try again.",
            level=route.level,
            intent=route.intent,
            cost_usd=total_cost,
        )

    # Fallback: loop exhausted or timed out without a final answer
    return HandlerResponse(
        text="I wasn't able to complete that CRM lookup. Try a simpler question or check back shortly.",
        level=route.level,
        intent=route.intent,
        cost_usd=total_cost,
        data=collected_data or None,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_initial_messages(
    route: RouteResult,
    search_results: Optional[dict],
    conversation_context: Optional[list[dict]],
) -> list[dict]:
    """Assemble the initial messages array for the tool-use agent."""
    messages: list[dict] = []

    # Prepend conversation history (last 3 turns = 6 messages max).
    # Anthropic requires messages to alternate user/assistant, starting with user.
    # Filter out any messages that would break alternation (e.g., orphaned from a crash).
    if conversation_context:
        for msg in conversation_context[-6:]:
            role = msg["role"]
            # Skip if this would create consecutive same-role messages
            if messages and messages[-1]["role"] == role:
                continue
            messages.append({"role": role, "content": msg["content"]})
        # Ensure history ends with assistant (so our user query continues the pattern)
        if messages and messages[-1]["role"] == "user":
            messages.pop()

    # Build user message with optional CRM context
    user_parts = []

    if search_results:
        search_term = (
            route.entities.get("person_name")
            or route.entities.get("org_name")
            or "the query"
        )
        # Summarize pre-fetched results so the agent doesn't re-search
        context_summary = _summarize_search_results(search_results)
        if context_summary:
            user_parts.append(
                f"CRM search already found these results for '{search_term}':\n"
                f"{context_summary}\n"
                f"Use these or call additional tools as needed.\n"
            )

    # The original query text is stashed in entities by main.py before dispatch.
    # Fallback: reconstruct from entity names + intent.
    query_text = route.entities.get("original_query", "")
    if not query_text:
        name = route.entities.get("person_name") or route.entities.get("org_name") or ""
        query_text = f"Look up {name}" if name else f"CRM query (intent: {route.intent})"
    user_parts.append(query_text)

    messages.append({"role": "user", "content": "\n".join(user_parts)})
    return messages


def _summarize_search_results(search_results: dict) -> str:
    """Create a concise text summary of pre-fetched CRM search results."""
    parts = []
    for entity_type in ("Contact", "Account", "Opportunity"):
        records = search_results.get(entity_type, [])
        if not records:
            continue
        parts.append(f"{entity_type}s ({len(records)}):")
        for r in records[:5]:
            name = r.get("Name", "Unknown")
            detail = ""
            if entity_type == "Contact":
                title = r.get("Title", "")
                account = (r.get("Account") or {}).get("Name", "")
                if title or account:
                    detail = f" — {title}" + (f" at {account}" if account else "")
            elif entity_type == "Account":
                acct_type = r.get("Type", "")
                if acct_type:
                    detail = f" ({acct_type})"
            elif entity_type == "Opportunity":
                amount = r.get("Amount")
                stage = r.get("StageName", "")
                amt_str = f"${float(amount):,.0f}" if amount else ""
                detail = f" — {amt_str} ({stage})" if amt_str else f" ({stage})"
            parts.append(f"  - {name}{detail}")
        if len(records) > 5:
            parts.append(f"  ... and {len(records) - 5} more")
    return "\n".join(parts)


def _extract_text(message: dict) -> str:
    """Extract text content from an assistant message's content blocks."""
    texts = []
    for block in message.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            texts.append(block["text"])
    return "\n".join(texts)


def _calculate_turn_cost(usage: dict) -> float:
    """Calculate Haiku cost for a single API turn."""
    input_tokens = usage.get("input", 0)
    output_tokens = usage.get("output", 0)
    return (
        (input_tokens * _HAIKU_INPUT_COST_PER_MTOK
         + output_tokens * _HAIKU_OUTPUT_COST_PER_MTOK)
        / 1_000_000
    )
