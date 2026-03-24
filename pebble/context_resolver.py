"""Pronoun resolution for Ask Pebble chat context.

Scans the user query for pronouns (she, her, him, etc.) and resolves them
to concrete entity names by looking back through the conversation history.
"""

import logging
import re

logger = logging.getLogger("pebble.context_resolver")

_PERSON_PRONOUNS = re.compile(
    r"\b(she|her|him|he|that\s+person|this\s+person)\b", re.IGNORECASE
)
_ORG_PRONOUNS = re.compile(
    r"\b(that\s+org|that\s+organization|that\s+company|this\s+org)\b", re.IGNORECASE
)
_ALL_PRONOUNS = re.compile(
    r"\b(she|her|him|he|they|them|that\s+person|that\s+org|that\s+organization|that\s+company|this\s+person|this\s+org)\b",
    re.IGNORECASE,
)
_BOLD_NAME = re.compile(r"\*\*([^*]+)\*\*")


def resolve_pronouns(query: str, conversation_id: str | None) -> str:
    """Replace pronoun references with concrete entity names from conversation history.

    Returns the query unchanged if:
    - No pronoun is detected
    - No conversation_id is provided
    - No entity can be found in recent messages
    """
    if not _ALL_PRONOUNS.search(query):
        logger.debug("No pronouns detected in query")
        return query

    if conversation_id is None:
        logger.debug("Pronoun detected but no conversation_id — returning as-is")
        return query

    # Lazy import to avoid circular dependencies at module level
    from .storage.db import get_conversation_messages

    messages = get_conversation_messages(conversation_id, limit=10)
    if not messages:
        logger.debug("No messages found for conversation %s", conversation_id)
        return query

    # Scan assistant messages in reverse chronological order for entity names
    person_name: str | None = None
    org_name: str | None = None

    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue

        # Primary: check metadata entities
        metadata = msg.get("metadata") or {}
        entities = metadata.get("entities") or {}

        if not person_name and entities.get("person_name"):
            person_name = entities["person_name"]
            logger.debug("Found person_name in metadata: %s", person_name)

        if not org_name and entities.get("org_name"):
            org_name = entities["org_name"]
            logger.debug("Found org_name in metadata: %s", org_name)

        # Fallback: scan content for bold names
        if (not person_name or not org_name) and msg.get("content"):
            bold_matches = _BOLD_NAME.findall(msg["content"])
            for name in bold_matches:
                if not person_name:
                    person_name = name
                    logger.debug("Found name via bold fallback: %s", name)
                    break

        if person_name and org_name:
            break

    resolved = query

    # Substitute person pronouns
    if person_name and _PERSON_PRONOUNS.search(resolved):
        resolved = _PERSON_PRONOUNS.sub(person_name, resolved)
        logger.info("Resolved person pronouns to '%s'", person_name)

    # Substitute org pronouns
    if org_name and _ORG_PRONOUNS.search(resolved):
        resolved = _ORG_PRONOUNS.sub(org_name, resolved)
        logger.info("Resolved org pronouns to '%s'", org_name)

    # Handle they/them — resolve to person_name first, then org_name
    they_them = re.compile(r"\b(they|them)\b", re.IGNORECASE)
    if they_them.search(resolved):
        substitute = person_name or org_name
        if substitute:
            resolved = they_them.sub(substitute, resolved)
            logger.info("Resolved they/them to '%s'", substitute)

    if resolved != query:
        logger.info("Resolved query: '%s' -> '%s'", query, resolved)
    else:
        logger.debug("Pronouns detected but no matching entity found in history")

    return resolved
