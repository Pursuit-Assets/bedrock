"""Name-match validation for fetched research records.

FEC, USA Spending, OpenCorporates, etc. searches return rows keyed by
a name field. Without validation the pipeline ingests anyone-named-
similarly into the prospect's claim pool — a fidelity disaster for an
enterprise research tool.

Two validators:

  * ``validate_person_name(prospect_name, candidate)`` — require both
    first AND last token of the prospect's name to appear in the
    candidate. Handles "Last, First" comma format, titles (Dr., Jr.,
    III), middle initials, case + punctuation.

  * ``validate_org_name(prospect_org, candidate)`` — token-set check
    after stripping common corporate suffixes (Inc, LLC, Foundation,
    etc.). A single-token org (``Anthropic``) matches its suffixed
    variant (``Anthropic, PBC``).

Both return False for empty inputs.
"""

from __future__ import annotations

import re

_PUNCT_RE = re.compile(r"[^\w\s]")
_WHITESPACE_RE = re.compile(r"\s+")

# Titles + suffixes stripped from person names before matching.
_PERSON_NOISE = {
    "dr", "mr", "mrs", "ms", "prof", "professor", "rev",
    "jr", "sr", "ii", "iii", "iv", "v", "phd", "md", "esq",
}

# Common org suffixes — strip before token-set comparison.
_ORG_SUFFIXES = {
    "inc", "incorporated", "corp", "corporation", "co", "company",
    "ltd", "limited", "llc", "lp", "llp",
    "foundation", "trust", "fund", "charity",
    "association", "society", "institute", "center", "centre",
    "group", "holdings", "holding", "ventures", "partners",
    "pbc", "plc",
    # Articles / common stop words at edges
    "the", "of", "and", "for",
}


def _normalize_tokens(text: str, *, drop: set[str]) -> list[str]:
    """Lowercase, strip punctuation, split on whitespace, drop noise."""
    if not text:
        return []
    t = text.lower()
    t = _PUNCT_RE.sub(" ", t)
    t = _WHITESPACE_RE.sub(" ", t).strip()
    tokens = [tok for tok in t.split(" ") if tok and tok not in drop]
    return tokens


def validate_person_name(prospect_name: str, candidate: str) -> bool:
    """True if both the first and last token of ``prospect_name``
    appear in ``candidate`` (in any order, case-insensitive)."""
    if not prospect_name or not candidate:
        return False
    p_tokens = _normalize_tokens(prospect_name, drop=_PERSON_NOISE)
    c_tokens = set(_normalize_tokens(candidate, drop=_PERSON_NOISE))
    if not p_tokens or not c_tokens:
        return False
    # Require first + last of prospect to both appear.
    if len(p_tokens) == 1:
        return p_tokens[0] in c_tokens
    first, last = p_tokens[0], p_tokens[-1]
    return first in c_tokens and last in c_tokens


def validate_org_name(prospect_org: str, candidate: str) -> bool:
    """True if every meaningful token of the shorter (suffix-stripped)
    org name appears in the longer's token set."""
    if not prospect_org or not candidate:
        return False
    p_tokens = set(_normalize_tokens(prospect_org, drop=_ORG_SUFFIXES))
    c_tokens = set(_normalize_tokens(candidate, drop=_ORG_SUFFIXES))
    if not p_tokens or not c_tokens:
        return False
    shorter, longer = (
        (p_tokens, c_tokens) if len(p_tokens) <= len(c_tokens)
        else (c_tokens, p_tokens)
    )
    return shorter.issubset(longer)
