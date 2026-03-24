"""CRM tool definitions for the Haiku tool-use agent.

Each tool wraps a crm_bridge async method. Tool schemas follow the
Anthropic tool-use format (name, description, input_schema).
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger("pebble.tools.crm_tools")

# ---------------------------------------------------------------------------
# Tool schemas (Anthropic tools parameter format)
# ---------------------------------------------------------------------------

CRM_TOOLS: list[dict[str, Any]] = [
    {
        "name": "crm_search",
        "description": (
            "Cross-entity search across Contacts, Accounts, and Opportunities. "
            "Returns results grouped by entity type. Use this when you need to "
            "find any record by name or keyword, or when you don't know what "
            "entity type the user is asking about."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search term (name, keyword, or phrase)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results per entity type (default 10)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "crm_contacts",
        "description": (
            "Search for contacts (people) by name or email. Returns contact "
            "details including Name, Title, Email, Phone, and associated "
            "Account. Use this when you specifically need information about "
            "a person in the CRM."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Contact name or email to search for",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 10)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "crm_accounts",
        "description": (
            "Search for accounts (organizations) by name. Returns account "
            "details including Name, Type, Industry, and record type. Use "
            "this when you need information about an organization, "
            "foundation, or company in the CRM."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Account/organization name to search for",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 10)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "crm_opportunities",
        "description": (
            "Search for opportunities (deals/grants) by name, optionally "
            "filtered by a specific account. Returns opportunity details "
            "including Name, Amount, Stage, Close Date, and Owner. Use this "
            "for deal/grant lookups or when you need to find opportunities "
            "associated with a specific account."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Opportunity name or keyword to search for",
                },
                "account_id": {
                    "type": "string",
                    "description": "Salesforce Account ID to filter by (optional)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results (default 10)",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "crm_pipeline",
        "description": (
            "Get all opportunities in the pipeline, optionally filtered by "
            "stage name. Returns opportunity details including Name, Amount, "
            "Stage, Close Date, and Owner. Use this for pipeline overview "
            "queries, total pipeline value, or when the user asks about "
            "deals in a specific stage."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "stage": {
                    "type": "string",
                    "description": (
                        "Filter by stage name (e.g., 'Prospecting', "
                        "'Closed Won', 'Closed Lost'). Omit to get all stages."
                    ),
                },
            },
            "required": [],
        },
    },
]


# ---------------------------------------------------------------------------
# Write tool schemas (conditionally included based on user permissions)
# ---------------------------------------------------------------------------

CRM_WRITE_TOOLS: list[dict[str, Any]] = [
    {
        "name": "crm_create_account",
        "description": (
            "Create a new account (organization) in Salesforce. "
            "Only call AFTER the user explicitly confirms they want to create this record. "
            "Returns the new Salesforce record ID on success."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Account/organization name (required)",
                },
                "account_type": {
                    "type": "string",
                    "description": "Account type (e.g., 'Foundation', 'Corporate', 'Individual')",
                },
                "industry": {
                    "type": "string",
                    "description": "Industry (e.g., 'Technology', 'Finance', 'Nonprofit')",
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "crm_create_contact",
        "description": (
            "Create a new contact (person) in Salesforce. "
            "Only call AFTER the user explicitly confirms they want to create this record. "
            "Returns the new Salesforce record ID on success."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "first_name": {
                    "type": "string",
                    "description": "Contact's first name (required)",
                },
                "last_name": {
                    "type": "string",
                    "description": "Contact's last name (required)",
                },
                "account_id": {
                    "type": "string",
                    "description": "Salesforce Account ID to associate with (optional)",
                },
                "title": {
                    "type": "string",
                    "description": "Job title (optional)",
                },
                "email": {
                    "type": "string",
                    "description": "Email address (optional)",
                },
            },
            "required": ["first_name", "last_name"],
        },
    },
]


# ---------------------------------------------------------------------------
# Tool executor — dispatches tool calls to crm_bridge methods
# ---------------------------------------------------------------------------

def _check_write_permission(user_permissions: dict | None) -> bool:
    """Check if the user has CRM write permission."""
    if not user_permissions:
        return False
    return bool(user_permissions.get("crm_write"))


async def execute_tool(
    tool_name: str, tool_input: dict, crm_bridge,
    user_permissions: dict | None = None,
) -> str:
    """Execute a CRM tool and return a JSON string result.

    Returns JSON string because Anthropic tool_result content must be a string.
    On failure (bridge returns None), returns a JSON error message so the
    agent can handle it gracefully.
    """
    # Write tools require explicit permission (defense-in-depth)
    if tool_name.startswith("crm_create_") and not _check_write_permission(user_permissions):
        return json.dumps({"error": "CRM write access denied."})

    try:
        result = await _dispatch(tool_name, tool_input, crm_bridge)
    except Exception as e:
        logger.error("Tool execution error for %s: %s", tool_name, e)
        return json.dumps({"error": f"Tool execution failed: {e}"})

    if result is None:
        return json.dumps(
            {"error": "CRM operation failed — the system may be temporarily unavailable."}
        )

    return json.dumps(result, default=str)


async def _dispatch(tool_name: str, tool_input: dict, crm_bridge) -> Any:
    """Route a tool call to the matching crm_bridge method."""
    query = tool_input.get("query", "")
    limit = tool_input.get("limit", 10)

    if tool_name == "crm_search":
        return await crm_bridge.search_all(query, limit=limit)

    if tool_name == "crm_contacts":
        return await crm_bridge.search_contacts(query, limit=limit)

    if tool_name == "crm_accounts":
        return await crm_bridge.search_accounts(query, limit=limit)

    if tool_name == "crm_opportunities":
        account_id = tool_input.get("account_id")
        return await crm_bridge.search_opportunities(
            query, account_id=account_id, limit=limit,
        )

    if tool_name == "crm_pipeline":
        stage = tool_input.get("stage")
        return await crm_bridge.get_opportunities(stage=stage)

    if tool_name == "crm_create_account":
        return await crm_bridge.create_account(
            name=tool_input.get("name", ""),
            account_type=tool_input.get("account_type", ""),
            industry=tool_input.get("industry", ""),
        )

    if tool_name == "crm_create_contact":
        return await crm_bridge.create_contact(
            first_name=tool_input.get("first_name", ""),
            last_name=tool_input.get("last_name", ""),
            account_id=tool_input.get("account_id"),
            title=tool_input.get("title", ""),
            email=tool_input.get("email", ""),
        )

    raise ValueError(f"Unknown tool: {tool_name}")
