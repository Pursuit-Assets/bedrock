"""Readiness — disambiguation gate for Ask Pebble queries.

Given CRM search results, determines whether a query is ready to process
or needs human clarification.  Pure logic, no I/O — accepts pre-fetched
search results from the CRM bridge.

Three layers:
  1. CRM multi-match: multiple records of same type → CLARIFY
  2. Cross-entity ambiguity: term matches across types → CROSS_ENTITY
  3. Public data identity risk (T2/T3): common name + no org → IDENTITY_RISK
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class ReadinessStatus(str, Enum):
    """Outcome of disambiguation analysis."""
    READY = "ready"
    CLARIFY = "clarify"
    CROSS_ENTITY = "cross_entity"
    NEW_ENTITY = "new_entity"
    IDENTITY_RISK = "identity_risk"


@dataclass
class EntityMatch:
    """A single CRM entity match."""
    entity_type: str          # "Contact", "Account", "Opportunity"
    sf_id: str                # Salesforce record ID
    name: str                 # Display name
    detail: str = ""          # Extra context (title, stage, etc.)
    account_type: str = ""    # Salesforce Account.Type (Corporate, Foundation, etc.)
    account_record_type: str = ""  # Salesforce Account RecordType.Name (Organization, Household)


@dataclass
class ReadinessResult:
    """Outcome of disambiguation analysis."""
    status: ReadinessStatus
    matches: list[EntityMatch] = field(default_factory=list)
    primary_match: Optional[EntityMatch] = None
    entity_groups: Optional[dict[str, list[EntityMatch]]] = None
    message: str = ""
    suggested_question: str = ""


# ---------------------------------------------------------------------------
# Contact display formatting
# ---------------------------------------------------------------------------

def _contact_label(record: dict) -> str:
    """Build a display label for a Contact record."""
    parts = []
    name = record.get("Name") or f"{record.get('FirstName', '')} {record.get('LastName', '')}".strip()
    parts.append(name)
    title = record.get("Title")
    account = (record.get("Account") or {}).get("Name")
    if title and account:
        parts.append(f"{title}, {account}")
    elif title:
        parts.append(title)
    elif account:
        parts.append(account)
    return " — ".join(parts)


def _account_label(record: dict) -> str:
    """Build a display label for an Account record."""
    parts = [record.get("Name", "Unknown Account")]
    acct_type = record.get("Type")
    industry = record.get("Industry")
    if acct_type:
        parts.append(acct_type)
    if industry:
        parts.append(industry)
    return " — ".join(parts)


def _opportunity_label(record: dict) -> str:
    """Build a display label for an Opportunity record."""
    name = record.get("Name", "Unknown Opportunity")
    stage = record.get("StageName", "")
    amount = record.get("Amount")
    account = (record.get("Account") or {}).get("Name", "")
    detail_parts = []
    if stage:
        detail_parts.append(stage)
    if amount:
        detail_parts.append(f"${amount:,.0f}")
    if account:
        detail_parts.append(account)
    detail = " · ".join(detail_parts)
    return f"{name} — {detail}" if detail else name


_LABEL_FN = {
    "Contact": _contact_label,
    "Account": _account_label,
    "Opportunity": _opportunity_label,
}


def _extract_account_fields(rec: dict, obj_type: str) -> tuple[str, str]:
    """Extract account_type and account_record_type from a CRM record."""
    account_type = ""
    account_record_type = ""
    if obj_type == "Account":
        account_type = rec.get("Type") or ""
        record_type = rec.get("RecordType") or {}
        account_record_type = record_type.get("Name", "") if isinstance(record_type, dict) else ""
    elif obj_type in ("Contact", "Opportunity"):
        account = rec.get("Account") or {}
        if isinstance(account, dict):
            account_type = account.get("Type") or ""
    return account_type, account_record_type


def _build_matches(search_results: dict) -> dict[str, list[EntityMatch]]:
    """Convert raw SF search results into grouped EntityMatch lists."""
    groups: dict[str, list[EntityMatch]] = {}
    for obj_type in ("Contact", "Account", "Opportunity"):
        records = search_results.get(obj_type, [])
        label_fn = _LABEL_FN.get(obj_type, lambda r: str(r.get("Name", "")))
        matches = []
        for rec in records:
            sf_id = rec.get("Id", "")
            if not sf_id:
                continue
            acct_type, acct_record_type = _extract_account_fields(rec, obj_type)
            matches.append(EntityMatch(
                entity_type=obj_type,
                sf_id=sf_id,
                name=label_fn(rec),
                detail=rec.get("Title", "") or rec.get("StageName", ""),
                account_type=acct_type,
                account_record_type=acct_record_type,
            ))
        if matches:
            groups[obj_type] = matches
    return groups


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def assess_readiness(
    search_results: dict,
    query_entity_hint: Optional[str] = None,
    tier: str = "T0",
    has_org_context: bool = True,
) -> ReadinessResult:
    """Assess whether a query is ready to proceed or needs disambiguation.

    Args:
        search_results: Output from crm_bridge.search_all() —
            {"Contact": [...], "Account": [...], "Opportunity": [...]}
        query_entity_hint: If the query explicitly mentions a type
            (e.g., "contact Jane"), pass "Contact" to filter to that type.
        tier: Query tier ("T0", "T0.5", "T1", "T2", "T3") — affects
            identity_risk threshold.
        has_org_context: Whether the query includes an organization name.
            When False and tier is T2/T3, triggers identity risk warning.

    Returns:
        ReadinessResult with status and disambiguation data.
    """
    if not search_results:
        search_results = {}

    groups = _build_matches(search_results)

    # Filter to hinted type if provided
    if query_entity_hint and query_entity_hint in groups:
        groups = {query_entity_hint: groups[query_entity_hint]}

    # Flatten all matches
    all_matches = [m for matches in groups.values() for m in matches]
    types_with_matches = list(groups.keys())

    # --- Layer 0: No matches ---
    if not all_matches:
        # For research tiers, check identity risk on new prospects
        if tier in ("T2", "T3") and not has_org_context:
            return ReadinessResult(
                status=ReadinessStatus.IDENTITY_RISK,
                message=(
                    "No CRM match found, and without an organization name, "
                    "public data sources may return results for the wrong person."
                ),
                suggested_question=(
                    "Can you add an organization to narrow down the search? "
                    "Or proceed knowing results may be less reliable."
                ),
            )
        return ReadinessResult(
            status=ReadinessStatus.NEW_ENTITY,
            message="No matching records found in the CRM.",
            suggested_question="Want me to research them as a new prospect?",
        )

    # --- Layer 1: Single match across all types ---
    if len(all_matches) == 1:
        return ReadinessResult(
            status=ReadinessStatus.READY,
            matches=all_matches,
            primary_match=all_matches[0],
        )

    # --- Layer 2: Cross-entity ambiguity ---
    if len(types_with_matches) > 1 and not query_entity_hint:
        return ReadinessResult(
            status=ReadinessStatus.CROSS_ENTITY,
            matches=all_matches,
            entity_groups=groups,
            message=_format_cross_entity_message(groups),
            suggested_question="What are you looking for?",
        )

    # --- Layer 1 (cont.): Multiple matches within one type ---
    if len(all_matches) > 1:
        # Truncate to top 5 for display
        display_matches = all_matches[:5]
        total = len(all_matches)
        msg = _format_multi_match_message(display_matches, total)
        return ReadinessResult(
            status=ReadinessStatus.CLARIFY,
            matches=display_matches,
            message=msg,
            suggested_question="Which one?" if total <= 5 else "Can you be more specific?",
        )

    # Single match in the filtered type
    return ReadinessResult(
        status=ReadinessStatus.READY,
        matches=all_matches,
        primary_match=all_matches[0],
    )


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------

def _format_multi_match_message(matches: list[EntityMatch], total: int) -> str:
    """Format a message for multiple matches within one entity type."""
    entity_type = matches[0].entity_type if matches else "record"
    lines = [f"I found {total} {entity_type.lower()}s matching your query:"]
    for i, m in enumerate(matches, 1):
        lines.append(f"  {i}. {m.name}")
    if total > len(matches):
        lines.append(f"  ... and {total - len(matches)} more. Can you be more specific?")
    return "\n".join(lines)


def _format_cross_entity_message(groups: dict[str, list[EntityMatch]]) -> str:
    """Format a message for cross-entity ambiguity."""
    lines = ["Your query matches several things in Salesforce:"]
    for obj_type, matches in groups.items():
        count = len(matches)
        if count == 1:
            lines.append(f"  {obj_type}: {matches[0].name}")
        else:
            lines.append(f"  {obj_type}: {count} matches")
            for m in matches[:3]:
                lines.append(f"    - {m.name}")
            if count > 3:
                lines.append(f"    ... and {count - 3} more")
    return "\n".join(lines)
